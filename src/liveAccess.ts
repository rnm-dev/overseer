import { listMemberAccess } from "./access.js";
import type { LiveEvent } from "./eventLog.js";
import { membership, type Role } from "./workspaces.js";

export interface AccessClient {
  userId: string;
  workspaceId: string | null;
  role: Role | null;
  allowedPeons: Set<string> | null;
  allowedProjects: Map<string, Set<string>> | null;
  tails: Map<string, AbortController>;
}

export async function refreshClientAccess(client: AccessClient): Promise<void> {
  if (!client.workspaceId) return;
  const before = accessFingerprint(client);
  const role = await membership(client.workspaceId, client.userId);
  client.role = role;
  if (role === "owner") {
    client.allowedPeons = null;
    client.allowedProjects = null;
    abortTailsIfAccessChanged(client, before);
    return;
  }
  if (!role) {
    client.allowedPeons = new Set();
    client.allowedProjects = new Map();
    abortTailsIfAccessChanged(client, before);
    return;
  }
  const access = await listMemberAccess(client.workspaceId, client.userId);
  client.allowedPeons = new Set(access.peonIds);
  const projects = new Map<string, Set<string>>();
  for (const item of access.projects) {
    const keys = projects.get(item.peonId) ?? new Set<string>();
    if (item.projectId) keys.add(`id:${item.projectId}`);
    else keys.add(`key:${item.projectKey}`);
    projects.set(item.peonId, keys);
  }
  client.allowedProjects = projects;
  abortTailsIfAccessChanged(client, before);
}

export function accessFingerprint(client: AccessClient): string {
  if (!client.role) return "none";
  if (client.role === "owner") return "owner";
  const peons = [...(client.allowedPeons ?? [])].sort().join(",");
  const projects = [...(client.allowedProjects ?? new Map())]
    .flatMap(([peonId, keys]) => [...keys].map((key) => `${peonId}\0${key}`))
    .sort()
    .join(",");
  return `member:${peons}:${projects}`;
}

export function abortTailsIfAccessChanged(client: AccessClient, before: string): void {
  if (before === "none" || before === accessFingerprint(client)) return;
  for (const controller of client.tails.values()) controller.abort();
  client.tails.clear();
}

export function peonVisible(client: AccessClient, peonId: string): boolean {
  return client.role === "owner" || !!client.allowedPeons?.has(peonId);
}

export function projectVisible(client: AccessClient, peonId: string, projectKey: string, projectId?: string | null): boolean {
  if (client.role === "owner") return true;
  const allowed = client.allowedProjects?.get(peonId);
  return !!allowed && (projectId ? allowed.has(`id:${projectId}`) : allowed.has(`key:${projectKey}`));
}

export function sessionVisible(client: AccessClient, peonId: string, projectKey: string | null | undefined, projectId?: string | null): boolean {
  return peonVisible(client, peonId) && (!projectKey || projectVisible(client, peonId, projectKey, projectId));
}

export function eventVisible(client: AccessClient, event: LiveEvent): boolean {
  if (!peonVisible(client, event.peonId)) return false;
  if (event.kind === "peon" || client.role === "owner") return true;
  const projectKey = event.payload && typeof event.payload === "object" && typeof (event.payload as { projectKey?: unknown }).projectKey === "string"
    ? (event.payload as { projectKey: string }).projectKey
    : null;
  const projectId = event.payload && typeof event.payload === "object" && typeof (event.payload as { projectId?: unknown }).projectId === "string"
    ? (event.payload as { projectId: string }).projectId
    : null;
  return !projectKey || projectVisible(client, event.peonId, projectKey, projectId);
}
