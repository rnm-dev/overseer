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

// The subset of a peon SessionRecord we promote to queryable columns; the whole
// record is also stored in `raw` for detail views. Shapes follow peon's
// sessions.ts (SessionRecord) — unknown/missing fields degrade to null.
interface PeonSession {
  id: string;
  status?: string | null;
  projectKey?: string | null;
  title?: string | null;
  lastMessagePreview?: string | null;
  prompt?: string | null;
  initiator?: string | null;
  outcome?: unknown;
  startedAt?: number | null;
  endedAt?: number | null;
  lastActivityAt?: number | null;
}

export interface SessionIndexRow {
  peonId: string;
  sessionId: string;
  status: string | null;
  projectKey: string | null;
  title: string | null;
  preview: string | null;
  author: string | null;
  outcome: unknown;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
  syncedAt: number;
  raw: unknown;
}

// Fingerprint of the last-written row per (peon, session), so a reconcile that
// re-pulls unchanged sessions doesn't emit a fresh event for each one — only real
// changes hit the event log / live stream.
const fingerprints = new Map<string, string>();

export async function upsertSession(workspaceId: string, peonId: string, s: PeonSession): Promise<void> {
  const row: SessionIndexRow = {
    peonId,
    sessionId: s.id,
    status: s.status ?? null,
    projectKey: s.projectKey ?? null,
    title: s.title ?? null,
    preview: s.lastMessagePreview ?? s.prompt?.slice(0, 200) ?? null,
    author: s.initiator ?? null,
    outcome: s.outcome ?? null,
    startedAt: s.startedAt ?? null,
    endedAt: s.endedAt ?? null,
    lastActivityAt: s.lastActivityAt ?? null,
    syncedAt: Date.now(),
    raw: s,
  };
  await query(
    `INSERT INTO sessions
       (peon_id, session_id, status, project_key, title, preview, author, outcome, started_at, ended_at, last_activity_at, raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (peon_id, session_id) DO UPDATE SET
       status = EXCLUDED.status, project_key = EXCLUDED.project_key, title = EXCLUDED.title,
       preview = EXCLUDED.preview, author = EXCLUDED.author, outcome = EXCLUDED.outcome,
       started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at,
       last_activity_at = EXCLUDED.last_activity_at, raw = EXCLUDED.raw, synced_at = EXCLUDED.synced_at`,
    [
      peonId,
      row.sessionId,
      row.status,
      row.projectKey,
      row.title,
      row.preview,
      row.author,
      s.outcome !== undefined ? JSON.stringify(s.outcome) : null,
      row.startedAt,
      row.endedAt,
      row.lastActivityAt,
      JSON.stringify(s),
      row.syncedAt,
    ],
  );

  const key = `${peonId}:${row.sessionId}`;
  const fp = `${row.status}|${row.lastActivityAt}|${row.endedAt}|${row.title}|${row.preview}`;
  if (fingerprints.get(key) !== fp) {
    fingerprints.set(key, fp);
    await appendEvent({ workspaceId, peonId, sessionId: row.sessionId, kind: "session", payload: row });
  }
}

// Pull one peon's full session list into the index. Returns the count synced, or
// null if the peon was unreachable / returned garbage (caller decides whether to
// care — a transient miss just leaves the last-known rows in place).
export async function reconcilePeon(record: PeonRecord): Promise<number | null> {
  const res = await callPeon(connOfRecord(record), "GET", "/sessions");
  if (!res.ok) return null;
  const sessions = (res.json as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions)) return null;
  for (const s of sessions as PeonSession[]) {
    if (s && typeof s.id === "string") await upsertSession(record.workspaceId, record.peonId, s);
  }
  return sessions.length;
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
  limit: number;
  offset: number;
}

interface SessionRow {
  peon_id: string;
  session_id: string;
  status: string | null;
  project_key: string | null;
  title: string | null;
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
  if (opts.workspaceId) {
    params.push(opts.workspaceId);
    where.push(`peon_id IN (SELECT peon_id FROM peons WHERE workspace_id = $${params.length})`);
  }
  if (opts.peonId) {
    params.push(opts.peonId);
    where.push(`peon_id = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRes = await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM sessions ${whereSql}`, params);
  const total = totalRes.rows[0]?.count ?? 0;

  const limit = Math.min(Math.max(1, opts.limit), 200);
  const offset = Math.max(0, opts.offset);
  const pageParams = [...params, limit, offset];
  const { rows } = await query<SessionRow>(
    `SELECT * FROM sessions ${whereSql}
     ORDER BY last_activity_at DESC NULLS LAST, session_id
     LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );
  return { sessions: rows.map(rowToIndexRow), total };
}

function rowToIndexRow(r: SessionRow): SessionIndexRow {
  return {
    peonId: r.peon_id,
    sessionId: r.session_id,
    status: r.status,
    projectKey: r.project_key,
    title: r.title,
    preview: r.preview,
    author: r.author,
    outcome: r.outcome,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    lastActivityAt: r.last_activity_at,
    syncedAt: r.synced_at,
    raw: r.raw,
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

let timer: ReturnType<typeof setTimeout> | null = null;

// Periodic reconcile loop (recursive setTimeout so a slow reconcile can't stack).
// Runs one pass immediately so the index is warm shortly after boot.
export function startReconciler(): void {
  const loop = async () => {
    try {
      await reconcileAll();
    } catch (err) {
      console.warn("reconcile failed:", err instanceof Error ? err.message : String(err));
    }
    timer = setTimeout(loop, config.reconcileIntervalMs);
  };
  void loop();
}
