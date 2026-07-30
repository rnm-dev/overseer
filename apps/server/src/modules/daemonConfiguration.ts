import { createHash } from "node:crypto";
import { query, transaction } from "../db.js";
import { insertEvent, publishCommittedEvent, type LiveEvent } from "../eventLog.js";
import { canonicalJson, assertDaemonConfigurationValues, type JsonObject } from "./reverseCommands/index.js";

export const DAEMON_CONFIGURATION_CAPABILITY = "daemon-configuration-v1";

export interface DaemonConfigurationProjection {
  workspaceId: string;
  peonId: string;
  epoch: string;
  revision: number;
  schemaVersion: 1;
  digest: string;
  updatedAt: number;
  values: JsonObject;
  lastCommandId: string | null;
}

export interface DurableDaemonConfigurationState {
  channel: "configuration";
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
  epoch: string;
  revision: number;
  schemaVersion: 1;
  digest: string;
  updatedAt: number;
  reason: "initial_sync" | "local_change" | "command";
  commandId: string | null;
  values: JsonObject;
}

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requiredString(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > max) throw new Error(`invalid ${field}`);
  return value;
}

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`invalid ${field}`);
  return Number(value);
}

export function daemonConfigurationDigest(values: JsonObject): string {
  return createHash("sha256").update(canonicalJson(values)).digest("hex");
}

export function parseDaemonConfigurationHello(value: unknown): { epoch: string; revision: number; schemaVersion: 1; digest: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid daemon configuration hello");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["epoch", "revision", "schemaVersion", "digest"].includes(key))
    || item.schemaVersion !== 1 || !SHA256.test(String(item.digest))) throw new Error("invalid daemon configuration hello");
  return {
    epoch: requiredString(item.epoch, "configuration epoch"),
    revision: safeInteger(item.revision, "configuration revision"),
    schemaVersion: 1,
    digest: String(item.digest),
  };
}

export function parseDurableDaemonConfigurationState(message: Record<string, unknown>): DurableDaemonConfigurationState {
  if (Object.keys(message).some((key) => ![
    "type", "epoch", "cursor", "messageId", "priority", "capability", "payload",
  ].includes(key))
    || message.type !== "durable_message"
    || message.capability !== DAEMON_CONFIGURATION_CAPABILITY) {
    throw new Error("invalid daemon configuration capability");
  }
  if (!UUID.test(String(message.messageId))
    || !["critical", "control", "normal", "bulk"].includes(String(message.priority))) {
    throw new Error("invalid daemon configuration durable envelope");
  }
  const payload = message.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid daemon configuration payload");
  const state = payload as Record<string, unknown>;
  if (state.type !== "daemon_configuration_state"
    || Object.keys(state).some((key) => !["type", "epoch", "revision", "schemaVersion", "digest", "updatedAt", "reason", "commandId", "values"].includes(key))
    || state.schemaVersion !== 1 || !SHA256.test(String(state.digest))
    || !["initial_sync", "local_change", "command"].includes(String(state.reason))) {
    throw new Error("invalid daemon configuration state");
  }
  assertDaemonConfigurationValues(state.values);
  if (daemonConfigurationDigest(state.values) !== state.digest) throw new Error("daemon configuration digest mismatch");
  const commandId = state.commandId === undefined ? null : requiredString(state.commandId, "commandId", 36);
  if (commandId !== null && !UUID.test(commandId)) throw new Error("invalid commandId");
  return {
    channel: "configuration",
    deliveryEpoch: requiredString(message.epoch, "delivery epoch"),
    deliveryCursor: requiredString(message.cursor, "delivery cursor", 2_000),
    messageId: String(message.messageId),
    epoch: requiredString(state.epoch, "configuration epoch"),
    revision: safeInteger(state.revision, "configuration revision"),
    schemaVersion: 1,
    digest: String(state.digest),
    updatedAt: safeInteger(state.updatedAt, "configuration updatedAt"),
    reason: state.reason as DurableDaemonConfigurationState["reason"],
    commandId,
    values: state.values,
  };
}

export async function getDaemonConfigurationProjection(peonId: string): Promise<DaemonConfigurationProjection | null> {
  const { rows } = await query<{
    workspace_id: string; peon_id: string; epoch: string; revision: string; schema_version: number;
    digest: string; updated_at: string; values: JsonObject; last_command_id: string | null;
  }>(`SELECT workspace_id,peon_id,epoch,revision,schema_version,digest,updated_at,values,last_command_id
        FROM peon_daemon_configuration WHERE peon_id=$1`, [peonId]);
  const row = rows[0];
  return row ? {
    workspaceId: row.workspace_id, peonId: row.peon_id, epoch: row.epoch, revision: Number(row.revision),
    schemaVersion: 1, digest: row.digest, updatedAt: Number(row.updated_at), values: row.values,
    lastCommandId: row.last_command_id,
  } : null;
}

export async function configurationHelloCheckpoint(peonId: string): Promise<Record<string, unknown> | null> {
  const projection = await getDaemonConfigurationProjection(peonId);
  return projection ? {
    epoch: projection.epoch,
    acknowledgedRevision: projection.revision,
    digest: projection.digest,
  } : null;
}

export async function commitDaemonConfigurationState(input: {
  workspaceId: string;
  peonId: string;
  syncGeneration: string;
  durable: DurableDaemonConfigurationState;
  advertisedIdentity?: { epoch: string; revision: number; digest: string } | null;
}): Promise<{
  delivery: { epoch: string; acknowledgedCursor: string };
  projection: DaemonConfigurationProjection;
  projected: boolean;
}> {
  const committed = await transaction(async (tx) => {
    const sync = await tx.query<{ delivery_epoch: string | null; acknowledged_cursor: string | null }>(
      `SELECT delivery_epoch,acknowledged_cursor FROM peon_session_sync WHERE peon_id=$1 AND generation=$2`,
      [input.peonId, input.syncGeneration],
    );
    if (!sync.rows[0]) throw new Error("daemon configuration connection was replaced");
    const inserted = await tx.query(
      `INSERT INTO peon_session_inbox (peon_id,epoch,cursor,created_at,message_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING cursor`,
      [input.peonId, input.durable.deliveryEpoch, input.durable.deliveryCursor, Date.now(), input.durable.messageId],
    );
    if (!inserted.rows[0]) {
      const duplicate = await tx.query<{ epoch: string; cursor: string; message_id: string | null }>(
        `SELECT epoch,cursor,message_id FROM peon_session_inbox
          WHERE peon_id=$1 AND (message_id=$2 OR (epoch=$3 AND cursor=$4))`,
        [input.peonId, input.durable.messageId, input.durable.deliveryEpoch, input.durable.deliveryCursor],
      );
      const row = duplicate.rows[0];
      if (!row || row.epoch !== input.durable.deliveryEpoch || row.cursor !== input.durable.deliveryCursor
        || row.message_id !== input.durable.messageId) {
        throw new Error("durable daemon configuration identity collision");
      }
    }
    let event: LiveEvent | null = null;
    if (inserted.rows[0]) {
      const existing = await tx.query<{ epoch: string; revision: string; digest: string }>(
        `SELECT epoch,revision,digest FROM peon_daemon_configuration WHERE peon_id=$1`, [input.peonId],
      );
      const old = existing.rows[0];
      let semanticDuplicate = Boolean(input.advertisedIdentity
        && input.durable.epoch !== input.advertisedIdentity.epoch);
      if (old && old.epoch === input.durable.epoch) {
        const oldRevision = Number(old.revision);
        if (input.durable.revision === oldRevision && input.durable.digest !== old.digest) {
          throw new Error("daemon configuration revision digest collision");
        }
        // A full older state may remain in the durable outbox after a later
        // state committed through a command result. It is snapshot-covered:
        // commit its transport identity, but never regress the projection.
        semanticDuplicate = input.durable.revision <= oldRevision;
      }
      if (!semanticDuplicate) {
        await tx.query(
          `INSERT INTO peon_daemon_configuration
            (peon_id,workspace_id,epoch,revision,schema_version,digest,updated_at,values,last_command_id)
           VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)
           ON CONFLICT (peon_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,epoch=EXCLUDED.epoch,
             revision=EXCLUDED.revision,schema_version=1,digest=EXCLUDED.digest,updated_at=EXCLUDED.updated_at,
             values=EXCLUDED.values,last_command_id=EXCLUDED.last_command_id`,
          [input.peonId, input.workspaceId, input.durable.epoch, input.durable.revision, input.durable.digest,
            input.durable.updatedAt, JSON.stringify(input.durable.values), input.durable.commandId],
        );
      }
      await tx.query(
        `UPDATE peon_session_sync SET delivery_epoch=$3,acknowledged_cursor=$4,updated_at=$5
          WHERE peon_id=$1 AND generation=$2`,
        [input.peonId, input.syncGeneration, input.durable.deliveryEpoch, input.durable.deliveryCursor, Date.now()],
      );
      if (!semanticDuplicate) {
        event = await insertEvent(tx, {
          workspaceId: input.workspaceId, peonId: input.peonId, kind: "configuration",
          payload: { operation: "daemon.configuration.state", peonId: input.peonId,
            revision: input.durable.revision, updatedAt: input.durable.updatedAt },
        });
      }
    }
    const checkpoint = await tx.query<{ delivery_epoch: string; acknowledged_cursor: string }>(
      `SELECT delivery_epoch,acknowledged_cursor FROM peon_session_sync WHERE peon_id=$1 AND generation=$2`,
      [input.peonId, input.syncGeneration],
    );
    const row = checkpoint.rows[0];
    if (!row?.delivery_epoch || !row.acknowledged_cursor) throw new Error("daemon configuration delivery checkpoint missing");
    return {
      delivery: { epoch: row.delivery_epoch, acknowledgedCursor: row.acknowledged_cursor },
      event,
      projected: Boolean(inserted.rows[0] && event),
    };
  });
  if (committed.event) {
    await publishCommittedEvent(committed.event).catch((error) => {
      console.warn("daemon configuration browser event fan-out failed:", error instanceof Error ? error.message : String(error));
    });
  }
  const projection = await getDaemonConfigurationProjection(input.peonId);
  if (!projection) throw new Error("daemon configuration projection missing after commit");
  return { delivery: committed.delivery, projection, projected: committed.projected };
}
