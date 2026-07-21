import { config } from "./config.js";
import { query, transaction, type Transaction } from "./db.js";
import { registry, toView, type PeonRecord } from "./registry.js";
import { callPeon, connOfRecord } from "./peonClient.js";
import { insertEvent, publishCommittedEvent, type LiveEvent } from "./eventLog.js";

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

// JavaScript strings may contain unpaired UTF-16 surrogates even though those
// values cannot be represented in PostgreSQL JSONB. Replace malformed units at
// the projection boundary and truncate by Unicode code point so a valid emoji
// is never split into the exact malformed value we are defending against.
export function sanitizeUnicode(value: string): string {
  let clean = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        clean += value[index] + value[index + 1];
        index += 1;
      } else {
        clean += "\ufffd";
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      clean += "\ufffd";
    } else {
      clean += value[index];
    }
  }
  return clean;
}

function sanitizeOptionalUnicode(value: string | null | undefined): string | null {
  return value == null ? null : sanitizeUnicode(value);
}

function sanitizeJsonUnicode(value: unknown): unknown {
  if (typeof value === "string") return sanitizeUnicode(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonUnicode);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitizeUnicode(key), sanitizeJsonUnicode(item)]));
  }
  return value;
}

function truncateUnicode(value: string, maxCodePoints: number): string {
  return [...sanitizeUnicode(value)].slice(0, maxCodePoints).join("");
}

export function normalizeSessionSummary(s: PeonSession): SessionSummary {
  return {
    id: sanitizeUnicode(s.id),
    status: sanitizeOptionalUnicode(s.status),
    projectKey: sanitizeOptionalUnicode(s.projectKey),
    projectId: sanitizeOptionalUnicode(s.projectId),
    title: sanitizeOptionalUnicode(s.title),
    promptPreview: s.promptPreview != null
      ? sanitizeUnicode(s.promptPreview)
      : s.prompt != null ? truncateUnicode(s.prompt, 200) : null,
    lastMessagePreview: sanitizeOptionalUnicode(s.lastMessagePreview),
    initiator: sanitizeOptionalUnicode(s.initiator),
    outcome: sanitizeJsonUnicode(s.outcome ?? null),
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

interface StoredMutation {
  event: LiveEvent | null;
  fingerprintKey?: string;
  fingerprint?: string;
  deletedKey?: string;
}

async function storeSession(tx: Transaction, workspaceId: string, peonId: string, s: PeonSession): Promise<StoredMutation> {
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
  const stored = await tx.query<{ synced_at: number }>(
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
  if (Number(stored.rows[0]?.synced_at) !== row.syncedAt) return { event: null };

  const key = `${peonId}:${row.sessionId}`;
  const fp = `${row.status}|${row.projectId}|${row.projectKey}|${row.lastActivityAt}|${row.endedAt}|${row.title}|${row.promptPreview}|${row.preview}`;
  if (fingerprints.get(key) !== fp) {
    const event = await insertEvent(tx, { workspaceId, peonId, sessionId: row.sessionId, kind: "session", payload: row });
    return { event, fingerprintKey: key, fingerprint: fp };
  }
  return { event: null };
}

async function publishMutation(mutation: StoredMutation): Promise<void> {
  if (!mutation.event) return;
  await publishCommittedEvent(mutation.event);
  if (mutation.deletedKey) fingerprints.delete(mutation.deletedKey);
  else if (mutation.fingerprintKey && mutation.fingerprint) fingerprints.set(mutation.fingerprintKey, mutation.fingerprint);
}

export async function upsertSession(workspaceId: string, peonId: string, s: PeonSession): Promise<void> {
  const mutation = await transaction((tx) => storeSession(tx, workspaceId, peonId, s));
  await publishMutation(mutation);
}

async function deleteSession(
  tx: Transaction,
  workspaceId: string,
  peonId: string,
  sessionId: string,
  expectedSyncedAt?: number,
): Promise<StoredMutation> {
  const syncedAt = nextSyncedAt();
  const params: unknown[] = [peonId, sessionId];
  const versionGuard = expectedSyncedAt === undefined ? "" : ` AND synced_at = $${params.push(expectedSyncedAt)}`;
  const deleted = await tx.query<{ session_id: string }>(
    `DELETE FROM sessions WHERE peon_id = $1 AND session_id = $2${versionGuard} RETURNING session_id`,
    params,
  );
  if (!deleted.rows[0]) return { event: null };

  const event = await insertEvent(tx, {
    workspaceId,
    peonId,
    sessionId,
    kind: "session",
    payload: { peonId, sessionId, deleted: true, syncedAt },
  });
  return { event, deletedKey: `${peonId}:${sessionId}` };
}

export async function deleteIndexedSession(
  workspaceId: string,
  peonId: string,
  sessionId: string,
  expectedSyncedAt?: number,
): Promise<boolean> {
  const mutation = await transaction((tx) => deleteSession(tx, workspaceId, peonId, sessionId, expectedSyncedAt));
  await publishMutation(mutation);
  return mutation.event !== null;
}

// Pull one peon's full session list into the index. Returns the count synced, or
// null if the peon was unreachable / returned garbage (caller decides whether to
// care — a transient miss just leaves the last-known rows in place).
export async function reconcilePeon(record: PeonRecord): Promise<number | null> {
  const sync = await query<{ status: string; updated_at: number | string; catalog_epoch: string | null }>(
    `SELECT status, updated_at, catalog_epoch FROM peon_session_sync WHERE peon_id = $1`,
    [record.peonId],
  );
  // Registry capabilities describe the HTTP API, so socket authority is proven
  // by the negotiated sync lease/checkpoint instead. Before the first socket
  // snapshot, or after a failed first attempt, legacy reconciliation remains
  // available. A live first sync is the only writer, but its database lease
  // expires so a process crash cannot strand the Peon without either transport.
  const state = sync.rows[0];
  const activeFirstSync = state?.status === "syncing" && Number(state.updated_at) >= Date.now() - 120_000;
  // Only migration-018's catalog checkpoint proves canonical cutover. Old
  // ready/stale values belong to the retired sessions.* dialect. Conversely,
  // once a canonical snapshot has committed, never restore HTTP authority merely
  // because a quiet resumed socket has not produced another catalog event.
  if (state && (state.catalog_epoch !== null || activeFirstSync)) return null;

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
  await applySessionIndexSnapshot(record.workspaceId, record.peonId, sessions as PeonSession[], existing.rows);
  return sessions.length;
}

export async function applySessionIndexSnapshot(
  workspaceId: string,
  peonId: string,
  sessions: PeonSession[],
  existingRows?: { session_id: string; synced_at: number }[],
): Promise<number> {
  const existing = existingRows ?? (await query<{ session_id: string; synced_at: number }>(
    `SELECT session_id, synced_at FROM sessions WHERE peon_id = $1`,
    [peonId],
  )).rows;
  const resolvedSessions = resolveSessionProjectIds(sessions);
  for (const session of resolvedSessions) {
    if (session && typeof session.id === "string") await upsertSession(workspaceId, peonId, session);
  }
  const remoteIds = new Set(resolvedSessions.flatMap((session) => typeof session?.id === "string" ? [session.id] : []));
  for (const row of existing) {
    if (!remoteIds.has(row.session_id)) {
      await deleteIndexedSession(workspaceId, peonId, row.session_id, Number(row.synced_at));
    }
  }
  await backfillStoredSessionProjectIds(peonId, resolvedSessions);
  await backfillProjectAccess(workspaceId, peonId, resolvedSessions);
  return resolvedSessions.length;
}

export interface SessionSyncCheckpoint {
  catalog: { epoch: string; acknowledgedSeq: number } | null;
  delivery: { epoch: string; acknowledgedCursor: string | null } | null;
  previouslyReady: boolean;
}

export class StaleSessionSyncGenerationError extends Error {}

export async function claimSessionSyncGeneration(peonId: string, generation: string): Promise<SessionSyncCheckpoint | null> {
  const { rows } = await query<{
    catalog_epoch: string | null;
    acknowledged_seq: number | string | null;
    delivery_epoch: string | null;
    acknowledged_cursor: string | null;
    previous_status: string | null;
  }>(
    `INSERT INTO peon_session_sync (peon_id, epoch, cursor, status, updated_at, generation)
     VALUES ($1,NULL,NULL,'syncing',$2,$3)
     ON CONFLICT (peon_id) DO UPDATE SET
       status=CASE WHEN peon_session_sync.catalog_epoch IS NULL THEN 'syncing' ELSE 'ready' END,
       updated_at=EXCLUDED.updated_at, generation=EXCLUDED.generation
     RETURNING catalog_epoch, acknowledged_seq, delivery_epoch, acknowledged_cursor,
       CASE WHEN catalog_epoch IS NOT NULL THEN 'ready' ELSE NULL END AS previous_status`,
    [peonId, Date.now(), generation],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    catalog: row.catalog_epoch && row.acknowledged_seq !== null
      ? { epoch: row.catalog_epoch, acknowledgedSeq: Number(row.acknowledged_seq) }
      : null,
    delivery: row.delivery_epoch
      ? { epoch: row.delivery_epoch, acknowledgedCursor: row.acknowledged_cursor }
      : null,
    previouslyReady: row.previous_status === "ready",
  };
}

export async function markSessionSyncing(peonId: string, generation: string): Promise<void> {
  const updated = await query<{ peon_id: string }>(
    `UPDATE peon_session_sync SET status='syncing', updated_at=$3
     WHERE peon_id=$1 AND generation=$2 RETURNING peon_id`,
    [peonId, generation, Date.now()],
  );
  if (!updated.rows[0]) throw new StaleSessionSyncGenerationError("session sync connection was replaced");
}

export async function releaseSessionSyncGeneration(peonId: string, generation: string): Promise<void> {
  await query(
    `UPDATE peon_session_sync
       SET status = CASE WHEN catalog_epoch IS NULL THEN 'fallback' ELSE 'stale' END, updated_at = $3
     WHERE peon_id = $1 AND generation = $2`,
    [peonId, generation, Date.now()],
  );
}

async function advanceSessionCheckpoints(
  tx: Transaction,
  peonId: string,
  generation: string,
  catalogEpoch: string,
  acknowledgedSeq: number,
  delivery?: { epoch: string; acknowledgedCursor: string | null },
): Promise<void> {
  const deliveryUpdate = delivery
    ? `, delivery_epoch=$6, acknowledged_cursor=$7`
    : "";
  const params: unknown[] = [peonId, generation, catalogEpoch, acknowledgedSeq, Date.now()];
  if (delivery) params.push(delivery.epoch, delivery.acknowledgedCursor);
  const updated = await tx.query<{ peon_id: string }>(
    `UPDATE peon_session_sync SET catalog_epoch=$3, acknowledged_seq=$4, status='ready', updated_at=$5${deliveryUpdate}
     WHERE peon_id=$1 AND generation=$2 RETURNING peon_id`,
    params,
  );
  if (!updated.rows[0]) throw new StaleSessionSyncGenerationError("session sync connection was replaced");
}

async function assertSessionSyncGeneration(tx: Transaction, peonId: string, generation: string): Promise<void> {
  const current = await tx.query<{ peon_id: string }>(
    `SELECT peon_id FROM peon_session_sync WHERE peon_id=$1 AND generation=$2`,
    [peonId, generation],
  );
  if (!current.rows[0]) throw new StaleSessionSyncGenerationError("session sync connection was replaced");
}

async function publishSyncMutations(mutations: StoredMutation[]): Promise<void> {
  for (const mutation of mutations) {
    // The event is already durable in the same transaction as the projection
    // and checkpoint. Mark its fingerprint before best-effort live fan-out; a
    // process crash is repaired through the operator event-log cursor.
    if (mutation.deletedKey) fingerprints.delete(mutation.deletedKey);
    else if (mutation.fingerprintKey && mutation.fingerprint) fingerprints.set(mutation.fingerprintKey, mutation.fingerprint);
    if (mutation.event) {
      await publishCommittedEvent(mutation.event).catch((error) => {
        console.warn("session sync event fan-out failed:", error instanceof Error ? error.message : String(error));
      });
    }
  }
}

export async function applySocketSessionSnapshot(input: {
  workspaceId: string;
  peonId: string;
  generation: string;
  catalogEpoch: string;
  barrierSeq: number;
  deliveryEpoch: string;
  acknowledgedCursor: string | null;
  sessions: PeonSession[];
}): Promise<void> {
  const resolvedSessions = resolveSessionProjectIds(input.sessions);
  const mutations = await transaction(async (tx) => {
    await assertSessionSyncGeneration(tx, input.peonId, input.generation);
    const existing = await tx.query<{ session_id: string; synced_at: number }>(
      `SELECT session_id, synced_at FROM sessions WHERE peon_id = $1`,
      [input.peonId],
    );
    const committed: StoredMutation[] = [];
    for (const session of resolvedSessions) committed.push(await storeSession(tx, input.workspaceId, input.peonId, session));
    const remoteIds = new Set(resolvedSessions.map((session) => session.id));
    for (const row of existing.rows) {
      if (!remoteIds.has(row.session_id)) {
        committed.push(await deleteSession(tx, input.workspaceId, input.peonId, row.session_id, Number(row.synced_at)));
      }
    }
    await advanceSessionCheckpoints(tx, input.peonId, input.generation, input.catalogEpoch, input.barrierSeq, {
      epoch: input.deliveryEpoch,
      acknowledgedCursor: input.acknowledgedCursor,
    });
    return committed;
  });
  await publishSyncMutations(mutations);
  await backfillStoredSessionProjectIds(input.peonId, resolvedSessions);
  await backfillProjectAccess(input.workspaceId, input.peonId, resolvedSessions);
}

export async function applySocketSessionEvent(input: {
  workspaceId: string;
  peonId: string;
  generation: string;
  catalogEpoch: string;
  seq: number;
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
  operation: "upsert" | "delete";
  session?: PeonSession;
  sessionId?: string;
}): Promise<{ catalog: { epoch: string; acknowledgedSeq: number }; delivery: { epoch: string; acknowledgedCursor: string } }> {
  const result = await transaction(async (tx) => {
    await assertSessionSyncGeneration(tx, input.peonId, input.generation);
    const inserted = await tx.query<{ cursor: string }>(
      `INSERT INTO peon_session_inbox (peon_id, epoch, cursor, created_at, message_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING cursor`,
      [input.peonId, input.deliveryEpoch, input.deliveryCursor, Date.now(), input.messageId],
    );
    if (!inserted.rows[0]) {
      const replay = await tx.query<{ epoch: string; cursor: string; message_id: string | null }>(
        `SELECT epoch, cursor, message_id FROM peon_session_inbox
         WHERE peon_id=$1 AND ((epoch=$2 AND cursor=$3) OR message_id=$4)`,
        [input.peonId, input.deliveryEpoch, input.deliveryCursor, input.messageId],
      );
      const replayed = replay.rows[0];
      if (!replayed || replayed.epoch !== input.deliveryEpoch || replayed.cursor !== input.deliveryCursor || replayed.message_id !== input.messageId) {
        throw new Error("durable message replay identity mismatch");
      }
      const current = await tx.query<{
        catalog_epoch: string | null; acknowledged_seq: number | string | null;
        delivery_epoch: string | null; acknowledged_cursor: string | null;
      }>(
        `SELECT catalog_epoch, acknowledged_seq, delivery_epoch, acknowledged_cursor
         FROM peon_session_sync WHERE peon_id=$1 AND generation=$2`,
        [input.peonId, input.generation],
      );
      if (!current.rows[0]) throw new StaleSessionSyncGenerationError("session sync connection was replaced");
      const checkpoint = current.rows[0];
      if (!checkpoint.catalog_epoch || checkpoint.acknowledged_seq === null || !checkpoint.delivery_epoch || !checkpoint.acknowledged_cursor) {
        throw new Error("duplicate durable message has no committed checkpoint");
      }
      return {
        checkpoint: {
          catalog: { epoch: checkpoint.catalog_epoch, acknowledgedSeq: Number(checkpoint.acknowledged_seq) },
          delivery: { epoch: checkpoint.delivery_epoch, acknowledgedCursor: checkpoint.acknowledged_cursor },
        },
        mutation: null,
      };
    }
    const current = await tx.query<{ catalog_epoch: string | null; acknowledged_seq: number | string | null }>(
      `SELECT catalog_epoch, acknowledged_seq FROM peon_session_sync WHERE peon_id=$1 AND generation=$2`,
      [input.peonId, input.generation],
    );
    const catalog = current.rows[0];
    if (!catalog?.catalog_epoch || catalog.acknowledged_seq === null) throw new Error("session catalog event arrived before snapshot");
    if (catalog.catalog_epoch !== input.catalogEpoch) throw new Error("session catalog epoch mismatch");
    if (input.seq !== Number(catalog.acknowledged_seq) + 1) throw new Error("session catalog sequence gap");
    const mutation = input.operation === "upsert"
      ? await storeSession(tx, input.workspaceId, input.peonId, input.session!)
      : await deleteSession(tx, input.workspaceId, input.peonId, input.sessionId!);
    await advanceSessionCheckpoints(
      tx, input.peonId, input.generation, input.catalogEpoch, input.seq,
      { epoch: input.deliveryEpoch, acknowledgedCursor: input.deliveryCursor },
    );
    return {
      checkpoint: {
        catalog: { epoch: input.catalogEpoch, acknowledgedSeq: input.seq },
        delivery: { epoch: input.deliveryEpoch, acknowledgedCursor: input.deliveryCursor },
      },
      mutation,
    };
  });
  if (result.mutation) await publishSyncMutations([result.mutation]);
  return result.checkpoint;
}

export async function commitSnapshotCoveredSessionEvent(input: {
  peonId: string;
  generation: string;
  catalogEpoch: string;
  seq: number;
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
}): Promise<{ catalog: { epoch: string; acknowledgedSeq: number }; delivery: { epoch: string; acknowledgedCursor: string } }> {
  return transaction(async (tx) => {
    await assertSessionSyncGeneration(tx, input.peonId, input.generation);
    const inserted = await tx.query<{ cursor: string }>(
      `INSERT INTO peon_session_inbox (peon_id, epoch, cursor, created_at, message_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING cursor`,
      [input.peonId, input.deliveryEpoch, input.deliveryCursor, Date.now(), input.messageId],
    );
    const current = await tx.query<{
      catalog_epoch: string | null; acknowledged_seq: number | string | null;
      delivery_epoch: string | null; acknowledged_cursor: string | null;
    }>(
      `SELECT catalog_epoch, acknowledged_seq, delivery_epoch, acknowledged_cursor
       FROM peon_session_sync WHERE peon_id=$1 AND generation=$2`,
      [input.peonId, input.generation],
    );
    const checkpoint = current.rows[0];
    if (!checkpoint?.catalog_epoch || checkpoint.acknowledged_seq === null) throw new Error("covered event has no snapshot checkpoint");
    if (checkpoint.catalog_epoch !== input.catalogEpoch || input.seq > Number(checkpoint.acknowledged_seq)) {
      throw new Error("event is not covered by the committed snapshot");
    }
    if (!inserted.rows[0]) {
      const replay = await tx.query<{ epoch: string; cursor: string; message_id: string | null }>(
        `SELECT epoch, cursor, message_id FROM peon_session_inbox
         WHERE peon_id=$1 AND ((epoch=$2 AND cursor=$3) OR message_id=$4)`,
        [input.peonId, input.deliveryEpoch, input.deliveryCursor, input.messageId],
      );
      const row = replay.rows[0];
      if (!row || row.epoch !== input.deliveryEpoch || row.cursor !== input.deliveryCursor || row.message_id !== input.messageId) {
        throw new Error("durable message replay identity mismatch");
      }
    } else {
      await advanceSessionCheckpoints(
        tx, input.peonId, input.generation, checkpoint.catalog_epoch, Number(checkpoint.acknowledged_seq),
        { epoch: input.deliveryEpoch, acknowledgedCursor: input.deliveryCursor },
      );
    }
    return {
      catalog: { epoch: checkpoint.catalog_epoch, acknowledgedSeq: Number(checkpoint.acknowledged_seq) },
      delivery: {
        epoch: inserted.rows[0] ? input.deliveryEpoch : checkpoint.delivery_epoch ?? input.deliveryEpoch,
        acknowledgedCursor: inserted.rows[0] ? input.deliveryCursor : checkpoint.acknowledged_cursor ?? input.deliveryCursor,
      },
    };
  });
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
  perPeonLimit?: number;
  limit: number;
  offset: number;
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

function rowToIndexRow(r: SessionRow): SessionIndexRow {
  return {
    peonId: r.peon_id,
    sessionId: r.session_id,
    status: r.status,
    projectKey: r.project_key,
    projectId: r.project_id,
    title: r.title,
    promptPreview: r.prompt_preview?.slice(0, 200) ?? null,
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
