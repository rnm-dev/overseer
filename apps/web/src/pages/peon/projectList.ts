export interface ProjectLite {
  peonId?: string;
  projectId?: string | null;
  key: string;
  name?: string | null;
  path?: string | null;
  dir?: string | null;
  metadata?: string | null;
  sessionCount?: number;
  memberCount?: number;
  activeCount?: number;
  unreadCount?: number;
  lastActivityMs?: number | null;
  syncedAt?: number;
  deleted?: boolean;
  quickLinks?: Array<{ id: string; title: string; url: string; order: number }>;
}

export interface ProjectLiveEvent extends Partial<ProjectLite> {
  peonId: string;
  projectId: string;
  deleted?: boolean;
  syncedAt: number;
}

function identity(project: Pick<ProjectLite, "peonId" | "projectId" | "key">): string {
  return `${project.peonId ?? ""}\0${project.projectId ?? `key:${project.key}`}`;
}

export function mergeProjects(current: ProjectLite[], incoming: ProjectLite[]): ProjectLite[] {
  const merged = new Map(current.map((project) => [identity(project), project]));
  for (const project of incoming) {
    const key = identity(project);
    const previous = merged.get(key);
    if (previous?.syncedAt != null && project.syncedAt != null && previous.syncedAt > project.syncedAt) continue;
    merged.set(key, { ...previous, ...project, deleted: false });
  }
  return [...merged.values()];
}

export function applyProjectEvent(current: ProjectLite[], event: ProjectLiveEvent): ProjectLite[] {
  const index = current.findIndex((project) => project.peonId === event.peonId && project.projectId === event.projectId);
  if (index >= 0 && current[index]!.syncedAt != null && current[index]!.syncedAt! > event.syncedAt) return current;
  if (event.deleted) {
    const tombstone: ProjectLite = {
      ...(index >= 0 ? current[index] : {}),
      peonId: event.peonId,
      projectId: event.projectId,
      key: index >= 0 ? current[index]!.key : "",
      syncedAt: event.syncedAt,
      deleted: true,
    };
    return index < 0
      ? [...current, tombstone]
      : current.map((project, itemIndex) => itemIndex === index ? tombstone : project);
  }
  if (!event.key) return current;
  const next: ProjectLite = { ...(index >= 0 ? current[index] : {}), ...event, key: event.key, deleted: false };
  if (index < 0) return [...current, next];
  return current.map((project, itemIndex) => itemIndex === index ? next : project);
}

// A Peon still lists a project it no longer holds when sessions were recorded
// against it: the row keeps the dead projectId and arrives with nothing but a
// key, a path and its counts. Every surface addresses a project by key, so such
// a row is indistinguishable from the live project that replaced it — and it is
// the one that cannot be opened. Keep the registered row.
function registered(project: ProjectLite): boolean {
  return project.syncedAt != null || project.name != null || project.dir != null;
}

export function dedupeProjectsByKey(projects: ProjectLite[]): ProjectLite[] {
  const byKey = new Map<string, ProjectLite>();
  for (const project of projects) {
    const previous = byKey.get(project.key);
    if (previous && (registered(previous) || !registered(project))) continue;
    byKey.set(project.key, project);
  }
  return [...byKey.values()];
}

export function visibleProjects(projects: ProjectLite[]): ProjectLite[] {
  return dedupeProjectsByKey(projects.filter((project) => !project.deleted));
}

// Also stamps each project with the newest activity among its sessions, so the
// sidebar can tell that work moved inside a project even when none of its counts
// changed — that is what makes a project row flash on incoming session updates.
export function withLiveActiveSessionCounts(
  projects: ProjectLite[],
  sessions: Array<{ projectKey?: string | null; status?: string | null; lastActivityAt?: number | null; attentionUnread?: boolean }>,
): ProjectLite[] {
  const activeByProject = new Map<string, number>();
  const unreadByProject = new Map<string, number>();
  const activityByProject = new Map<string, number>();
  for (const session of sessions) {
    if (!session.projectKey) continue;
    if (session.status === "running") {
      activeByProject.set(session.projectKey, (activeByProject.get(session.projectKey) ?? 0) + 1);
    }
    if (session.attentionUnread) {
      unreadByProject.set(session.projectKey, (unreadByProject.get(session.projectKey) ?? 0) + 1);
    }
    const activity = session.lastActivityAt ?? 0;
    if (activity > (activityByProject.get(session.projectKey) ?? 0)) {
      activityByProject.set(session.projectKey, activity);
    }
  }
  return projects.map((project) => ({
    ...project,
    activeCount: activeByProject.get(project.key) ?? 0,
    unreadCount: unreadByProject.get(project.key) ?? 0,
    lastActivityMs: activityByProject.get(project.key) ?? project.lastActivityMs ?? null,
  }));
}

export function applyProjectSessionCounts(
  projects: ProjectLite[],
  counts: unknown,
): ProjectLite[] {
  if (!Array.isArray(counts)) return projects;
  const byIdentity = new Map<string, number>();
  for (const item of counts) {
    if (!item || typeof item !== "object") continue;
    const count = (item as { sessionCount?: unknown }).sessionCount;
    const projectId = (item as { projectId?: unknown }).projectId;
    const projectKey = (item as { projectKey?: unknown }).projectKey;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || typeof projectKey !== "string") continue;
    byIdentity.set(typeof projectId === "string" ? `id:${projectId}` : `key:${projectKey}`, count);
  }
  if (byIdentity.size === 0) return projects;
  let changed = false;
  const next = projects.map((project) => {
    const count = project.projectId
      ? byIdentity.get(`id:${project.projectId}`)
      : byIdentity.get(`key:${project.key}`);
    if (count === undefined || count === project.sessionCount) return project;
    changed = true;
    return { ...project, sessionCount: count };
  });
  return changed ? next : projects;
}
