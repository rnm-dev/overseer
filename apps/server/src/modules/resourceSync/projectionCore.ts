import type { Transaction } from "../../infrastructure/db/index.js";

// This module deliberately owns only synchronization bookkeeping.  Callers
// retain their domain tables, parsers, authority decisions, and wire shapes.
export type ProjectionSyncTable = "peon_session_sync" | "peon_project_sync";

function syncTable(table: ProjectionSyncTable): string {
  // Table names cannot be query parameters. Keep this explicit runtime fence so
  // an accidental future untyped caller cannot turn this bookkeeping helper
  // into a SQL identifier interpolation surface.
  switch (table) {
    case "peon_session_sync": return "peon_session_sync";
    case "peon_project_sync": return "peon_project_sync";
  }
}

export interface DeliveryCheckpoint {
  epoch: string;
  acknowledgedCursor: string | null;
}

export async function assertProjectionGeneration(
  tx: Transaction,
  peonId: string,
  generation: string,
  tables: readonly ProjectionSyncTable[],
  failure: string | Error = "projection sync connection was replaced",
): Promise<void> {
  const rows = await Promise.all(tables.map((table) => tx.query(
    `SELECT peon_id FROM ${syncTable(table)} WHERE peon_id=$1 AND generation=$2`, [peonId, generation],
  )));
  if (rows.some((result) => !result.rows[0])) throw typeof failure === "string" ? new Error(failure) : failure;
}

export async function recordDurableInbox(
  tx: Transaction,
  input: { peonId: string; deliveryEpoch: string; deliveryCursor: string; messageId: string },
): Promise<"inserted" | "replayed"> {
  const inserted = await tx.query<{ cursor: string }>(
    `INSERT INTO peon_session_inbox (peon_id,epoch,cursor,created_at,message_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING cursor`,
    [input.peonId, input.deliveryEpoch, input.deliveryCursor, Date.now(), input.messageId],
  );
  if (inserted.rows[0]) return "inserted";
  const replay = await tx.query<{ epoch: string; cursor: string; message_id: string | null }>(
    `SELECT epoch,cursor,message_id FROM peon_session_inbox
     WHERE peon_id=$1 AND ((epoch=$2 AND cursor=$3) OR message_id=$4)`,
    [input.peonId, input.deliveryEpoch, input.deliveryCursor, input.messageId],
  );
  const row = replay.rows[0];
  if (!row || row.epoch !== input.deliveryEpoch || row.cursor !== input.deliveryCursor || row.message_id !== input.messageId) {
    throw new Error("durable message replay identity mismatch");
  }
  return "replayed";
}

export async function readDeliveryCheckpoint(
  tx: Transaction, peonId: string, generation: string,
): Promise<DeliveryCheckpoint | null> {
  const result = await tx.query<{ delivery_epoch: string | null; acknowledged_cursor: string | null }>(
    `SELECT delivery_epoch,acknowledged_cursor FROM peon_session_sync WHERE peon_id=$1 AND generation=$2`,
    [peonId, generation],
  );
  const row = result.rows[0];
  return row?.delivery_epoch
    ? { epoch: row.delivery_epoch, acknowledgedCursor: row.acknowledged_cursor }
    : null;
}

export async function advanceDeliveryCheckpoint(
  tx: Transaction,
  input: { peonId: string; generation: string; epoch: string; acknowledgedCursor: string | null },
  message = "projection sync connection was replaced",
): Promise<void> {
  const updated = await tx.query<{ peon_id: string }>(
    `UPDATE peon_session_sync SET delivery_epoch=$3,acknowledged_cursor=$4,updated_at=$5
     WHERE peon_id=$1 AND generation=$2 RETURNING peon_id`,
    [input.peonId, input.generation, input.epoch, input.acknowledgedCursor, Date.now()],
  );
  if (!updated.rows[0]) throw new Error(message);
}

export function projectionFreshness(input: {
  online: boolean;
  receivedAt: number;
  now?: number;
  staleAfterMs: number;
}): "fresh" | "stale" | "offline" {
  if (!input.online) return "offline";
  return (input.now ?? Date.now()) - input.receivedAt > input.staleAfterMs ? "stale" : "fresh";
}
