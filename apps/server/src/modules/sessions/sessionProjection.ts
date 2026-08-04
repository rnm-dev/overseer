import { config } from "../../config.js";
import { query, transaction, type Transaction } from "../../db.js";
import { registry, toView, type PeonRecord } from "../../registry.js";
import { callPeon, connOfRecord } from "../../infrastructure/peonHttp/index.js";
import { insertEvent, publishCommittedEvent, type LiveEvent } from "../../eventLog.js";
import { normalizeSessionSummary } from "./sessionNormalization.js";
import { completeNextSessionAttention, deleteSessionAttention } from "../../sessionAttention.js";
import type {
  PeonSession,
  ProjectSessionCount,
  SessionIndexRow,
  SessionSyncCheckpoint,
} from "./sessionTypes.js";
import { markTranscriptDeleted } from "./transcriptProjection.js";

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
  completion?: { workspaceId: string; peonId: string; sessionId: string; completedAt: number };
}

interface ProjectIdentity {
  projectId: string | null;
  projectKey: string | null;
}

async function projectSessionCounts(
  tx: Transaction,
  peonId: string,
  identities: ProjectIdentity[],
): Promise<ProjectSessionCount[]> {
  const unique = new Map<string, ProjectIdentity>();
  for (const identity of identities) {
    if (!identity.projectKey) continue;
    unique.set(identity.projectId ? `id:${identity.projectId}` : `key:${identity.projectKey}`, identity);
  }
  const counts: ProjectSessionCount[] = [];
  for (const identity of unique.values()) {
    const params = identity.projectId
      ? [peonId, identity.projectId]
      : [peonId, identity.projectKey];
    const where = identity.projectId
      ? "peon_id=$1 AND project_id=$2"
      : "peon_id=$1 AND project_id IS NULL AND project_key=$2";
    const result = await tx.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM sessions WHERE ${where}`,
      params,
    );
    counts.push({
      projectId: identity.projectId,
      projectKey: identity.projectKey!,
      sessionCount: Number(result.rows[0]?.count ?? 0),
    });
  }
  return counts;
}

async function storeSession(tx: Transaction, workspaceId: string, peonId: string, s: PeonSession): Promise<StoredMutation> {
  const summary = normalizeSessionSummary(s);
  const previous = await tx.query<{
    status: string | null;
    project_id: string | null;
    project_key: string | null;
    last_activity_at: number | null;
    ended_at: number | null;
  }>(
    `SELECT status, project_id, project_key, last_activity_at, ended_at FROM sessions WHERE peon_id=$1 AND session_id=$2`,
    [peonId, summary.id],
  );
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
    const before = previous.rows[0];
    const counts = await projectSessionCounts(tx, peonId, [
      { projectId: before?.project_id ?? null, projectKey: before?.project_key ?? null },
      { projectId: row.projectId, projectKey: row.projectKey },
    ]);
    const event = await insertEvent(tx, {
      workspaceId,
      peonId,
      sessionId: row.sessionId,
      kind: "session",
      payload: { ...row, projectSessionCounts: counts },
    });
    const terminalAt = row.endedAt ?? row.lastActivityAt ?? row.syncedAt;
    const previousTerminalAt = before?.ended_at ?? before?.last_activity_at ?? 0;
    const completedRun = row.status === "completed"
      && (before?.status !== "completed" || terminalAt > previousTerminalAt);
    return {
      event,
      fingerprintKey: key,
      fingerprint: fp,
      ...(completedRun ? { completion: { workspaceId, peonId, sessionId: row.sessionId, completedAt: terminalAt } } : {}),
    };
  }
  return { event: null };
}

// A finished run turns the requesting user's pending attention row unread, which
// is what paints the "needs your eyes" edge in the sidebar. Every publisher must
// run this — the projection is the only place that sees the completed transition.
async function completeAttention(completion: NonNullable<StoredMutation["completion"]>): Promise<void> {
  const { workspaceId, peonId, sessionId, completedAt } = completion;
  await completeNextSessionAttention(workspaceId, peonId, sessionId, completedAt).catch((error) => {
    console.warn("session attention completion failed:", error instanceof Error ? error.message : String(error));
  });
}

async function publishMutation(mutation: StoredMutation): Promise<void> {
  if (mutation.event) {
    await publishCommittedEvent(mutation.event);
    if (mutation.deletedKey) fingerprints.delete(mutation.deletedKey);
    else if (mutation.fingerprintKey && mutation.fingerprint) fingerprints.set(mutation.fingerprintKey, mutation.fingerprint);
  }
  if (mutation.completion) await completeAttention(mutation.completion);
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
  const deleted = await tx.query<{ session_id: string; project_id: string | null; project_key: string | null }>(
    `DELETE FROM sessions WHERE peon_id = $1 AND session_id = $2${versionGuard} RETURNING session_id,project_id,project_key`,
    params,
  );
  if (!deleted.rows[0]) return { event: null };
  await markTranscriptDeleted(tx, peonId, sessionId);
  const projectCounts = await projectSessionCounts(tx, peonId, [{
    projectId: deleted.rows[0].project_id,
    projectKey: deleted.rows[0].project_key,
  }]);

  const event = await insertEvent(tx, {
    workspaceId,
    peonId,
    sessionId,
    kind: "session",
    payload: { peonId, sessionId, deleted: true, syncedAt, projectSessionCounts: projectCounts },
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
  if (mutation.event) await deleteSessionAttention(peonId, sessionId).catch(() => undefined);
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
    if (mutation.completion) await completeAttention(mutation.completion);
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
    // A committed snapshot from a newer catalog epoch supersedes every queued
    // event owned by the retired epoch. Commit only its shared delivery cursor;
    // never apply it to the new projection or move the new catalog checkpoint.
    if (checkpoint.catalog_epoch === input.catalogEpoch && input.seq > Number(checkpoint.acknowledged_seq)) {
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
