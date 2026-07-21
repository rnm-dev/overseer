import { EventEmitter } from "node:events";
import { query, type Transaction } from "./db.js";
import { enqueuePushForEvent } from "./push.js";

// The append-only event log — the single choke point that both persists a
// resumable, ordered stream (global `cursor`) and fans out live to connected WS
// clients via `bus`. Everything session/peon-shaped that changes flows through
// appendEvent(): it writes a row, then emits it. liveSocket.ts is the consumer.
// author: Viktor

export type EventKind = "session" | "project" | "peon";

export interface LiveEvent {
  cursor: number;
  workspaceId: string;
  peonId: string;
  sessionId: string | null;
  kind: EventKind;
  payload: unknown;
  createdAt: number;
}

// One process-wide bus; every WS connection adds a listener, so lift the cap.
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export interface AppendInput {
  workspaceId: string;
  peonId: string;
  sessionId?: string | null;
  kind: EventKind;
  payload: unknown;
}

type EventWriter = Pick<Transaction, "query">;

export async function insertEvent(writer: EventWriter, e: AppendInput): Promise<LiveEvent> {
  const createdAt = Date.now();
  const { rows } = await writer.query<{ cursor: string }>(
    `INSERT INTO events (workspace_id, peon_id, session_id, kind, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING cursor`,
    [e.workspaceId, e.peonId, e.sessionId ?? null, e.kind, JSON.stringify(e.payload), createdAt],
  );
  const event: LiveEvent = {
    cursor: Number(rows[0].cursor),
    workspaceId: e.workspaceId,
    peonId: e.peonId,
    sessionId: e.sessionId ?? null,
    kind: e.kind,
    payload: e.payload,
    createdAt,
  };
  return event;
}

export async function publishCommittedEvent(event: LiveEvent): Promise<void> {
  bus.emit("event", event);
  await enqueuePushForEvent(event);
}

export async function appendEvent(e: AppendInput): Promise<LiveEvent> {
  const event = await insertEvent({ query }, e);
  await publishCommittedEvent(event);
  return event;
}

// Live-only broadcast (no DB row, `cursor: 0`) — for high-frequency liveness like
// heartbeats. A reconnecting client re-derives this from the snapshot, so it never
// needs replay; persisting it would just bloat the log. Clients must not advance
// their resume cursor on a `cursor: 0` event.
export function broadcast(e: AppendInput): void {
  bus.emit("event", {
    cursor: 0,
    workspaceId: e.workspaceId,
    peonId: e.peonId,
    sessionId: e.sessionId ?? null,
    kind: e.kind,
    payload: e.payload,
    createdAt: Date.now(),
  } satisfies LiveEvent);
}

// Replay for a reconnecting client: events in this workspace newer than `cursor`.
// `throughCursor` freezes a replay window so a busy workspace cannot keep extending
// the query forever while the caller paginates toward a moving high-water mark.
export async function readEventsSince(workspaceId: string, cursor: number, limit = 1000, throughCursor = Number.MAX_SAFE_INTEGER): Promise<LiveEvent[]> {
  const { rows } = await query<{ cursor: string; peon_id: string; session_id: string | null; kind: EventKind; payload: unknown; created_at: string }>(
    `SELECT cursor, peon_id, session_id, kind, payload, created_at
       FROM events WHERE workspace_id = $1 AND cursor > $2 AND cursor <= $3 ORDER BY cursor ASC LIMIT $4`,
    [workspaceId, cursor, throughCursor, limit],
  );
  return rows.map((r) => ({
    cursor: Number(r.cursor),
    workspaceId,
    peonId: r.peon_id,
    sessionId: r.session_id,
    kind: r.kind,
    payload: r.payload,
    createdAt: Number(r.created_at),
  }));
}

// The snapshot's cursor — a client that resumes from here misses nothing.
export async function latestCursor(workspaceId?: string): Promise<number> {
  const { rows } = workspaceId
    ? await query<{ max: string | null }>(`SELECT MAX(cursor) AS max FROM events WHERE workspace_id = $1`, [workspaceId])
    : await query<{ max: string | null }>(`SELECT MAX(cursor) AS max FROM events`);
  return rows[0]?.max ? Number(rows[0].max) : 0;
}

// Global lower bound of the retained log. A resume cursor older than this may
// have crossed the pruning horizon and needs a fresh materialized snapshot.
export async function oldestCursor(): Promise<number> {
  const { rows } = await query<{ min: string | null }>(`SELECT MIN(cursor) AS min FROM events`);
  return rows[0]?.min ? Number(rows[0].min) : 0;
}

// Keep the log bounded — retain only the newest `cap` cursors globally. A client
// that's fallen further behind than that just gets a fresh snapshot on reconnect.
export async function pruneEvents(cap = 50_000): Promise<void> {
  await query(`DELETE FROM events WHERE cursor <= (SELECT COALESCE(MAX(cursor), 0) - $1 FROM events)`, [cap]);
}
