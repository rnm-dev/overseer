export interface SessionLite {
  peonId?: string;
  id: string;
  status?: string | null;
  title?: string | null;
  promptPreview?: string | null;
  lastMessagePreview?: string | null;
  projectKey?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  lastActivityAt?: number | null;
  syncedAt?: number | null;
  catalogState?: "legacy" | "fallback" | "syncing" | "ready" | "stale" | "offline";
  catalogStale?: boolean;
  catalogUpdatedAt?: number | null;
  attentionUnread?: boolean;
  attentionUpdatedAt?: number;
  // Browser-local fence for a newly submitted turn. It prevents a delayed
  // terminal summary from the preceding turn from flashing this row idle.
  localRunningSince?: number;
}

export interface IndexedSessionLite {
  peonId?: string;
  sessionId: string;
  status?: string | null;
  title?: string | null;
  promptPreview?: string | null;
  preview?: string | null;
  projectKey?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  lastActivityAt?: number | null;
  syncedAt?: number | null;
  catalogState?: SessionLite["catalogState"];
  catalogStale?: boolean;
  catalogUpdatedAt?: number | null;
  attentionUnread?: boolean;
  attentionUpdatedAt?: number;
}

export interface IndexedSessionEvent extends IndexedSessionLite {
  deleted?: boolean;
}

// The sidebar reads Overseer's local projection, so Peon transport liveness is
// intentionally not part of this gate.
export function sessionSidebarCanLoad(workspaceId: string | undefined): boolean {
  return Boolean(workspaceId);
}

export function sessionFromIndex(session: IndexedSessionLite): SessionLite {
  return {
    peonId: session.peonId,
    id: session.sessionId,
    status: session.status,
    title: session.title,
    promptPreview: session.promptPreview ?? session.preview,
    lastMessagePreview: session.preview,
    projectKey: session.projectKey,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    lastActivityAt: session.lastActivityAt,
    syncedAt: session.syncedAt,
    catalogState: session.catalogState,
    catalogStale: session.catalogStale,
    catalogUpdatedAt: session.catalogUpdatedAt,
    ...(typeof session.attentionUnread === "boolean" ? { attentionUnread: session.attentionUnread } : {}),
    ...(typeof session.attentionUpdatedAt === "number" ? { attentionUpdatedAt: session.attentionUpdatedAt } : {}),
  };
}

export function applyAttentionEvent(
  current: SessionLite[],
  event: { peonId: string; sessionId: string; unread: boolean; updatedAt?: number },
): SessionLite[] {
  const key = sessionIdentity({ peonId: event.peonId, id: event.sessionId });
  return current.map((session) => sessionIdentity(session) === key && (event.updatedAt ?? 0) >= (session.attentionUpdatedAt ?? 0)
    ? { ...session, attentionUnread: event.unread, attentionUpdatedAt: event.updatedAt ?? 0 }
    : session);
}

// A command accepted from this browser is newer than the sidebar's last
// materialized summary. Reflect that transition immediately; the next durable
// Peon summary remains authoritative and replaces these provisional fields.
export function applyLocalSessionRunningChange(
  current: SessionLite[],
  peonId: string,
  sessionId: string,
  running: boolean,
  changedAt: number,
): SessionLite[] {
  const key = sessionIdentity({ peonId, id: sessionId });
  let changed = false;
  const next = current.map((session) => {
    if (sessionIdentity(session) !== key) return session;
    if (running && session.localRunningSince != null) return session;
    if (!running && session.status !== "running" && session.localRunningSince == null) return session;
    changed = true;
    const lastActivityAt = Math.max(session.lastActivityAt ?? 0, changedAt);
    return running
      ? { ...session, status: "running", endedAt: null, lastActivityAt, localRunningSince: changedAt }
      : { ...session, status: "completed", endedAt: changedAt, lastActivityAt, localRunningSince: undefined };
  });
  return changed ? next : current;
}

export function sessionDisplayTitle(
  session: { title?: string | null; promptPreview?: string | null; prompt?: string | null },
  untitled: string,
): string {
  return session.title || session.promptPreview || session.prompt || untitled;
}

export function sessionIdentity(session: Pick<SessionLite, "peonId" | "id">): string {
  return session.peonId ? `${session.peonId}\0${session.id}` : session.id;
}

// Pages can overlap when a live session is inserted before the next offset is
// fetched. The index's strictly increasing syncedAt version prevents a slower
// HTTP response from rolling back a summary that already arrived over the socket.
export function mergeSessions(current: SessionLite[], incoming: SessionLite[]): SessionLite[] {
  const merged = new Map(current.map((session) => [sessionIdentity(session), session]));
  for (const session of incoming) {
    const key = sessionIdentity(session);
    const previous = merged.get(key);
    if (previous && previous.syncedAt != null && session.syncedAt != null && previous.syncedAt > session.syncedAt) continue;
    const next = { ...previous, ...session };
    if (previous?.localRunningSince != null) {
      const incomingActivity = Math.max(session.lastActivityAt ?? 0, session.endedAt ?? 0, session.startedAt ?? 0);
      if (session.status !== "running" && incomingActivity <= previous.localRunningSince) {
        next.status = "running";
        next.endedAt = null;
        next.lastActivityAt = Math.max(previous.lastActivityAt ?? 0, previous.localRunningSince);
        next.localRunningSince = previous.localRunningSince;
      } else {
        delete next.localRunningSince;
      }
    }
    if ((previous?.attentionUpdatedAt ?? 0) > (session.attentionUpdatedAt ?? 0)) {
      next.attentionUnread = previous?.attentionUnread;
      next.attentionUpdatedAt = previous?.attentionUpdatedAt;
    }
    merged.set(key, next);
  }
  return [...merged.values()];
}

export function applySessionEvent(current: SessionLite[], event: IndexedSessionEvent): SessionLite[] {
  if (!event.deleted) return mergeSessions(current, [sessionFromIndex(event)]);
  return current.filter((session) => {
    if (sessionIdentity(session) !== sessionIdentity({ peonId: event.peonId, id: event.sessionId })) return true;
    return session.syncedAt != null && event.syncedAt != null && session.syncedAt > event.syncedAt;
  });
}
