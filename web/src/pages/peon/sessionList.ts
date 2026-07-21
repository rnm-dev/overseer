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
}

export interface IndexedSessionEvent extends IndexedSessionLite {
  deleted?: boolean;
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
  };
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
    merged.set(key, { ...previous, ...session });
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
