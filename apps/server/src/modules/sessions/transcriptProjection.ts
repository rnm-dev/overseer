import { Buffer } from "node:buffer";
import { query, transaction, type Transaction } from "../../infrastructure/db/index.js";
import { insertEvent, publishCommittedEvent, type LiveEvent } from "../../eventLog.js";

export const TRANSCRIPT_SESSION_EVENT_LIMIT = 20_000;
export const TRANSCRIPT_SESSION_BYTE_LIMIT = 16 * 1024 * 1024;
export const TRANSCRIPT_GLOBAL_EVENT_LIMIT = 50_000;
export const TRANSCRIPT_GLOBAL_BYTE_LIMIT = 256 * 1024 * 1024;

export type TranscriptFreshnessState =
  | "ready"
  | "syncing"
  | "stale"
  | "offline"
  | "gap"
  | "evicted";

export interface TranscriptEnvelope {
  seq: number;
  eventId: string;
  event: Record<string, unknown>;
}

export interface TranscriptState {
  peonId: string;
  sessionId: string;
  workspaceId: string;
  epoch: string | null;
  acknowledgedSeq: number | null;
  revision: number | null;
  barrierSeq: number | null;
  status: TranscriptFreshnessState;
  generation: string | null;
  eventCount: number;
  bodyBytes: number;
  updatedAt: number;
  lastAccessedAt: number;
}

export interface TranscriptPage {
  events: Record<string, unknown>[];
  nextCursor: string | null;
  hasMore: boolean;
  freshness: {
    state: TranscriptFreshnessState;
    updatedAt: number;
    epoch: string | null;
    revision: number | null;
    barrierSeq: number | null;
  };
}

export interface TranscriptDeliveryCheckpoint {
  delivery: { epoch: string; acknowledgedCursor: string };
  transcript: { epoch: string; acknowledgedSeq: number };
  browserEvent: LiveEvent | null;
}

export class TranscriptProjectionError extends Error {
  constructor(
    public readonly code:
      | "TRANSCRIPT_GAP"
      | "TRANSCRIPT_EPOCH_CHANGED"
      | "TRANSCRIPT_NOT_READY"
      | "STALE_GENERATION"
      | "REPLAY_MISMATCH"
      | "BAD_CURSOR",
    message: string,
  ) {
    super(message);
  }
}

interface StateRow {
  peon_id: string;
  session_id: string;
  workspace_id: string;
  transcript_epoch: string | null;
  acknowledged_seq: number | string | null;
  revision: number | string | null;
  barrier_seq: number | string | null;
  status: string;
  generation: string | null;
  event_count: number | string;
  body_bytes: number | string;
  updated_at: number | string;
  last_accessed_at: number | string;
}

function rowToState(row: StateRow): TranscriptState {
  return {
    peonId: row.peon_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    epoch: row.transcript_epoch,
    acknowledgedSeq: row.acknowledged_seq === null ? null : Number(row.acknowledged_seq),
    revision: row.revision === null ? null : Number(row.revision),
    barrierSeq: row.barrier_seq === null ? null : Number(row.barrier_seq),
    status: row.status as TranscriptFreshnessState,
    generation: row.generation,
    eventCount: Number(row.event_count),
    bodyBytes: Number(row.body_bytes),
    updatedAt: Number(row.updated_at),
    lastAccessedAt: Number(row.last_accessed_at),
  };
}

const stateColumns = `peon_id,session_id,workspace_id,transcript_epoch,acknowledged_seq,
  revision,barrier_seq,status,generation,event_count,body_bytes,updated_at,last_accessed_at`;

export async function getTranscriptState(peonId: string, sessionId: string): Promise<TranscriptState | null> {
  const { rows } = await query<StateRow>(
    `SELECT ${stateColumns} FROM peon_transcript_sync WHERE peon_id=$1 AND session_id=$2`,
    [peonId, sessionId],
  );
  return rows[0] ? rowToState(rows[0]) : null;
}

export async function claimTranscriptGeneration(input: {
  workspaceId: string;
  peonId: string;
  sessionId: string;
  generation: string;
}): Promise<TranscriptState> {
  const now = Date.now();
  return transaction(async (tx) => {
    const shared = await tx.query(
      `SELECT 1 FROM peon_session_sync WHERE peon_id=$1 AND generation=$2 FOR UPDATE`,
      [input.peonId, input.generation],
    );
    if (!shared.rows[0]) {
      throw new TranscriptProjectionError("STALE_GENERATION", "session sync connection was replaced");
    }
    const { rows } = await tx.query<StateRow>(
      `INSERT INTO peon_transcript_sync
         (peon_id,session_id,workspace_id,status,generation,updated_at,last_accessed_at)
       VALUES ($1,$2,$3,'syncing',$4,$5,$5)
       ON CONFLICT (peon_id,session_id) DO UPDATE SET
         workspace_id=EXCLUDED.workspace_id,
         generation=EXCLUDED.generation,
         status=CASE
           WHEN peon_transcript_sync.transcript_epoch IS NULL THEN 'syncing'
           WHEN peon_transcript_sync.status='evicted' THEN 'evicted'
           ELSE 'ready'
         END,
         updated_at=EXCLUDED.updated_at,
         last_accessed_at=EXCLUDED.last_accessed_at
       RETURNING ${stateColumns}`,
      [input.peonId, input.sessionId, input.workspaceId, input.generation, now],
    );
    return rowToState(rows[0]!);
  });
}

export async function markTranscriptSyncState(input: {
  peonId: string;
  sessionId: string;
  generation: string;
  status: Extract<TranscriptFreshnessState, "syncing" | "gap">;
}): Promise<void> {
  await transaction(async (tx) => {
    await assertGeneration(tx, input.peonId, input.sessionId, input.generation);
    await tx.query(
      `UPDATE peon_transcript_sync SET status=$4,updated_at=$5,last_accessed_at=$5
       WHERE peon_id=$1 AND session_id=$2 AND generation=$3`,
      [input.peonId, input.sessionId, input.generation, input.status, Date.now()],
    );
  });
}

export async function releaseTranscriptGeneration(peonId: string, generation: string): Promise<void> {
  await query(
    `UPDATE peon_transcript_sync
       SET status=CASE WHEN transcript_epoch IS NULL THEN 'syncing' WHEN status='evicted' THEN 'evicted' ELSE 'stale' END,
           generation=NULL,updated_at=$3
     WHERE peon_id=$1 AND generation=$2`,
    [peonId, generation, Date.now()],
  );
}

async function assertGeneration(tx: Transaction, peonId: string, sessionId: string, generation: string): Promise<void> {
  const delivery = await tx.query(
    `SELECT 1 FROM peon_session_sync WHERE peon_id=$1 AND generation=$2 FOR UPDATE`,
    [peonId, generation],
  );
  if (!delivery.rows[0]) {
    throw new TranscriptProjectionError("STALE_GENERATION", "session sync connection was replaced");
  }
  const transcript = await tx.query(
    `SELECT 1 FROM peon_transcript_sync
      WHERE peon_id=$1 AND session_id=$2 AND generation=$3 FOR UPDATE`,
    [peonId, sessionId, generation],
  );
  if (!transcript.rows[0]) {
    throw new TranscriptProjectionError("STALE_GENERATION", "transcript sync connection was replaced");
  }
}

function normalizedEvent(envelope: TranscriptEnvelope): Record<string, unknown> {
  const existing = envelope.event.eventId;
  if (existing !== undefined && existing !== envelope.eventId) {
    throw new TranscriptProjectionError("REPLAY_MISMATCH", "transcript event identity mismatch");
  }
  return normalizeTranscriptValue({
    ...envelope.event,
    eventId: envelope.eventId,
  }) as Record<string, unknown>;
}

function normalizeTranscriptValue(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll("\0", "\uFFFD");
  if (Array.isArray(value)) return value.map(normalizeTranscriptValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key.replaceAll("\0", "\uFFFD"),
      normalizeTranscriptValue(nested),
    ]),
  );
}

function eventBytes(event: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(event));
}

function canonicalPayload(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalPayload(object[key])}`)
    .join(",")}}`;
}

export async function commitTranscriptSnapshot(input: {
  workspaceId: string;
  peonId: string;
  sessionId: string;
  generation: string;
  epoch: string;
  revision: number;
  barrierSeq: number;
  events: TranscriptEnvelope[];
}): Promise<void> {
  const normalized = input.events.map((envelope) => ({
    ...envelope,
    event: normalizedEvent(envelope),
  }));
  const ids = new Set<string>();
  let expectedSeq = 1;
  let bytes = 0;
  for (const envelope of normalized) {
    if (ids.has(envelope.eventId)) throw new TranscriptProjectionError("REPLAY_MISMATCH", "duplicate transcript event identity");
    if (envelope.seq !== expectedSeq) {
      throw new TranscriptProjectionError("TRANSCRIPT_GAP", "snapshot transcript sequence is not contiguous");
    }
    ids.add(envelope.eventId);
    expectedSeq += 1;
    bytes += eventBytes(envelope.event);
  }
  if (input.barrierSeq !== normalized.length || input.revision !== input.barrierSeq) {
    throw new TranscriptProjectionError("TRANSCRIPT_GAP", "snapshot transcript barrier is incomplete");
  }
  if (normalized.length > TRANSCRIPT_SESSION_EVENT_LIMIT || bytes > TRANSCRIPT_SESSION_BYTE_LIMIT) {
    throw new TranscriptProjectionError("TRANSCRIPT_NOT_READY", "transcript snapshot exceeds projection bounds");
  }
  const now = Date.now();
  await transaction(async (tx) => {
    await assertGeneration(tx, input.peonId, input.sessionId, input.generation);
    await tx.query(`DELETE FROM transcript_events WHERE peon_id=$1 AND session_id=$2`, [input.peonId, input.sessionId]);
    for (const envelope of normalized) {
      await tx.query(
        `INSERT INTO transcript_events
           (peon_id,session_id,transcript_epoch,seq,event_id,payload,body_bytes,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          input.peonId,
          input.sessionId,
          input.epoch,
          envelope.seq,
          envelope.eventId,
          JSON.stringify(envelope.event),
          eventBytes(envelope.event),
          now,
        ],
      );
    }
    const updated = await tx.query(
      `UPDATE peon_transcript_sync SET
         transcript_epoch=$4,acknowledged_seq=$5,revision=$6,barrier_seq=$5,
         status='ready',event_count=$7,body_bytes=$8,updated_at=$9,last_accessed_at=$9
       WHERE peon_id=$1 AND session_id=$2 AND generation=$3 RETURNING peon_id`,
      [
        input.peonId,
        input.sessionId,
        input.generation,
        input.epoch,
        input.barrierSeq,
        input.revision,
        normalized.length,
        bytes,
        now,
      ],
    );
    if (!updated.rows[0]) throw new TranscriptProjectionError("STALE_GENERATION", "transcript sync connection was replaced");
  });
}

async function insertInbox(tx: Transaction, input: {
  peonId: string;
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
}): Promise<boolean> {
  const inserted = await tx.query(
    `INSERT INTO peon_session_inbox (peon_id,epoch,cursor,created_at,message_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING cursor`,
    [input.peonId, input.deliveryEpoch, input.deliveryCursor, Date.now(), input.messageId],
  );
  if (inserted.rows[0]) return true;
  const replay = await tx.query<{ epoch: string; cursor: string; message_id: string | null }>(
    `SELECT epoch,cursor,message_id FROM peon_session_inbox
     WHERE peon_id=$1 AND ((epoch=$2 AND cursor=$3) OR message_id=$4)`,
    [input.peonId, input.deliveryEpoch, input.deliveryCursor, input.messageId],
  );
  const row = replay.rows[0];
  if (!row || row.epoch !== input.deliveryEpoch || row.cursor !== input.deliveryCursor || row.message_id !== input.messageId) {
    throw new TranscriptProjectionError("REPLAY_MISMATCH", "durable message replay identity mismatch");
  }
  return false;
}

async function inboxReplay(tx: Transaction, input: {
  peonId: string;
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
}): Promise<boolean> {
  const replay = await tx.query<{ epoch: string; cursor: string; message_id: string | null }>(
    `SELECT epoch,cursor,message_id FROM peon_session_inbox
     WHERE peon_id=$1 AND ((epoch=$2 AND cursor=$3) OR message_id=$4)`,
    [input.peonId, input.deliveryEpoch, input.deliveryCursor, input.messageId],
  );
  const row = replay.rows[0];
  if (!row) return false;
  if (row.epoch !== input.deliveryEpoch || row.cursor !== input.deliveryCursor || row.message_id !== input.messageId) {
    throw new TranscriptProjectionError("REPLAY_MISMATCH", "durable message replay identity mismatch");
  }
  return true;
}

async function sharedDeliveryCheckpoint(tx: Transaction, peonId: string, generation: string): Promise<{
  epoch: string | null;
  cursor: string | null;
}> {
  const current = await tx.query<{ delivery_epoch: string | null; acknowledged_cursor: string | null }>(
    `SELECT delivery_epoch,acknowledged_cursor FROM peon_session_sync WHERE peon_id=$1 AND generation=$2`,
    [peonId, generation],
  );
  if (!current.rows[0]) throw new TranscriptProjectionError("STALE_GENERATION", "session sync connection was replaced");
  return { epoch: current.rows[0].delivery_epoch, cursor: current.rows[0].acknowledged_cursor };
}

async function advanceSharedDelivery(tx: Transaction, input: {
  peonId: string;
  generation: string;
  deliveryEpoch: string;
  deliveryCursor: string;
}): Promise<void> {
  const updated = await tx.query(
    `UPDATE peon_session_sync SET delivery_epoch=$3,acknowledged_cursor=$4,updated_at=$5
     WHERE peon_id=$1 AND generation=$2 RETURNING peon_id`,
    [input.peonId, input.generation, input.deliveryEpoch, input.deliveryCursor, Date.now()],
  );
  if (!updated.rows[0]) throw new TranscriptProjectionError("STALE_GENERATION", "session sync connection was replaced");
}

export async function commitTranscriptEvent(input: {
  workspaceId: string;
  peonId: string;
  sessionId: string;
  generation: string;
  transcriptEpoch: string;
  seq: number;
  revision: number;
  eventId: string;
  event: Record<string, unknown>;
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
}): Promise<TranscriptDeliveryCheckpoint> {
  if (input.revision !== input.seq) {
    throw new TranscriptProjectionError("TRANSCRIPT_GAP", "transcript event revision does not match its sequence");
  }
  const event = normalizedEvent({ seq: input.seq, eventId: input.eventId, event: input.event });
  const bytes = eventBytes(event);
  if (bytes > TRANSCRIPT_SESSION_BYTE_LIMIT) {
    throw new TranscriptProjectionError("TRANSCRIPT_NOT_READY", "transcript event exceeds projection bounds");
  }
  const result = await transaction(async (tx) => {
    await assertGeneration(tx, input.peonId, input.sessionId, input.generation);
    const state = await tx.query<{
      transcript_epoch: string | null;
      acknowledged_seq: number | string | null;
      event_count: number | string;
      body_bytes: number | string;
    }>(
      `SELECT transcript_epoch,acknowledged_seq,event_count,body_bytes FROM peon_transcript_sync
       WHERE peon_id=$1 AND session_id=$2 AND generation=$3`,
      [input.peonId, input.sessionId, input.generation],
    );
    const row = state.rows[0]!;
    if (await inboxReplay(tx, input)) {
      const existing = await tx.query<{ event_id: string; payload: Record<string, unknown> }>(
        `SELECT event_id,payload FROM transcript_events
         WHERE peon_id=$1 AND session_id=$2 AND transcript_epoch=$3 AND seq=$4`,
        [input.peonId, input.sessionId, input.transcriptEpoch, input.seq],
      );
      if (!existing.rows[0]
        || existing.rows[0].event_id !== input.eventId
        || canonicalPayload(existing.rows[0].payload) !== canonicalPayload(event)) {
        throw new TranscriptProjectionError("REPLAY_MISMATCH", "durable transcript replay payload mismatch");
      }
      const delivery = await sharedDeliveryCheckpoint(tx, input.peonId, input.generation);
      return {
        delivery: {
          epoch: delivery.epoch ?? input.deliveryEpoch,
          acknowledgedCursor: delivery.cursor ?? input.deliveryCursor,
        },
        transcript: {
          epoch: row.transcript_epoch ?? input.transcriptEpoch,
          acknowledgedSeq: Number(row.acknowledged_seq ?? 0),
        },
        browserEvent: null,
      };
    }
    if (!row.transcript_epoch || row.acknowledged_seq === null) {
      throw new TranscriptProjectionError("TRANSCRIPT_NOT_READY", "transcript event arrived before snapshot");
    }
    if (row.transcript_epoch !== input.transcriptEpoch) {
      throw new TranscriptProjectionError("TRANSCRIPT_EPOCH_CHANGED", "transcript epoch changed");
    }
    if (input.seq !== Number(row.acknowledged_seq) + 1) {
      throw new TranscriptProjectionError("TRANSCRIPT_GAP", "transcript event sequence gap");
    }
    if (Number(row.event_count) + 1 > TRANSCRIPT_SESSION_EVENT_LIMIT
      || Number(row.body_bytes) + bytes > TRANSCRIPT_SESSION_BYTE_LIMIT) {
      throw new TranscriptProjectionError("TRANSCRIPT_NOT_READY", "transcript projection requires rebuild");
    }
    const freshInbox = await insertInbox(tx, input);
    if (!freshInbox) throw new TranscriptProjectionError("REPLAY_MISMATCH", "concurrent durable transcript replay");
    await tx.query(
      `INSERT INTO transcript_events
         (peon_id,session_id,transcript_epoch,seq,event_id,payload,body_bytes,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.peonId,
        input.sessionId,
        input.transcriptEpoch,
        input.seq,
        input.eventId,
        JSON.stringify(event),
        bytes,
        Date.now(),
      ],
    );
    const project = await tx.query<{ project_key: string | null; project_id: string | null }>(
      `SELECT project_key,project_id FROM sessions WHERE peon_id=$1 AND session_id=$2`,
      [input.peonId, input.sessionId],
    );
    const browserEvent = await insertEvent(tx, {
      workspaceId: input.workspaceId,
      peonId: input.peonId,
      sessionId: input.sessionId,
      kind: "transcript",
      payload: {
        sessionId: input.sessionId,
        eventId: input.eventId,
        event,
        projectKey: project.rows[0]?.project_key ?? null,
        projectId: project.rows[0]?.project_id ?? null,
      },
    });
    const updated = await tx.query(
      `UPDATE peon_transcript_sync SET acknowledged_seq=$4,revision=$5,
         event_count=event_count+1,body_bytes=body_bytes+$6,status='ready',
         updated_at=$7,last_accessed_at=$7
       WHERE peon_id=$1 AND session_id=$2 AND generation=$3 RETURNING peon_id`,
      [input.peonId, input.sessionId, input.generation, input.seq, input.revision, bytes, Date.now()],
    );
    if (!updated.rows[0]) throw new TranscriptProjectionError("STALE_GENERATION", "transcript sync connection was replaced");
    await advanceSharedDelivery(tx, input);
    return {
      delivery: { epoch: input.deliveryEpoch, acknowledgedCursor: input.deliveryCursor },
      transcript: { epoch: input.transcriptEpoch, acknowledgedSeq: input.seq },
      browserEvent,
    };
  });
  if (result.browserEvent) {
    await publishCommittedEvent(result.browserEvent).catch((error) => {
      console.warn("transcript browser event fan-out failed:", error instanceof Error ? error.message : String(error));
    });
  }
  return result;
}

export async function commitSnapshotCoveredTranscriptEvent(input: {
  peonId: string;
  sessionId: string;
  generation: string;
  transcriptEpoch: string;
  seq: number;
  eventId: string;
  event: Record<string, unknown>;
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
}): Promise<TranscriptDeliveryCheckpoint> {
  const event = normalizedEvent({
    seq: input.seq,
    eventId: input.eventId,
    event: input.event,
  });
  return transaction(async (tx) => {
    await assertGeneration(tx, input.peonId, input.sessionId, input.generation);
    const state = await tx.query<{
      transcript_epoch: string | null;
      acknowledged_seq: number | string | null;
    }>(
      `SELECT transcript_epoch,acknowledged_seq FROM peon_transcript_sync
       WHERE peon_id=$1 AND session_id=$2 AND generation=$3`,
      [input.peonId, input.sessionId, input.generation],
    );
    const row = state.rows[0]!;
    if (!row.transcript_epoch || row.acknowledged_seq === null) {
      throw new TranscriptProjectionError("TRANSCRIPT_NOT_READY", "covered transcript event has no snapshot");
    }
    if (row.transcript_epoch === input.transcriptEpoch && input.seq > Number(row.acknowledged_seq)) {
      throw new TranscriptProjectionError("TRANSCRIPT_GAP", "transcript event is not covered by the snapshot");
    }
    const projected = await tx.query<{ event_id: string; payload: Record<string, unknown> }>(
      `SELECT event_id,payload FROM transcript_events
       WHERE peon_id=$1 AND session_id=$2 AND transcript_epoch=$3 AND seq=$4`,
      [input.peonId, input.sessionId, input.transcriptEpoch, input.seq],
    );
    if (!projected.rows[0]
      || projected.rows[0].event_id !== input.eventId
      || canonicalPayload(projected.rows[0].payload) !== canonicalPayload(event)) {
      throw new TranscriptProjectionError(
        "REPLAY_MISMATCH",
        "snapshot-covered transcript event does not match the committed projection",
      );
    }
    const fresh = await insertInbox(tx, input);
    if (fresh) await advanceSharedDelivery(tx, input);
    const delivery = fresh
      ? { epoch: input.deliveryEpoch, acknowledgedCursor: input.deliveryCursor }
      : await sharedDeliveryCheckpoint(tx, input.peonId, input.generation).then((checkpoint) => ({
        epoch: checkpoint.epoch ?? input.deliveryEpoch,
        acknowledgedCursor: checkpoint.cursor ?? input.deliveryCursor,
      }));
    return {
      delivery,
      transcript: { epoch: row.transcript_epoch, acknowledgedSeq: Number(row.acknowledged_seq) },
      browserEvent: null,
    };
  });
}

export async function commitTranscriptDeletion(input: {
  workspaceId: string;
  peonId: string;
  sessionId: string;
  generation: string;
  transcriptEpoch: string;
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
}): Promise<TranscriptDeliveryCheckpoint> {
  const result = await transaction(async (tx) => {
    await assertGeneration(tx, input.peonId, input.sessionId, input.generation);
    const fresh = await insertInbox(tx, input);
    if (!fresh) {
      const delivery = await sharedDeliveryCheckpoint(tx, input.peonId, input.generation);
      return {
        delivery: {
          epoch: delivery.epoch ?? input.deliveryEpoch,
          acknowledgedCursor: delivery.cursor ?? input.deliveryCursor,
        },
        transcript: { epoch: input.transcriptEpoch, acknowledgedSeq: 0 },
        browserEvent: null,
      };
    }
    const project = await tx.query<{ project_key: string | null; project_id: string | null }>(
      `SELECT project_key,project_id FROM sessions WHERE peon_id=$1 AND session_id=$2`,
      [input.peonId, input.sessionId],
    );
    await tx.query(`DELETE FROM transcript_events WHERE peon_id=$1 AND session_id=$2`, [input.peonId, input.sessionId]);
    await tx.query(`DELETE FROM peon_transcript_sync WHERE peon_id=$1 AND session_id=$2 AND generation=$3`, [
      input.peonId,
      input.sessionId,
      input.generation,
    ]);
    const browserEvent = await insertEvent(tx, {
      workspaceId: input.workspaceId,
      peonId: input.peonId,
      sessionId: input.sessionId,
      kind: "transcript",
      payload: {
        sessionId: input.sessionId,
        deleted: true,
        projectKey: project.rows[0]?.project_key ?? null,
        projectId: project.rows[0]?.project_id ?? null,
      },
    });
    await advanceSharedDelivery(tx, input);
    return {
      delivery: { epoch: input.deliveryEpoch, acknowledgedCursor: input.deliveryCursor },
      transcript: { epoch: input.transcriptEpoch, acknowledgedSeq: 0 },
      browserEvent,
    };
  });
  if (result.browserEvent) {
    await publishCommittedEvent(result.browserEvent).catch((error) => {
      console.warn("transcript deletion fan-out failed:", error instanceof Error ? error.message : String(error));
    });
  }
  return result;
}

interface CursorPayload {
  v: 1;
  peonId: string;
  sessionId: string;
  epoch: string;
  before: number;
}

function encodeCursor(cursor: CursorPayload): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string, peonId: string, sessionId: string, epoch: string): CursorPayload {
  try {
    if (!cursor || cursor.length > 2_000) throw new Error();
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (parsed.v !== 1
      || parsed.peonId !== peonId
      || parsed.sessionId !== sessionId
      || parsed.epoch !== epoch
      || !Number.isSafeInteger(parsed.before)
      || Number(parsed.before) < 0) throw new Error();
    return parsed as CursorPayload;
  } catch {
    throw new TranscriptProjectionError("BAD_CURSOR", "invalid transcript cursor");
  }
}

export async function readTranscriptPage(input: {
  peonId: string;
  sessionId: string;
  limit: number;
  cursor?: string;
  online: boolean;
}): Promise<TranscriptPage | null> {
  const state = await getTranscriptState(input.peonId, input.sessionId);
  if (!state?.epoch || state.status === "evicted") return null;
  const limit = Math.min(500, Math.max(1, input.limit));
  const cursor = input.cursor
    ? decodeCursor(input.cursor, input.peonId, input.sessionId, state.epoch)
    : null;
  const params: unknown[] = [input.peonId, input.sessionId, state.epoch];
  const before = cursor ? ` AND seq < $${params.push(cursor.before)}` : "";
  params.push(limit + 1);
  const rows = await query<{ seq: number | string; payload: Record<string, unknown> }>(
    `SELECT seq,payload FROM transcript_events
     WHERE peon_id=$1 AND session_id=$2 AND transcript_epoch=$3${before}
     ORDER BY seq DESC LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.rows.length > limit;
  const selected = rows.rows.slice(0, limit);
  const oldest = selected[selected.length - 1];
  const activeState: TranscriptFreshnessState = input.online ? state.status : "offline";
  await query(
    `UPDATE peon_transcript_sync SET last_accessed_at=$3 WHERE peon_id=$1 AND session_id=$2`,
    [input.peonId, input.sessionId, Date.now()],
  );
  return {
    events: selected.reverse().map((row) => row.payload),
    nextCursor: hasMore && oldest
      ? encodeCursor({
        v: 1,
        peonId: input.peonId,
        sessionId: input.sessionId,
        epoch: state.epoch,
        before: Number(oldest.seq),
      })
      : null,
    hasMore,
    freshness: {
      state: activeState,
      updatedAt: state.updatedAt,
      epoch: state.epoch,
      revision: state.revision,
      barrierSeq: state.barrierSeq,
    },
  };
}

// One transcript page's worth, matching what a client's opening snapshot holds.
export const TRANSCRIPT_UNKNOWN_BOUNDARY_REPLAY = 50;

async function newestTranscriptWindow(
  peonId: string,
  sessionId: string,
  epoch: string,
): Promise<Record<string, unknown>[]> {
  const rows = await query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM transcript_events
     WHERE peon_id=$1 AND session_id=$2 AND transcript_epoch=$3
     ORDER BY seq DESC LIMIT $4`,
    [peonId, sessionId, epoch, TRANSCRIPT_UNKNOWN_BOUNDARY_REPLAY],
  );
  return rows.rows.reverse().map((row) => row.payload);
}

export async function readTranscriptAfter(input: {
  peonId: string;
  sessionId: string;
  lastEventId?: string | null;
}): Promise<Record<string, unknown>[]> {
  const state = await getTranscriptState(input.peonId, input.sessionId);
  if (!state?.epoch || state.status === "evicted") return [];
  let afterSeq = -1;
  if (input.lastEventId) {
    const found = await query<{ seq: number | string }>(
      `SELECT seq FROM transcript_events WHERE peon_id=$1 AND session_id=$2 AND event_id=$3`,
      [input.peonId, input.sessionId, input.lastEventId],
    );
    // A boundary this projection does not hold cannot prove a suffix — it may
    // have been evicted, or belong to another session entirely. Replaying the
    // whole retained transcript to find out costs megabytes and re-delivers
    // history the caller already reads in bounded pages, so answer with a
    // bounded newest window instead: it re-anchors a caller whose boundary was
    // merely evicted, and one that already holds that page drops every row by
    // eventId. Older history stays reachable through transcript pagination.
    if (!found.rows[0]) return await newestTranscriptWindow(input.peonId, input.sessionId, state.epoch);
    afterSeq = Number(found.rows[0].seq);
  }
  const rows = await query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM transcript_events
     WHERE peon_id=$1 AND session_id=$2 AND transcript_epoch=$3 AND seq>$4
     ORDER BY seq ASC LIMIT $5`,
    [input.peonId, input.sessionId, state.epoch, afterSeq, TRANSCRIPT_SESSION_EVENT_LIMIT],
  );
  return rows.rows.map((row) => row.payload);
}

export async function markTranscriptDeleted(tx: Transaction, peonId: string, sessionId: string): Promise<void> {
  await tx.query(`DELETE FROM transcript_events WHERE peon_id=$1 AND session_id=$2`, [peonId, sessionId]);
  await tx.query(`DELETE FROM peon_transcript_sync WHERE peon_id=$1 AND session_id=$2`, [peonId, sessionId]);
}

export async function pruneTranscriptProjection(
  eventLimit = TRANSCRIPT_GLOBAL_EVENT_LIMIT,
  byteLimit = TRANSCRIPT_GLOBAL_BYTE_LIMIT,
): Promise<number> {
  const totals = await query<{ events: number | string; bytes: number | string }>(
    `SELECT COALESCE(SUM(event_count),0) AS events,COALESCE(SUM(body_bytes),0) AS bytes
     FROM peon_transcript_sync WHERE status<>'evicted'`,
  );
  let events = Number(totals.rows[0]?.events ?? 0);
  let bytes = Number(totals.rows[0]?.bytes ?? 0);
  if (events <= eventLimit && bytes <= byteLimit) return 0;
  const candidates = await query<{
    peon_id: string; session_id: string; event_count: number | string; body_bytes: number | string;
  }>(
    `SELECT peon_id,session_id,event_count,body_bytes FROM peon_transcript_sync
     WHERE status<>'syncing' AND status<>'gap' AND status<>'evicted'
     ORDER BY last_accessed_at ASC`,
  );
  let evicted = 0;
  for (const candidate of candidates.rows) {
    if (events <= eventLimit && bytes <= byteLimit) break;
    await transaction(async (tx) => {
      await tx.query(`DELETE FROM transcript_events WHERE peon_id=$1 AND session_id=$2`, [candidate.peon_id, candidate.session_id]);
      await tx.query(
        `UPDATE peon_transcript_sync SET status='evicted',event_count=0,body_bytes=0,updated_at=$3
         WHERE peon_id=$1 AND session_id=$2`,
        [candidate.peon_id, candidate.session_id, Date.now()],
      );
    });
    events -= Number(candidate.event_count);
    bytes -= Number(candidate.body_bytes);
    evicted += 1;
  }
  return evicted;
}
