import type { WebSocket } from "ws";
import { membership } from "../modules/workspaces/index.js";
import { registry } from "../modules/fleet/index.js";
import { canAccessPeon, canAccessProject } from "../modules/access/index.js";
import { getIndexedProject } from "../modules/projects/index.js";
import { connOfRecord, streamPeonTo } from "../infrastructure/peonHttp/index.js";

export interface FileWatchClient {
  ws: WebSocket;
  userId: string;
  actor: string;
  workspaceId: string | null;
  participant: unknown;
  closed: boolean;
}
export interface FileWatchRequest { watchId: string; peonId: string; projectKey: string; path: string }
interface Grant {
  identity: string;
  stream: (chunk: (value: string) => void, signal: AbortSignal) => Promise<void>;
}
export class FileWatchRefusal extends Error {
  constructor(public code: string, public retryable = false) { super(code); }
}

async function authorize(client: FileWatchClient, request: FileWatchRequest): Promise<Grant> {
  const workspaceId = client.workspaceId;
  if (!workspaceId || client.participant || client.closed) throw new FileWatchRefusal("FORBIDDEN");
  const [role, record, project] = await Promise.all([
    membership(workspaceId, client.userId), registry.get(request.peonId), getIndexedProject(request.peonId, request.projectKey),
  ]);
  if (!role || !record || record.workspaceId !== workspaceId || !project
    || !(await canAccessPeon(workspaceId, client.userId, role, request.peonId))
    || !(await canAccessProject(workspaceId, client.userId, role, request.peonId, request.projectKey, project.projectId))) {
    throw new FileWatchRefusal("FORBIDDEN");
  }
  if (!record.capabilities.includes("project-directory-watch-v1")) throw new FileWatchRefusal("UNSUPPORTED");
  const pathname = `/projects/${encodeURIComponent(request.projectKey)}/files-watch?path=${encodeURIComponent(request.path)}&projectId=${encodeURIComponent(project.projectId)}`;
  return {
    identity: JSON.stringify([workspaceId, request.peonId, project.projectId, project.dir, request.path]),
    stream: (chunk, signal) => streamPeonTo(connOfRecord(record), pathname, chunk, signal, client.actor),
  };
}
interface Subscription {
  client: FileWatchClient;
  request: FileWatchRequest;
  workspaceId: string;
  group?: Group;
  ready: boolean;
}
interface Group {
  identity: string;
  abort: AbortController;
  subscribers: Set<Subscription>;
  ready: boolean;
  dirty: boolean;
  draining: boolean;
  check: boolean;
  watchdog?: ReturnType<typeof setTimeout>;
}

// One upstream per project identity/directory, shared across browser sockets.
// Events are invalidations, so a single dirty bit bounds work during slow ACL
// queries. File bytes and listings continue through the existing HTTP routes.
export class ProjectFileWatchHub {
  private clients = new Map<FileWatchClient, Map<string, Subscription>>();
  private groups = new Map<string, Group>();
  constructor(
    private send: (ws: WebSocket, message: unknown) => unknown,
    private grant: typeof authorize = authorize,
  ) {}

  async subscribe(client: FileWatchClient, input: Record<string, unknown>): Promise<void> {
    const { watchId, peonId, projectKey, path } = input;
    if (typeof watchId !== "string" || !/^[\w-]{1,80}$/.test(watchId)) return;
    this.unsubscribe(client, watchId);
    const error = (code: string, retryable = false) => this.send(client.ws, { type: "files:error", watchId, code, retryable });
    if (![peonId, projectKey, path].every((v) => typeof v === "string")
      || !(peonId as string).length || (peonId as string).length > 128
      || !(projectKey as string).length || (projectKey as string).length > 256
      || /^[a-z]:/i.test(path as string)
      || (path as string).length > 4096 || (path as string).includes("\\")
      || [...path as string].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || (path !== "" && (path as string).split("/").some((part) => !part || part === "." || part === ".."))) {
      error("INVALID_PATH"); return;
    }
    if (!client.workspaceId || client.closed || client.participant) { error("FORBIDDEN"); return; }
    const subscriptions = this.clients.get(client) ?? new Map<string, Subscription>();
    if (subscriptions.size >= 128) { error("LIMIT"); return; }
    this.clients.set(client, subscriptions);
    const subscription: Subscription = {
      client, request: { watchId, peonId, projectKey, path } as FileWatchRequest,
      workspaceId: client.workspaceId, ready: false,
    };
    subscriptions.set(watchId, subscription);
    try {
      const grant = await this.grant(client, subscription.request);
      if (!this.active(subscription)) return;
      let group = this.groups.get(grant.identity);
      const created = !group;
      if (!group) {
        if (this.groups.size >= 1024) throw new FileWatchRefusal("LIMIT");
        group = { identity: grant.identity, abort: new AbortController(), subscribers: new Set(), ready: false, dirty: false, draining: false, check: false };
        this.groups.set(grant.identity, group);
      }
      subscription.group = group;
      group.subscribers.add(subscription);
      if (created) this.open(group, grant);
      else if (group.ready) this.invalidate(group, false);
    } catch (cause) {
      if (!this.active(subscription)) return;
      error(cause instanceof FileWatchRefusal ? cause.code : "UNAVAILABLE", !(cause instanceof FileWatchRefusal) || cause.retryable);
      this.unsubscribe(client, watchId);
    }
  }

  unsubscribe(client: FileWatchClient, watchId: string): void {
    const subscriptions = this.clients.get(client);
    const subscription = subscriptions?.get(watchId);
    subscriptions?.delete(watchId);
    if (!subscriptions?.size) this.clients.delete(client);
    const group = subscription?.group;
    if (!group) return;
    group.subscribers.delete(subscription);
    if (!group.subscribers.size) {
      this.groups.delete(group.identity);
      clearTimeout(group.watchdog);
      group.abort.abort();
    }
  }
  closeClient(client: FileWatchClient): void {
    for (const id of [...(this.clients.get(client)?.keys() ?? [])]) this.unsubscribe(client, id);
  }
  dispose(): void { for (const client of [...this.clients.keys()]) this.closeClient(client); }
  private active(sub: Subscription): boolean {
    return !sub.client.closed && sub.client.workspaceId === sub.workspaceId
      && this.clients.get(sub.client)?.get(sub.request.watchId) === sub;
  }
  private fail(group: Group, code = "UNAVAILABLE"): void {
    for (const sub of [...group.subscribers]) {
      if (this.active(sub)) this.send(sub.client.ws, { type: "files:error", watchId: sub.request.watchId, code, retryable: true });
      this.unsubscribe(sub.client, sub.request.watchId);
    }
  }
  private open(group: Group, grant: Grant): void {
    let buffer = "";
    const heartbeat = () => {
      clearTimeout(group.watchdog);
      group.watchdog = setTimeout(() => this.fail(group), 45_000);
      group.watchdog.unref();
    };
    heartbeat();
    void grant.stream((chunk) => {
      if (group.abort.signal.aborted) return;
      heartbeat();
      buffer += chunk;
      // Frames only carry invalidations; a large upstream payload is invalid.
      if (buffer.length > 16_384) { this.fail(group); return; }
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = /^event: ?(\w+)\r?$/m.exec(frame)?.[1];
        if (event === "ready") { group.ready = true; this.invalidate(group, true); }
        else if (event === "changed" && group.ready) this.invalidate(group, true);
        else if (event === "failed") { this.fail(group); return; }
        else if (frame.startsWith(":")) this.invalidate(group, false);
        else { this.fail(group); return; }
      }
    }, group.abort.signal).catch(() => {}).finally(() => {
      if (!group.abort.signal.aborted) this.fail(group);
    });
  }
  private invalidate(group: Group, changed: boolean): void {
    group.dirty ||= changed;
    group.check = true;
    if (group.draining) return;
    group.draining = true;
    void (async () => {
      while (group.check && !group.abort.signal.aborted) {
        const dirty = group.dirty;
        group.dirty = false;
        group.check = false;
        for (const sub of [...group.subscribers]) {
          if (!this.active(sub)) {
            if (this.clients.get(sub.client)?.get(sub.request.watchId) === sub) this.unsubscribe(sub.client, sub.request.watchId);
            continue;
          }
          try {
            const grant = await this.grant(sub.client, sub.request);
            if (grant.identity !== group.identity) throw new FileWatchRefusal("PROJECT_CHANGED");
            if (!this.active(sub)) continue;
            if (group.ready && (dirty || !sub.ready)) {
              this.send(sub.client.ws, { type: sub.ready ? "files:changed" : "files:ready", watchId: sub.request.watchId });
              sub.ready = true;
            }
          } catch (cause) {
            if (this.active(sub)) {
              this.send(sub.client.ws, { type: "files:error", watchId: sub.request.watchId,
                code: cause instanceof FileWatchRefusal ? cause.code : "UNAVAILABLE",
                retryable: !(cause instanceof FileWatchRefusal) || cause.retryable });
              this.unsubscribe(sub.client, sub.request.watchId);
            }
          }
        }
      }
    })().finally(() => {
      group.draining = false;
      if (group.check && !group.abort.signal.aborted) this.invalidate(group, false);
    });
  }
}
