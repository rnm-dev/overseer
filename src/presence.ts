import { EventEmitter } from "node:events";

export interface PresenceIdentity {
  userId: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
}

export interface StoredPresence extends PresenceIdentity {
  connectionId: string;
  workspaceId: string;
  scope: "workspace" | "peon" | "session";
  peonId: string | null;
  sessionId: string | null;
  projectKey: string | null;
  projectId: string | null;
  expiresAt: number;
}

export type VisiblePresence = Omit<StoredPresence, "connectionId" | "workspaceId" | "projectKey" | "projectId" | "expiresAt">;

// Mobile browsers aggressively suspend background-tab timers and sockets. A
// 90-second lease tolerates that suspension without turning presence into a
// long-lived "recently seen" signal. Foreground clients renew every 10 seconds.
const TTL_MS = 90_000;
const entries = new Map<string, StoredPresence>();
export const presenceBus = new EventEmitter();

const keyOf = (workspaceId: string, connectionId: string) => `${workspaceId}\0${connectionId}`;

export function heartbeatPresence(value: Omit<StoredPresence, "expiresAt">): void {
  const key = keyOf(value.workspaceId, value.connectionId);
  const previous = entries.get(key);
  entries.set(key, { ...value, expiresAt: Date.now() + TTL_MS });
  if (!previous || previous.scope !== value.scope || previous.peonId !== value.peonId || previous.sessionId !== value.sessionId) {
    presenceBus.emit("changed", value.workspaceId);
  }
}

export function touchPresence(workspaceId: string, userId: string, connectionId: string): void {
  const entry = entries.get(keyOf(workspaceId, connectionId));
  if (entry?.userId === userId) entry.expiresAt = Date.now() + TTL_MS;
}

export function removePresence(workspaceId: string, userId: string, connectionId: string): void {
  const key = keyOf(workspaceId, connectionId);
  const existing = entries.get(key);
  if (!existing || existing.userId !== userId) return;
  entries.delete(key);
  presenceBus.emit("changed", workspaceId);
}

export function listHeartbeatPresence(workspaceId: string): StoredPresence[] {
  const now = Date.now();
  let pruned = false;
  for (const [key, entry] of entries) {
    if (entry.expiresAt > now) continue;
    entries.delete(key);
    if (entry.workspaceId === workspaceId) pruned = true;
  }
  if (pruned) queueMicrotask(() => presenceBus.emit("changed", workspaceId));
  return [...entries.values()].filter((entry) => entry.workspaceId === workspaceId);
}

export async function listVisiblePresence(
  workspaceId: string,
  canSeePeon: (peonId: string) => boolean | Promise<boolean>,
  canSeeProject: (peonId: string, projectKey: string, projectId: string | null) => boolean | Promise<boolean>,
): Promise<VisiblePresence[]> {
  const result = new Map<string, VisiblePresence>();
  const peonAccess = new Map<string, Promise<boolean>>();
  const projectAccess = new Map<string, Promise<boolean>>();
  const seePeon = (peonId: string) => {
    let allowed = peonAccess.get(peonId);
    if (!allowed) {
      allowed = Promise.resolve(canSeePeon(peonId));
      peonAccess.set(peonId, allowed);
    }
    return allowed;
  };
  const seeProject = (peonId: string, projectKey: string, projectId: string | null) => {
    const key = `${peonId}\0${projectId || `key:${projectKey}`}`;
    let allowed = projectAccess.get(key);
    if (!allowed) {
      allowed = Promise.resolve(canSeeProject(peonId, projectKey, projectId));
      projectAccess.set(key, allowed);
    }
    return allowed;
  };

  for (const entry of listHeartbeatPresence(workspaceId)) {
    if (entry.peonId && !(await seePeon(entry.peonId))) continue;
    if (entry.scope === "session" && entry.peonId && entry.projectKey && !(await seeProject(entry.peonId, entry.projectKey, entry.projectId))) continue;
    const key = `${entry.userId}\0${entry.scope}\0${entry.peonId ?? ""}\0${entry.sessionId ?? ""}`;
    if (!result.has(key)) result.set(key, {
      userId: entry.userId,
      email: entry.email,
      githubLogin: entry.githubLogin,
      avatarUrl: entry.avatarUrl,
      scope: entry.scope,
      peonId: entry.peonId,
      sessionId: entry.sessionId,
    });
  }
  return [...result.values()].sort((a, b) => (a.githubLogin || a.email).localeCompare(b.githubLogin || b.email));
}
