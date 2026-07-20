import { config } from "./config.js";
import { query } from "./db.js";
import { registry, toView, type PeonRecord } from "./registry.js";
import { callPeon, connOfRecord } from "./peonClient.js";
import { appendEvent } from "./eventLog.js";

// The aggregated session index — a materialized view of every peon's sessions,
// so "all sessions across every peon" is one local Postgres query instead of a
// fan-out. It is a CACHE, never the source of truth: the peon owns its sessions,
// and this index is (re)built by pulling each peon's /sessions. That's what makes
// it robust — a wrong/stale row self-heals on the next reconcile, and a
// overseer restart rebuilds the whole thing.
//
// Today the index is refreshed by polling (reconcile). Step 2 adds peon event
// push to keep it live; upsertSession() is already the single write path both
// will share.

// Peon summaries are the index contract. Older Peons may still send full
// SessionRecords, so every input is projected immediately and detail-only state
// never enters the cache or its public list response.
interface PeonSession {
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

export function normalizeSessionSummary(s: PeonSession): SessionSummary {
  return {
    id: s.id,
    status: s.status ?? null,
    projectKey: s.projectKey ?? null,
    projectId: s.projectId ?? null,
    title: s.title ?? null,
    promptPreview: s.promptPreview ?? s.prompt?.slice(0, 200) ?? null,
    lastMessagePreview: s.lastMessagePreview ?? null,
    initiator: s.initiator ?? null,
    outcome: s.outcome ?? null,
    startedAt: s.startedAt ?? null,
    endedAt: s.endedAt ?? null,
    lastActivityAt: s.lastActivityAt ?? null,
  };
}

// Fingerprint of the last-written row per (peon, session), so a reconcile that
// re-pulls unchanged sessions doesn't emit a fresh event for each one — only real
// changes hit the event log / live stream.
const fingerprints = new Map<string, string>();
let lastSyncedAt = 0;

function nextSyncedAt(): number {
  // Date.now() can repeat for several updates in one millisecond. A strict local
  // order gives clients an unambiguous last-writer-wins version.
  lastSyncedAt = Math.max(Date.now(), lastSyncedAt + 1);
  return lastSyncedAt;
}

export async function upsertSession(workspaceId: string, peonId: string, s: PeonSession): Promise<void> {
  const summary = normalizeSessionSummary(s);
  const row: SessionIndexRow = {
    peonId,
    sessionId: summary.id,
    status: summary.status,
    projectKey: summary.projectKey,
    projectId: summary.projectId,
    title: summary.title,
    promptPreview: summary.promptPreview,
    preview: summary.lastMessagePreview ?? summary.promptPreview,
    author: summary.initiator,
    outcome: summary.outcome,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    lastActivityAt: summary.lastActivityAt,
    syncedAt: nextSyncedAt(),
  };
  const stored = await query<{ synced_at: number }>(
    `INSERT INTO sessions
       (peon_id, session_id, status, project_key, project_id, title, prompt_preview, preview, author, outcome, started_at, ended_at, last_activity_at, raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (peon_id, session_id) DO UPDATE SET
       status = EXCLUDED.status, project_key = EXCLUDED.project_key, project_id = EXCLUDED.project_id, title = EXCLUDED.title,
       prompt_preview = EXCLUDED.prompt_preview, preview = EXCLUDED.preview, author = EXCLUDED.author, outcome = EXCLUDED.outcome,
       started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at,
       last_activity_at = EXCLUDED.last_activity_at, raw = EXCLUDED.raw, synced_at = EXCLUDED.synced_at
     WHERE
       -- Reconcile and pushed events can race. Refuse a demonstrably older Peon
       -- snapshot so a late reconcile cannot roll a completed/live session back.
       GREATEST(COALESCE(EXCLUDED.last_activity_at, 0), COALESCE(EXCLUDED.ended_at, 0), COALESCE(EXCLUDED.started_at, 0)) = 0
       OR GREATEST(COALESCE(sessions.last_activity_at, 0), COALESCE(sessions.ended_at, 0), COALESCE(sessions.started_at, 0)) = 0
       OR GREATEST(COALESCE(EXCLUDED.last_activity_at, 0), COALESCE(EXCLUDED.ended_at, 0), COALESCE(EXCLUDED.started_at, 0))
          > GREATEST(COALESCE(sessions.last_activity_at, 0), COALESCE(sessions.ended_at, 0), COALESCE(sessions.started_at, 0))
       OR (
         GREATEST(COALESCE(EXCLUDED.last_activity_at, 0), COALESCE(EXCLUDED.ended_at, 0), COALESCE(EXCLUDED.started_at, 0))
           = GREATEST(COALESCE(sessions.last_activity_at, 0), COALESCE(sessions.ended_at, 0), COALESCE(sessions.started_at, 0))
         AND NOT (sessions.ended_at IS NOT NULL AND EXCLUDED.ended_at IS NULL)
       )
     RETURNING synced_at`,
    [
      peonId,
      row.sessionId,
      row.status,
      row.projectKey,
      row.projectId,
      row.title,
      row.promptPreview,
      row.preview,
      row.author,
      summary.outcome !== null ? JSON.stringify(summary.outcome) : null,
      row.startedAt,
      row.endedAt,
      row.lastActivityAt,
      JSON.stringify(summary),
      row.syncedAt,
    ],
  );
  // rowCount differs between PostgreSQL and pg-mem for a rejected conflict, but
  // both expose the winning RETURNING version. Only broadcast our accepted row.
  if (Number(stored.rows[0]?.synced_at) !== row.syncedAt) return;

  const key = `${peonId}:${row.sessionId}`;
  const fp = `${row.status}|${row.projectId}|${row.projectKey}|${row.lastActivityAt}|${row.endedAt}|${row.title}|${row.promptPreview}|${row.preview}`;
  if (fingerprints.get(key) !== fp) {
    await appendEvent({ workspaceId, peonId, sessionId: row.sessionId, kind: "session", payload: row });
    // Only suppress a future identical reconcile after the durable event exists.
    // If append fails, leaving the old fingerprint makes the next pass retry.
    fingerprints.set(key, fp);
  }
}

export async function deleteIndexedSession(
  workspaceId: string,
  peonId: string,
  sessionId: string,
  expectedSyncedAt?: number,
): Promise<boolean> {
  const syncedAt = nextSyncedAt();
  const params: unknown[] = [peonId, sessionId];
  const versionGuard = expectedSyncedAt === undefined ? "" : ` AND synced_at = $${params.push(expectedSyncedAt)}`;
  const deleted = await query<{ session_id: string }>(
    `DELETE FROM sessions WHERE peon_id = $1 AND session_id = $2${versionGuard} RETURNING session_id`,
    params,
  );
  if (!deleted.rows[0]) return false;

  fingerprints.delete(`${peonId}:${sessionId}`);
  await appendEvent({
    workspaceId,
    peonId,
    sessionId,
    kind: "session",
    payload: { peonId, sessionId, deleted: true, syncedAt },
  });
  return true;
}

// Pull one peon's full session list into the index. Returns the count synced, or
// null if the peon was unreachable / returned garbage (caller decides whether to
// care — a transient miss just leaves the last-known rows in place).
export async function reconcilePeon(record: PeonRecord): Promise<number | null> {
  // Remember exactly which rows existed before the remote snapshot. Deletions
  // are version-guarded below so a pushed update racing this pull cannot be
  // removed merely because it was absent from the older snapshot.
  const existing = await query<{ session_id: string; synced_at: number }>(
    `SELECT session_id, synced_at FROM sessions WHERE peon_id = $1`,
    [record.peonId],
  );
  const res = await callPeon(connOfRecord(record), "GET", "/sessions");
  if (!res.ok) return null;
  const sessions = (res.json as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions)) return null;
  const resolvedSessions = resolveSessionProjectIds(sessions as PeonSession[]);
  for (const s of resolvedSessions) {
    if (s && typeof s.id === "string") await upsertSession(record.workspaceId, record.peonId, s);
  }
  const remoteIds = new Set(resolvedSessions.flatMap((session) => typeof session?.id === "string" ? [session.id] : []));
  for (const row of existing.rows) {
    if (!remoteIds.has(row.session_id)) {
      await deleteIndexedSession(record.workspaceId, record.peonId, row.session_id, Number(row.synced_at));
    }
  }
  await backfillStoredSessionProjectIds(record.peonId, resolvedSessions);
  await backfillProjectAccess(record.workspaceId, record.peonId, resolvedSessions);
  return sessions.length;
}

export async function backfillStoredSessionProjectIds(
  peonId: string,
  sessions: { projectKey?: string | null; projectId?: string | null }[],
): Promise<void> {
  const folded = new Map<string, Set<string>>();
  for (const session of sessions) {
    if (!session.projectKey || !session.projectId) continue;
    const key = session.projectKey.toLocaleLowerCase("en-US");
    const ids = folded.get(key) ?? new Set<string>();
    ids.add(session.projectId);
    folded.set(key, ids);
  }
  for (const [key, ids] of folded) {
    if (ids.size !== 1) continue;
    await query(
      `UPDATE sessions SET project_id = $3 WHERE peon_id = $1 AND project_id IS NULL AND LOWER(project_key) = $2`,
      [peonId, key, [...ids][0]],
    );
  }
}

export function resolveSessionProjectIds<T extends { projectKey?: string | null; projectId?: string | null }>(sessions: T[]): T[] {
  const exact = new Map<string, Set<string>>();
  const folded = new Map<string, Set<string>>();
  for (const session of sessions) {
    if (!session.projectKey || !session.projectId) continue;
    for (const [map, key] of [[exact, session.projectKey], [folded, session.projectKey.toLocaleLowerCase("en-US")]] as const) {
      const ids = map.get(key) ?? new Set<string>();
      ids.add(session.projectId);
      map.set(key, ids);
    }
  }
  return sessions.map((session) => {
    if (session.projectId || !session.projectKey) return session;
    const exactIds = exact.get(session.projectKey);
    const foldedIds = folded.get(session.projectKey.toLocaleLowerCase("en-US"));
    const candidates = exactIds?.size === 1 ? exactIds : foldedIds?.size === 1 ? foldedIds : null;
    return candidates ? { ...session, projectId: [...candidates][0] } : session;
  });
}

async function backfillProjectAccess(workspaceId: string, peonId: string, sessions: PeonSession[]): Promise<void> {
  const byExact = new Map<string, Set<string>>();
  const byFolded = new Map<string, Set<string>>();
  for (const session of sessions) {
    if (!session?.projectId || !session.projectKey) continue;
    for (const [map, key] of [[byExact, session.projectKey], [byFolded, session.projectKey.toLocaleLowerCase("en-US")]] as const) {
      const ids = map.get(key) ?? new Set<string>();
      ids.add(session.projectId);
      map.set(key, ids);
    }
  }
  const { rows } = await query<{ project_key: string }>(
    `SELECT DISTINCT project_key FROM workspace_member_project_access WHERE workspace_id = $1 AND peon_id = $2 AND project_id IS NULL`,
    [workspaceId, peonId],
  );
  for (const row of rows) {
    const exact = byExact.get(row.project_key);
    const folded = byFolded.get(row.project_key.toLocaleLowerCase("en-US"));
    const candidates = exact?.size === 1 ? exact : folded?.size === 1 ? folded : null;
    const projectId = candidates ? [...candidates][0] : null;
    if (!projectId) continue;
    await query(
      `UPDATE workspace_member_project_access SET project_id = $4 WHERE workspace_id = $1 AND peon_id = $2 AND project_key = $3 AND project_id IS NULL`,
      [workspaceId, peonId, row.project_key, projectId],
    );
  }
}

// Refresh the whole index from every online peon (offline ones keep their
// last-known rows). Concurrent, failure-isolated.
export async function reconcileAll(): Promise<void> {
  const peons = await registry.list();
  await Promise.all(peons.map((p) => (toView(p).online ? reconcilePeon(p).catch(() => null) : Promise.resolve(null))));
}

export interface ListOptions {
  workspaceId?: string;
  peonId?: string;
  status?: string;
  authors?: string[];
  access?: { userId: string };
  limit: number;
  offset: number;
}

export async function getIndexedSession(peonId: string, sessionId: string): Promise<SessionIndexRow | null> {
  const { rows } = await query<SessionRow>(
    `SELECT * FROM sessions WHERE peon_id = $1 AND session_id = $2`,
    [peonId, sessionId],
  );
  return rows[0] ? rowToIndexRow(rows[0]) : null;
}

interface SessionRow {
  peon_id: string;
  session_id: string;
  status: string | null;
  project_key: string | null;
  project_id: string | null;
  title: string | null;
  prompt_preview: string | null;
  preview: string | null;
  author: string | null;
  outcome: unknown;
  started_at: number | null;
  ended_at: number | null;
  last_activity_at: number | null;
  synced_at: number;
  raw: unknown;
}

// Query the index — filter by peon and/or status, newest activity first,
// paginated. Returns the page plus the total matching count.
export async function listSessions(opts: ListOptions): Promise<{ sessions: SessionIndexRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  let fromSql = "FROM sessions";
  if (opts.workspaceId) {
    params.push(opts.workspaceId);
    where.push(`sessions.peon_id IN (SELECT peon_id FROM peons WHERE workspace_id = $${params.length})`);
  }
  if (opts.peonId) {
    params.push(opts.peonId);
    where.push(`sessions.peon_id = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`sessions.status = $${params.length}`);
  }
  const authors = [...new Set((opts.authors ?? []).map((author) => author.trim().toLocaleLowerCase("en-US")).filter(Boolean))];
  if (authors.length) {
    const placeholders = authors.map((author) => {
      params.push(author);
      return `$${params.length}`;
    });
    where.push(`LOWER(sessions.author) IN (${placeholders.join(", ")})`);
  }
  if (opts.access) {
    if (!opts.workspaceId) throw new Error("workspaceId is required for access-scoped session queries");
    params.push(opts.access.userId);
    const user = `$${params.length}`;
    params.push(opts.workspaceId);
    const workspace = `$${params.length}`;
    fromSql += `
      INNER JOIN workspace_member_peon_access pa
        ON pa.peon_id=sessions.peon_id AND pa.user_id=${user} AND pa.workspace_id=${workspace}
      LEFT JOIN workspace_member_project_access ppa
        ON ppa.peon_id=sessions.peon_id AND ppa.user_id=${user} AND ppa.workspace_id=${workspace}
       AND ((sessions.project_id IS NOT NULL AND ppa.project_id=sessions.project_id)
         OR (ppa.project_id IS NULL AND ppa.project_key=sessions.project_key))`;
    where.push(`(sessions.project_key IS NULL OR sessions.project_key = '' OR ppa.peon_id IS NOT NULL)`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRes = await query<{ count: number }>(`SELECT COUNT(DISTINCT sessions.session_id)::int AS count ${fromSql} ${whereSql}`, params);
  const total = totalRes.rows[0]?.count ?? 0;

  const limit = Math.min(Math.max(1, opts.limit), 200);
  const offset = Math.max(0, opts.offset);
  const pageParams = [...params, limit, offset];
  const { rows } = await query<SessionRow>(
    `SELECT DISTINCT sessions.* ${fromSql} ${whereSql}
     ORDER BY sessions.last_activity_at DESC NULLS LAST, sessions.session_id
     LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );
  return { sessions: rows.map(rowToIndexRow), total };
}

function rowToIndexRow(r: SessionRow): SessionIndexRow {
  const raw = r.raw && typeof r.raw === "object" ? r.raw as { promptPreview?: unknown; prompt?: unknown } : null;
  const legacyPromptPreview = typeof raw?.promptPreview === "string"
    ? raw.promptPreview
    : typeof raw?.prompt === "string"
      ? raw.prompt.slice(0, 200)
      : null;
  return {
    peonId: r.peon_id,
    sessionId: r.session_id,
    status: r.status,
    projectKey: r.project_key,
    projectId: r.project_id,
    title: r.title,
    promptPreview: r.prompt_preview ?? legacyPromptPreview,
    preview: r.preview,
    author: r.author,
    outcome: r.outcome,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    lastActivityAt: r.last_activity_at,
    syncedAt: r.synced_at,
  };
}

// Ingest a batch of pushed session events (peonEventPusher.ts). Upserts every
// session (idempotent), then decides whether the stream is intact:
//   - epoch changed vs what we last saw  → the peon restarted → reconcile
//   - seq gap (min incoming > lastSeq+1)  → a push was dropped → reconcile
// Reconcile runs in the background (the batch's own sessions are already applied,
// so nothing is lost while it catches up). Returns the new high-water seq.
export async function ingestEvents(
  workspaceId: string,
  peonId: string,
  epoch: string,
  events: { seq: number; session: PeonSession }[],
): Promise<{ lastSeq: number; reconciled: boolean }> {
  const cur = await query<{ last_event_epoch: string | null; last_event_seq: number | null }>(
    `SELECT last_event_epoch, last_event_seq FROM peons WHERE peon_id = $1`,
    [peonId],
  );
  const prevEpoch = cur.rows[0]?.last_event_epoch ?? null;
  const prevSeq = cur.rows[0]?.last_event_seq ?? null;

  for (const e of events) {
    if (e && e.session && typeof e.session.id === "string") await upsertSession(workspaceId, peonId, e.session);
  }

  const seqs = events.map((e) => e.seq).filter((n) => Number.isFinite(n));
  const maxSeq = seqs.length ? Math.max(...seqs) : (prevSeq ?? 0);
  const minSeq = seqs.length ? Math.min(...seqs) : null;

  // A null prevEpoch means "registered, no events yet" — register already pulled
  // a full snapshot, so a fresh stream needs no reconcile. Only a *changed*
  // (non-null → different) epoch is a genuine restart.
  const restarted = prevEpoch !== null && prevEpoch !== epoch;
  const gap = !restarted && prevEpoch === epoch && prevSeq !== null && minSeq !== null && minSeq > prevSeq + 1;
  const reconcile = restarted || gap;

  if (reconcile) {
    const record = await registry.get(peonId);
    if (record) void reconcilePeon(record).catch(() => null);
  }

  // On a genuine restart the old seq space is meaningless — take this batch's max.
  const newSeq = restarted ? maxSeq : Math.max(maxSeq, prevSeq ?? 0);
  await query(`UPDATE peons SET last_event_epoch = $2, last_event_seq = $3 WHERE peon_id = $1`, [peonId, epoch, newSeq]);
  return { lastSeq: newSeq, reconciled: reconcile };
}

// Periodic reconcile loop (recursive setTimeout so a slow reconcile can't stack).
// Runs one pass immediately so the index is warm shortly after boot.
export function startReconciler(): void {
  const loop = async () => {
    try {
      await reconcileAll();
    } catch (err) {
      console.warn("reconcile failed:", err instanceof Error ? err.message : String(err));
    }
    setTimeout(loop, config.reconcileIntervalMs);
  };
  void loop();
}
