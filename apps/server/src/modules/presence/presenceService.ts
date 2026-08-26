import { EventEmitter } from "node:events";
import type { StoredPresence, VisiblePresence } from "./presenceTypes.js";

const TTL_MS = 90_000;

const entries = new Map<string, StoredPresence>();
export const presenceBus = new EventEmitter();

const keyOf = (workspaceId: string, connectionId: string) => `${workspaceId}\0${connectionId}`;

export function heartbeatPresence(value: Omit<StoredPresence, "expiresAt" | "lastSeenAt"> & { lastSeenAt?: number }): void {
  const key = keyOf(value.workspaceId, value.connectionId);
  const previous = entries.get(key);
  const now = Date.now();
  entries.set(key, { ...value, lastSeenAt: value.lastSeenAt ?? now, expiresAt: now + TTL_MS });
  if (!previous || previous.scope !== value.scope || previous.peonId !== value.peonId || previous.sessionId !== value.sessionId || previous.active !== value.active) {
    presenceBus.emit("changed", value.workspaceId);
  }
}

export function touchPresence(workspaceId: string, userId: string, connectionId: string): void {
  const entry = entries.get(keyOf(workspaceId, connectionId));
  if (entry?.userId === userId) {
    entry.lastSeenAt = Date.now();
    entry.expiresAt = Date.now() + TTL_MS;
  }
}

export function removePresence(workspaceId: string, userId: string, connectionId: string): void {
  const key = keyOf(workspaceId, connectionId);
  const existing = entries.get(key);
  if (!existing || existing.userId !== userId) return;
  entries.delete(key);
  presenceBus.emit("changed", workspaceId);
}

// Authoritative answer to "is this user in front of this session right now?".
// Used to keep a finished run from raising an unread mark the operator would have
// to clear by hand on the very session they are watching.
export function isUserViewingSession(workspaceId: string, userId: string, peonId: string, sessionId: string): boolean {
  return listHeartbeatPresence(workspaceId).some((entry) =>
    entry.userId === userId
    && entry.scope === "session"
    && entry.peonId === peonId
    && entry.sessionId === sessionId
    && entry.active !== false);
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
