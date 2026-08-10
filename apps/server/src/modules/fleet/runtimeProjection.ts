import { createHash } from "node:crypto";
import { query, transaction } from "../../infrastructure/db/index.js";
import { insertEvent, publishCommittedEvent, type LiveEvent } from "../../infrastructure/events/index.js";
import { getPeonConnection, peonConnectionSupports } from "./peonConnections.js";
import {
  advanceDeliveryCheckpoint,
  assertProjectionGeneration,
  projectionFreshness,
  readDeliveryCheckpoint,
  recordDurableInbox,
} from "../resourceSync/index.js";

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
    await assertProjectionGeneration(tx, input.peonId, input.syncGeneration, ["peon_session_sync"], "runtime state connection was replaced");
    const existing = await tx.query<{ epoch: string; revision: string; digest: string }>(
      `SELECT epoch,revision,digest FROM peon_runtime_state WHERE peon_id=$1 FOR UPDATE`, [input.peonId],
    );
    const row = existing.rows[0];
    // A durable runtime-state message can be redelivered out of order across
    // reconnects (the client republishes its current snapshot on every
    // renegotiation while older queued messages are still draining). An
    // already-superseded revision must still be acknowledged rather than
    // treated as fatal, or the connection is torn down and the same message
    // is redelivered forever, permanently blocking this Peon's runtime
    // channel. Only a genuine digest mismatch at an equal revision indicates
    // real corruption worth rejecting.
    if (row?.epoch === input.durable.epoch && Number(row.revision) === input.durable.revision && row.digest !== input.durable.digest) {
      throw new Error("runtime revision digest changed");
    }
    const inbox = await recordDurableInbox(tx, {
      peonId: input.peonId, deliveryEpoch: input.durable.deliveryEpoch,
      deliveryCursor: input.durable.deliveryCursor, messageId: input.durable.messageId,
    });
    let event: LiveEvent | null = null;
    if (inbox === "inserted" && (!row || row.epoch !== input.durable.epoch || Number(row.revision) < input.durable.revision)) {
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
    if (inbox === "inserted") await advanceDeliveryCheckpoint(tx, {
      peonId: input.peonId, generation: input.syncGeneration,
      epoch: input.durable.deliveryEpoch, acknowledgedCursor: input.durable.deliveryCursor,
    }, "runtime state connection was replaced");
    const current = await readDeliveryCheckpoint(tx, input.peonId, input.syncGeneration);
    if (!current || current.acknowledgedCursor === null) {
      throw new Error("runtime delivery checkpoint missing");
    }
    return {
      delivery: { epoch: current.epoch, acknowledgedCursor: current.acknowledgedCursor },
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
    freshness: projectionFreshness({ online, receivedAt, staleAfterMs: 120_000 }),
    state: row.state,
  };
}
