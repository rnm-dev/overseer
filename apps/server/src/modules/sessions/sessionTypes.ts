export interface PeonSession {
  id: string;
  agent?: string | null;
  backendSessionId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  status?: string | null;
  projectKey?: string | null;
  projectId?: string | null;
  title?: string | null;
  promptPreview?: string | null;
  lastMessagePreview?: string | null;
  prompt?: string | null;
  initiator?: string | null;
  outcome?: unknown;
  startedAt?: number | null;
  endedAt?: number | null;
  lastActivityAt?: number | null;
}

export interface SessionSummary {
  id: string;
  status: string | null;
  projectKey: string | null;
  projectId: string | null;
  title: string | null;
  promptPreview: string | null;
  lastMessagePreview: string | null;
  initiator: string | null;
  outcome: unknown;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
}

export interface SessionIndexRow {
  peonId: string;
  sessionId: string;
  status: string | null;
  projectKey: string | null;
  projectId: string | null;
  title: string | null;
  promptPreview: string | null;
  preview: string | null;
  author: string | null;
  outcome: unknown;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
  syncedAt: number;
}

export interface ProjectSessionCount {
  projectId: string | null;
  projectKey: string;
  sessionCount: number;
}

export interface SessionLiveProjection extends SessionIndexRow {
  projectSessionCounts: ProjectSessionCount[];
}

export interface SessionSyncCheckpoint {
  catalog: { epoch: string; acknowledgedSeq: number } | null;
  delivery: { epoch: string; acknowledgedCursor: string | null } | null;
  previouslyReady: boolean;
}

export interface ListOptions {
  workspaceId?: string;
  peonId?: string;
  status?: string;
  authors?: string[];
  access?: { userId: string };
  perPeonLimit?: number;
  limit: number;
  offset: number;
}

// One row of the operator-scoped recent-session projection attached to a Peon in
// the Fleet response. Session facts come from the index; the request-state
// fields are this operator's alone.
export interface OperatorRecentSession {
  peonId: string;
  sessionId: string;
  status: string | null;
  title: string | null;
  promptPreview: string | null;
  preview: string | null;
  projectId: string | null;
  projectKey: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  // The index's own version of this row, so a client merging the projection with
  // a cached or live session record can tell which one is newer.
  syncedAt: number;
  lastRequestedAt: number | null;
  hasOutstandingRequest: boolean;
  attentionUnread: boolean;
  attentionUpdatedAt: number;
}

export interface SessionCatalogState {
  peonId: string;
  online: boolean;
  state: "legacy" | "fallback" | "syncing" | "ready" | "stale" | "offline";
  stale: boolean;
  updatedAt: number | null;
  catalogRevision: number | null;
  deliveryCommitted: boolean;
}
