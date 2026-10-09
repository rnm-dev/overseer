import type { WebSocket } from "ws";
import { membership } from "../modules/workspaces/index.js";
import { registry } from "../modules/fleet/index.js";
import { canAccessPeon } from "../modules/access/index.js";
import { connOfRecord, streamPeonTo } from "../infrastructure/peonHttp/index.js";

export interface ResourceUsageClient { ws: WebSocket; userId: string; actor: string; workspaceId: string | null; participant: unknown; closed: boolean }
interface Request { subscriptionId: string; peonId: string }
interface Grant { identity: string; stream: (chunk: (value: string) => void, signal: AbortSignal) => Promise<void> }
interface Subscription { client: ResourceUsageClient; request: Request; workspaceId: string; group?: Group }
interface Group { identity: string; abort: AbortController; subscribers: Set<Subscription>; buffer: string; watchdog?: ReturnType<typeof setTimeout> }
class Refusal extends Error { constructor(public code: string) { super(code); } }

async function authorize(client: ResourceUsageClient, request: Request): Promise<Grant> {
  const workspaceId = client.workspaceId;
  if (!workspaceId || client.participant || client.closed) throw new Refusal("FORBIDDEN");
  const [role, record] = await Promise.all([membership(workspaceId, client.userId), registry.get(request.peonId)]);
  if (!role || !record || record.workspaceId !== workspaceId || !(await canAccessPeon(workspaceId, client.userId, role, request.peonId))) throw new Refusal("FORBIDDEN");
  if (!record.capabilities.includes("resource-usage-v1")) throw new Refusal("UNSUPPORTED");
  return { identity: JSON.stringify([workspaceId, request.peonId]),
    stream: (chunk, signal) => streamPeonTo(connOfRecord(record), "/resources/stream?intervalMs=1000", chunk, signal, client.actor) };
}

export class ResourceUsageHub {
  private clients = new Map<ResourceUsageClient, Map<string, Subscription>>();
  private groups = new Map<string, Group>();
  constructor(private send: (ws: WebSocket, message: unknown) => unknown, private grant: typeof authorize = authorize) {}
  async subscribe(client: ResourceUsageClient, input: Record<string, unknown>): Promise<void> {
    const { subscriptionId, peonId } = input;
    if (typeof subscriptionId !== "string" || !/^[\w-]{1,80}$/.test(subscriptionId) || typeof peonId !== "string" || !peonId || peonId.length > 128) return;
    this.unsubscribe(client, subscriptionId);
    const error = (code: string, retryable = false) => this.send(client.ws, { type: "resources:error", subscriptionId, code, retryable });
    if (!client.workspaceId || client.closed || client.participant) { error("FORBIDDEN"); return; }
    const subscriptions = this.clients.get(client) ?? new Map<string, Subscription>();
    if (subscriptions.size >= 8) { error("LIMIT"); return; }
    this.clients.set(client, subscriptions);
    const sub: Subscription = { client, request: { subscriptionId, peonId }, workspaceId: client.workspaceId };
    subscriptions.set(subscriptionId, sub);
    try {
      const grant = await this.grant(client, sub.request);
      if (!this.active(sub)) return;
      let group = this.groups.get(grant.identity);
      const created = !group;
      if (!group) {
        if (this.groups.size >= 256) throw new Refusal("LIMIT");
        group = { identity: grant.identity, abort: new AbortController(), subscribers: new Set(), buffer: "" };
        this.groups.set(grant.identity, group);
      }
      sub.group = group; group.subscribers.add(sub);
      if (created) this.open(group, grant);
    } catch (cause) { if (this.active(sub)) error(cause instanceof Refusal ? cause.code : "UNAVAILABLE", !(cause instanceof Refusal)); this.unsubscribe(client, subscriptionId); }
  }
  unsubscribe(client: ResourceUsageClient, id: string): void {
    const subscriptions = this.clients.get(client); const sub = subscriptions?.get(id); subscriptions?.delete(id);
    if (!subscriptions?.size) this.clients.delete(client);
    const group = sub?.group; if (!group) return; group.subscribers.delete(sub);
    if (!group.subscribers.size) { this.groups.delete(group.identity); clearTimeout(group.watchdog); group.abort.abort(); }
  }
  closeClient(client: ResourceUsageClient): void { for (const id of [...(this.clients.get(client)?.keys() ?? [])]) this.unsubscribe(client, id); }
  dispose(): void { for (const client of [...this.clients.keys()]) this.closeClient(client); }
  private active(sub: Subscription): boolean { return !sub.client.closed && sub.client.workspaceId === sub.workspaceId && this.clients.get(sub.client)?.get(sub.request.subscriptionId) === sub; }
  private fail(group: Group): void { for (const sub of [...group.subscribers]) { if (this.active(sub)) this.send(sub.client.ws, { type: "resources:error", subscriptionId: sub.request.subscriptionId, code: "UNAVAILABLE", retryable: true }); this.unsubscribe(sub.client, sub.request.subscriptionId); } }
  private open(group: Group, grant: Grant): void {
    const heartbeat = () => { clearTimeout(group.watchdog); group.watchdog = setTimeout(() => this.fail(group), 30_000); group.watchdog.unref(); };
    heartbeat();
    void grant.stream((chunk) => {
      if (group.abort.signal.aborted) return; heartbeat(); group.buffer += chunk;
      if (group.buffer.length > 64 * 1024) return this.fail(group);
      let match;
      while ((match = /\r?\n\r?\n/.exec(group.buffer))) {
        const frame = group.buffer.slice(0, match.index); group.buffer = group.buffer.slice(match.index + match[0].length);
        if (frame.startsWith(":")) continue;
        if (!/^event: ?sample\r?$/m.test(frame)) return this.fail(group);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        let sample: unknown; try { sample = JSON.parse(data); } catch { return this.fail(group); }
        for (const sub of [...group.subscribers]) void this.deliver(sub, group, sample);
      }
    }, group.abort.signal).catch(() => {}).finally(() => { if (!group.abort.signal.aborted) this.fail(group); });
  }
  private async deliver(sub: Subscription, group: Group, sample: unknown): Promise<void> {
    try { const grant = await this.grant(sub.client, sub.request); if (grant.identity !== group.identity) throw new Refusal("FORBIDDEN"); if (this.active(sub)) this.send(sub.client.ws, { type: "resources:sample", subscriptionId: sub.request.subscriptionId, sample }); }
    catch { if (this.active(sub)) { this.send(sub.client.ws, { type: "resources:error", subscriptionId: sub.request.subscriptionId, code: "FORBIDDEN", retryable: false }); this.unsubscribe(sub.client, sub.request.subscriptionId); } }
  }
}
