import { createHash } from "node:crypto";
import { query, transaction } from "../db.js";
import { insertEvent, publishCommittedEvent, type LiveEvent } from "../eventLog.js";
import { getPeonConnection, peonConnectionSupports } from "../peonConnections.js";

export const RUNTIME_STATE_CAPABILITY = "runtime-state-v1";
const MAX_RUNTIME_STATE_BYTES = 56 * 1024;
const RUNTIME_STATE_FIELDS = new Set([
  "name", "paused", "filesEnabled", "capacity", "daemon", "defaultAgent", "providers", "models",
]);
const FORBIDDEN_RUNTIME_KEY = /(?:credential|secret|token|password|authorization|authresponse|environment|executablepath|filetransferroot)/i;

export interface DurableRuntimeState {
  channel: "runtime";
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
  epoch: string;
  revision: number;
  digest: string;
  generatedAt: number;
  state: Record<string, unknown>;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > max) throw new Error(`invalid ${name}`);
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function assertSafeRuntimeState(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error("runtime state is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new Error("runtime state array is too large");
    for (const item of value) assertSafeRuntimeState(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") throw new Error("runtime state contains an unsupported value");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 1_000 || entries.some(([key]) => FORBIDDEN_RUNTIME_KEY.test(key))) {
    throw new Error("runtime state contains a forbidden field");
  }
  for (const [, item] of entries) assertSafeRuntimeState(item, depth + 1);
}

export function parseDurableRuntimeState(frame: Record<string, unknown>): DurableRuntimeState {
  if (frame.capability !== RUNTIME_STATE_CAPABILITY || !frame.payload || typeof frame.payload !== "object" || Array.isArray(frame.payload)) {
    throw new Error("invalid runtime state envelope");
  }
  const payload = frame.payload as Record<string, unknown>;
  const allowed = ["type", "protocol", "epoch", "revision", "digest", "generatedAt", "state"];
  if (Object.keys(payload).some((key) => !allowed.includes(key)) || payload.type !== "runtime_state" || payload.protocol !== 1
    || !Number.isSafeInteger(payload.revision) || Number(payload.revision) < 1
    || !Number.isSafeInteger(payload.generatedAt) || Number(payload.generatedAt) < 0
    || !payload.state || typeof payload.state !== "object" || Array.isArray(payload.state)
    || Buffer.byteLength(JSON.stringify(payload.state)) > MAX_RUNTIME_STATE_BYTES
    || Object.keys(payload.state as Record<string, unknown>).some((key) => !RUNTIME_STATE_FIELDS.has(key))) {
    throw new Error("invalid runtime state");
  }
  assertSafeRuntimeState(payload.state);
  if (!/^[0-9a-f]{64}$/.test(String(payload.digest))
    || createHash("sha256").update(canonical(payload.state)).digest("hex") !== payload.digest) {
    throw new Error("runtime state digest mismatch");
  }
  return {
    channel: "runtime",
    deliveryEpoch: text(frame.epoch, "delivery epoch", 256),
    deliveryCursor: text(frame.cursor, "delivery cursor", 2_000),
    messageId: text(frame.messageId, "message id", 80),
    epoch: text(payload.epoch, "runtime epoch", 80),
    revision: Number(payload.revision),
    digest: text(payload.digest, "digest", 64),
    generatedAt: Number(payload.generatedAt),
    state: payload.state as Record<string, unknown>,
  };
}

export async function commitRuntimeState(input: {
  workspaceId: string; peonId: string; syncGeneration: string; durable: DurableRuntimeState;
}): Promise<{ epoch: string; acknowledgedCursor: string }> {
  const committed = await transaction(async (tx) => {
    const sync = await tx.query(
      `SELECT 1 FROM peon_session_sync WHERE peon_id=$1 AND generation=$2`,
      [input.peonId, input.syncGeneration],
    );
    if (!sync.rows[0]) throw new Error("runtime state connection was replaced");
    const existing = await tx.query<{ epoch: string; revision: string; digest: string }>(
      `SELECT epoch,revision,digest FROM peon_runtime_state WHERE peon_id=$1 FOR UPDATE`, [input.peonId],
    );
    const row = existing.rows[0];
    if (row?.epoch === input.durable.epoch && input.durable.revision < Number(row.revision)) {
      throw new Error("stale runtime revision");
    }
    if (row?.epoch === input.durable.epoch && Number(row.revision) === input.durable.revision && row.digest !== input.durable.digest) {
      throw new Error("runtime revision digest changed");
    }
    const inserted = await tx.query(
      `INSERT INTO peon_session_inbox (peon_id,epoch,cursor,created_at,message_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING cursor`,
      [input.peonId, input.durable.deliveryEpoch, input.durable.deliveryCursor, Date.now(), input.durable.messageId],
    );
    let event: LiveEvent | null = null;
    if (inserted.rows[0] && (!row || row.epoch !== input.durable.epoch || Number(row.revision) < input.durable.revision)) {
      await tx.query(
        `INSERT INTO peon_runtime_state (peon_id,workspace_id,epoch,revision,digest,generated_at,received_at,state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (peon_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,epoch=EXCLUDED.epoch,
           revision=EXCLUDED.revision,digest=EXCLUDED.digest,generated_at=EXCLUDED.generated_at,
           received_at=EXCLUDED.received_at,state=EXCLUDED.state`,
        [input.peonId, input.workspaceId, input.durable.epoch, input.durable.revision, input.durable.digest,
          input.durable.generatedAt, Date.now(), JSON.stringify(input.durable.state)],
      );
      event = await insertEvent(tx, {
        workspaceId: input.workspaceId,
        peonId: input.peonId,
        kind: "peon",
        payload: {
          operation: "runtime.state",
          peonId: input.peonId,
          revision: input.durable.revision,
          generatedAt: input.durable.generatedAt,
        },
      });
    }
    if (inserted.rows[0]) {
      await tx.query(
        `UPDATE peon_session_sync SET delivery_epoch=$3,acknowledged_cursor=$4,updated_at=$5
         WHERE peon_id=$1 AND generation=$2`,
        [input.peonId, input.syncGeneration, input.durable.deliveryEpoch, input.durable.deliveryCursor, Date.now()],
      );
    }
    const checkpoint = await tx.query<{ delivery_epoch: string; acknowledged_cursor: string }>(
      `SELECT delivery_epoch,acknowledged_cursor FROM peon_session_sync WHERE peon_id=$1 AND generation=$2`,
      [input.peonId, input.syncGeneration],
    );
    const current = checkpoint.rows[0];
    if (!current?.delivery_epoch || !current.acknowledged_cursor) {
      throw new Error("runtime delivery checkpoint missing");
    }
    return {
      delivery: { epoch: current.delivery_epoch, acknowledgedCursor: current.acknowledged_cursor },
      event,
    };
  });
  if (committed.event) await publishCommittedEvent(committed.event);
  return committed.delivery;
}

export async function getRuntimeProjection(peonId: string): Promise<null | {
  epoch: string; revision: number; digest: string; generatedAt: number; receivedAt: number;
  freshness: "fresh" | "stale" | "offline"; state: Record<string, unknown>;
}> {
  const { rows } = await query<{
    epoch: string; revision: string; digest: string; generated_at: string; received_at: string; state: Record<string, unknown>;
  }>(`SELECT epoch,revision,digest,generated_at,received_at,state FROM peon_runtime_state WHERE peon_id=$1`, [peonId]);
  const row = rows[0];
  if (!row) return null;
  const socket = getPeonConnection(peonId);
  const online = Boolean(socket && peonConnectionSupports(socket, RUNTIME_STATE_CAPABILITY));
  const receivedAt = Number(row.received_at);
  return {
    epoch: row.epoch,
    revision: Number(row.revision),
    digest: row.digest,
    generatedAt: Number(row.generated_at),
    receivedAt,
    freshness: !online ? "offline" : Date.now() - receivedAt > 120_000 ? "stale" : "fresh",
    state: row.state,
  };
}
