import { query } from "../../infrastructure/db/index.js";
import { registry, toView } from "../fleet/index.js";
import type { ListOptions, OperatorRecentSession, SessionCatalogState, SessionIndexRow } from "./sessionTypes.js";

export async function getSessionCatalogStates(workspaceId: string, peonId?: string): Promise<SessionCatalogState[]> {
  const records = (await registry.list()).filter((record) =>
    record.workspaceId === workspaceId && (peonId === undefined || record.peonId === peonId));
  if (records.length === 0) return [];
  const { rows } = await query<{
    peon_id: string; status: string; updated_at: number | string;
    catalog_epoch: string | null; acknowledged_seq: number | string | null; delivery_epoch: string | null;
  }>(
    `SELECT peon_id, status, updated_at, catalog_epoch, acknowledged_seq, delivery_epoch
     FROM peon_session_sync WHERE peon_id IN (${records.map((_, index) => `$${index + 1}`).join(",")})`,
    records.map((record) => record.peonId),
  );
  const byPeon = new Map(rows.map((row) => [row.peon_id, row]));
  return records.map((record) => {
    const row = byPeon.get(record.peonId);
    const online = toView(record).online;
    const canonical = row?.catalog_epoch != null;
    const activeState = canonical
      ? row!.status === "syncing" ? "syncing" as const : row!.status === "ready" ? "ready" as const : "stale" as const
      : row?.status === "syncing" ? "syncing" as const
        : row?.status === "fallback" ? "fallback" as const
          : "legacy" as const;
    const state = online ? activeState : "offline" as const;
    return {
      peonId: record.peonId,
      online,
      state,
      // Legacy and fallback Peons are still refreshed by authoritative HTTP
      // reconciliation. Only an offline Peon or an incomplete/failed canonical
      // projection is stale; canonical readiness is not a prerequisite for
      // freshness during the compatibility rollout.
      stale: !online || activeState === "syncing" || activeState === "stale",
      updatedAt: row ? Number(row.updated_at) : null,
      catalogRevision: canonical && row?.acknowledged_seq !== null ? Number(row?.acknowledged_seq) : null,
      deliveryCommitted: canonical && row?.delivery_epoch != null,
    };
  });
}

export async function getIndexedSession(peonId: string, sessionId: string): Promise<SessionIndexRow | null> {
  const { rows } = await query<SessionRow>(
    `SELECT ${sessionProjection} FROM sessions WHERE sessions.peon_id = $1 AND sessions.session_id = $2`,
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
}

const sessionProjection = `
  sessions.peon_id,
  sessions.session_id,
  sessions.status,
  sessions.project_key,
  sessions.project_id,
  sessions.title,
  COALESCE(
    sessions.prompt_preview,
    sessions.raw->>'promptPreview',
    sessions.raw->>'prompt'
  ) AS prompt_preview,
  sessions.preview,
  sessions.author,
  sessions.outcome,
  sessions.started_at,
  sessions.ended_at,
  sessions.last_activity_at,
  sessions.synced_at`;

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
  if (opts.projectKey) {
    params.push(opts.projectKey);
    where.push(`sessions.project_key = $${params.length}`);
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
         OR (sessions.project_id IS NULL AND ppa.project_id IS NULL AND ppa.project_key=sessions.project_key))`;
    where.push(`(sessions.project_key IS NULL OR sessions.project_key = '' OR ppa.peon_id IS NOT NULL)`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRes = await query<{ count: number }>(`SELECT COUNT(DISTINCT sessions.session_id)::int AS count ${fromSql} ${whereSql}`, params);
  const total = totalRes.rows[0]?.count ?? 0;

  const limit = Math.min(Math.max(1, opts.limit), 200);
  const offset = Math.max(0, opts.offset);
  if (opts.perProjectLimit !== undefined) {
    const perProjectLimit = Math.min(Math.max(1, opts.perProjectLimit), 99);
    const { rows } = await query<SessionRow>(
      `SELECT DISTINCT ${sessionProjection} ${fromSql} ${whereSql}
       ORDER BY sessions.last_activity_at DESC NULLS LAST, sessions.session_id`,
      params,
    );
    const counts = new Map<string, number>();
    const sessions = rows.filter((row) => {
      const project = row.project_id
        ? `id:${row.project_id}`
        : row.project_key ? `key:${row.project_key}` : "unassigned";
      const bucket = `${row.peon_id}\0${project}`;
      const count = counts.get(bucket) ?? 0;
      if (count >= perProjectLimit) return false;
      counts.set(bucket, count + 1);
      return true;
    });
    return { sessions: sessions.map(rowToIndexRow), total };
  }
  if (opts.perPeonLimit !== undefined) {
    const perPeonLimit = Math.min(Math.max(1, opts.perPeonLimit), 50);
    const { rows } = await query<SessionRow>(
      `SELECT DISTINCT ${sessionProjection} ${fromSql} ${whereSql}
       ORDER BY sessions.last_activity_at DESC NULLS LAST, sessions.session_id`,
      params,
    );
    const counts = new Map<string, number>();
    const sessions = rows.filter((row) => {
      const count = counts.get(row.peon_id) ?? 0;
      if (count >= perPeonLimit) return false;
      counts.set(row.peon_id, count + 1);
      return true;
    });
    return { sessions: sessions.map(rowToIndexRow), total };
  }
  const pageParams = [...params, limit, offset];
  const { rows } = await query<SessionRow>(
    `SELECT DISTINCT ${sessionProjection} ${fromSql} ${whereSql}
     ORDER BY sessions.last_activity_at DESC NULLS LAST, sessions.session_id
     LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );
  return { sessions: rows.map(rowToIndexRow), total };
}

export const RECENT_SESSIONS_MIN_LIMIT = 1;
export const RECENT_SESSIONS_MAX_LIMIT = 10;
export const RECENT_SESSIONS_DEFAULT_LIMIT = 5;

export function clampRecentSessionsLimit(raw: unknown): number {
  const parsed = typeof raw === "string" || typeof raw === "number" ? Number.parseInt(String(raw), 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return RECENT_SESSIONS_DEFAULT_LIMIT;
  return Math.min(RECENT_SESSIONS_MAX_LIMIT, Math.max(RECENT_SESSIONS_MIN_LIMIT, parsed));
}

// The sessions one operator personally touched — created or followed up on —
// grouped per Peon and bounded, for the Fleet list. Membership comes from
// `session_attention` rather than `sessions.author`, which would miss a
// follow-up the operator sent into somebody else's session.
export async function listOperatorRecentSessions(opts: {
  workspaceId: string;
  userId: string;
  peonIds: string[];
  limit: number;
  access?: { userId: string };
}): Promise<Map<string, OperatorRecentSession[]>> {
  const grouped = new Map<string, OperatorRecentSession[]>();
  if (opts.peonIds.length === 0) return grouped;
  const limit = Math.min(RECENT_SESSIONS_MAX_LIMIT, Math.max(RECENT_SESSIONS_MIN_LIMIT, opts.limit));
  const params: unknown[] = [opts.workspaceId, opts.userId];
  const peonPlaceholders = opts.peonIds.map((peonId) => {
    params.push(peonId);
    return `$${params.length}`;
  });
  let joinSql = "";
  let accessPredicate = "";
  if (opts.access) {
    params.push(opts.access.userId);
    const user = `$${params.length}`;
    params.push(opts.workspaceId);
    const workspace = `$${params.length}`;
    joinSql = `
      INNER JOIN workspace_member_peon_access pa
        ON pa.peon_id=sessions.peon_id AND pa.user_id=${user} AND pa.workspace_id=${workspace}
      LEFT JOIN workspace_member_project_access ppa
        ON ppa.peon_id=sessions.peon_id AND ppa.user_id=${user} AND ppa.workspace_id=${workspace}
       AND ((sessions.project_id IS NOT NULL AND ppa.project_id=sessions.project_id)
         OR (sessions.project_id IS NULL AND ppa.project_id IS NULL AND ppa.project_key=sessions.project_key))`;
    accessPredicate = ` AND (sessions.project_key IS NULL OR sessions.project_key = '' OR ppa.peon_id IS NOT NULL)`;
  }

  // One query for the whole fleet — never one per Peon. The per-Peon cut is
  // applied below rather than with ROW_NUMBER() so the same statement runs
  // under pg-mem, which has no window functions; the joined set is bounded by
  // what this one operator has personally touched, and the ordering here is
  // exactly the ordering the cut relies on.
  const { rows } = await query<OperatorRecentSessionRow>(
    `SELECT sessions.peon_id, sessions.session_id, sessions.status, sessions.title,
            sessions.prompt_preview, sessions.preview,
            sessions.project_id, sessions.project_key, sessions.started_at, sessions.last_activity_at,
            sessions.synced_at,
            MAX(a.requested_at) AS last_requested_at,
            MAX(a.completed_at) AS last_completed_at,
            MAX(a.read_at) AS last_read_at,
            MAX(a.resolved_at) AS last_resolved_at,
            BOOL_OR(a.resolved_at IS NULL) AS has_outstanding_request,
            BOOL_OR(a.state = 'unread') AS attention_unread
       FROM sessions
       INNER JOIN session_attention a
         ON a.peon_id=sessions.peon_id AND a.session_id=sessions.session_id
        AND a.workspace_id=$1 AND a.user_id=$2${joinSql}
      WHERE sessions.peon_id IN (${peonPlaceholders.join(",")})${accessPredicate}
      GROUP BY sessions.peon_id, sessions.session_id, sessions.status, sessions.title,
               sessions.prompt_preview, sessions.preview,
               sessions.project_id, sessions.project_key, sessions.started_at, sessions.last_activity_at,
               sessions.synced_at
      ORDER BY sessions.last_activity_at DESC NULLS LAST, sessions.started_at DESC NULLS LAST, sessions.session_id ASC`,
    params,
  );
  for (const row of rows) {
    const list = grouped.get(row.peon_id) ?? [];
    if (list.length >= limit) continue;
    list.push({
      peonId: row.peon_id,
      sessionId: row.session_id,
      status: row.status,
      title: row.title,
      // The same trimming the canonical session list applies, so a client can
      // fall back title → promptPreview → preview without a second request.
      promptPreview: row.prompt_preview?.slice(0, 200) ?? null,
      preview: row.preview,
      projectId: row.project_id,
      projectKey: row.project_key,
      startedAt: row.started_at === null ? null : Number(row.started_at),
      lastActivityAt: row.last_activity_at === null ? null : Number(row.last_activity_at),
      syncedAt: Number(row.synced_at ?? 0),
      lastRequestedAt: row.last_requested_at === null ? null : Number(row.last_requested_at),
      hasOutstandingRequest: row.has_outstanding_request === true,
      attentionUnread: row.attention_unread === true,
      // Mirrors the workspace session list: the newest of this operator's own
      // attention timestamps. GREATEST() is folded here rather than in SQL to
      // stay inside the dialect pg-mem and PostgreSQL both run.
      attentionUpdatedAt: Math.max(
        Number(row.last_requested_at ?? 0),
        Number(row.last_completed_at ?? 0),
        Number(row.last_read_at ?? 0),
        Number(row.last_resolved_at ?? 0),
      ),
    });
    grouped.set(row.peon_id, list);
  }
  return grouped;
}

interface OperatorRecentSessionRow {
  peon_id: string;
  session_id: string;
  status: string | null;
  title: string | null;
  prompt_preview: string | null;
  preview: string | null;
  project_id: string | null;
  project_key: string | null;
  started_at: number | string | null;
  last_activity_at: number | string | null;
  synced_at: number | string | null;
  last_requested_at: number | string | null;
  last_completed_at: number | string | null;
  last_read_at: number | string | null;
  last_resolved_at: number | string | null;
  has_outstanding_request: boolean | null;
  attention_unread: boolean | null;
}

function rowToIndexRow(row: SessionRow): SessionIndexRow {
  return {
    peonId: row.peon_id,
    sessionId: row.session_id,
    status: row.status,
    projectKey: row.project_key,
    projectId: row.project_id,
    title: row.title,
    promptPreview: row.prompt_preview?.slice(0, 200) ?? null,
    preview: row.preview,
    author: row.author,
    outcome: row.outcome,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastActivityAt: row.last_activity_at,
    syncedAt: row.synced_at,
  };
}
