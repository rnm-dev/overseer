import { query, transaction, transactionWithAdvisoryLock, type Transaction } from "../../db.js";
import { insertEvent, publishCommittedEvent, type LiveEvent } from "../../eventLog.js";
import {
  assertSafeReverseCommandResult,
  canonicalJson,
  type DurableReverseCommandResult,
  type JsonObject,
  type ReverseCommandActor,
  type ReverseCommandOperation,
  type ReverseCommandRecord,
  type ReverseCommandResultFrame,
  type ReverseCommandState,
  type ReverseCommandTarget,
} from "./reverseCommandTypes.js";

export interface ReverseCommandLimits {
  globalPending: number;
  globalBytes: number;
  workspacePending: number;
  workspaceBytes: number;
  peonPending: number;
  peonBytes: number;
  userPending: number;
  userBytes: number;
  abandonedCreatedMs: number;
}

export const DEFAULT_REVERSE_COMMAND_LIMITS: ReverseCommandLimits = {
  globalPending: 2_048,
  globalBytes: 32 * 1024 * 1024,
  workspacePending: 512,
  workspaceBytes: 8 * 1024 * 1024,
  peonPending: 256,
  peonBytes: 4 * 1024 * 1024,
  userPending: 128,
  userBytes: 2 * 1024 * 1024,
  abandonedCreatedMs: 2 * 60_000,
};

interface ReverseCommandRow {
  workspace_id: string;
  peon_id: string;
  command_id: string;
  operation: ReverseCommandOperation;
  request_hash: string;
  actor_user_id: string;
  actor_email: string;
  target: ReverseCommandTarget;
  payload: JsonObject;
  expected: JsonObject | null;
  request_bytes: number | string;
  state: ReverseCommandState;
  connection_generation: string | null;
  requested_at: number | string;
  sent_at: number | string | null;
  accepted_at: number | string | null;
  completed_at: number | string | null;
  updated_at: number | string;
  terminal_status: ReverseCommandRecord["terminalStatus"];
  result_code: string | null;
  result_message: string | null;
  terminal_result: JsonObject | null;
  result_frame: ReverseCommandResultFrame | null;
  replayed: boolean;
  attempt_count: number;
  last_error_code: string | null;
  durable_committed_at: number | string | null;
}

export interface NewReverseCommand {
  workspaceId: string;
  peonId: string;
  commandId: string;
  operation: ReverseCommandOperation;
  requestHash: string;
  actor: ReverseCommandActor;
  target: ReverseCommandTarget;
  payload: JsonObject;
  expected: JsonObject | null;
  requestBytes: number;
  requestedAt: number;
}

export type ReverseCommandCreateResult =
  | { kind: "created"; record: ReverseCommandRecord }
  | { kind: "existing"; record: ReverseCommandRecord }
  | { kind: "reused"; record: ReverseCommandRecord }
  | { kind: "conflict"; record: ReverseCommandRecord }
  | { kind: "overloaded"; scope: "user" | "peon" | "workspace" | "global" };

const ACTIVE_STATES = ["created", "sent", "accepted", "running", "unknown"] as const;

function rowToRecord(row: ReverseCommandRow): ReverseCommandRecord {
  return {
    workspaceId: row.workspace_id,
    peonId: row.peon_id,
    commandId: row.command_id,
    operation: row.operation,
    requestHash: row.request_hash,
    actor: { userId: row.actor_user_id, email: row.actor_email },
    target: row.target,
    payload: row.payload,
    expected: row.expected,
    requestBytes: Number(row.request_bytes),
    state: row.state,
    connectionGeneration: row.connection_generation,
    requestedAt: Number(row.requested_at),
    sentAt: row.sent_at === null ? null : Number(row.sent_at),
    acceptedAt: row.accepted_at === null ? null : Number(row.accepted_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    updatedAt: Number(row.updated_at),
    terminalStatus: row.terminal_status,
    code: row.result_code,
    message: row.result_message,
    result: row.terminal_result,
    resultFrame: row.result_frame,
    replayed: row.replayed,
    attemptCount: Number(row.attempt_count),
    lastErrorCode: row.last_error_code,
    durableCommittedAt: row.durable_committed_at === null ? null : Number(row.durable_committed_at),
  };
}

function selectColumns(): string {
  return `workspace_id,peon_id,command_id,operation,request_hash,actor_user_id,actor_email,
    target,payload,expected,request_bytes,state,connection_generation,requested_at,sent_at,
    accepted_at,completed_at,updated_at,terminal_status,result_code,result_message,
    terminal_result,result_frame,replayed,attempt_count,last_error_code,durable_committed_at`;
}

async function findWith(
  writer: Pick<Transaction, "query">,
  workspaceId: string,
  peonId: string,
  commandId: string,
): Promise<ReverseCommandRecord | null> {
  const { rows } = await writer.query<ReverseCommandRow>(
    `SELECT ${selectColumns()} FROM reverse_commands
      WHERE workspace_id=$1 AND peon_id=$2 AND command_id=$3`,
    [workspaceId, peonId, commandId],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function getReverseCommand(
  workspaceId: string,
  peonId: string,
  commandId: string,
): Promise<ReverseCommandRecord | null> {
  return findWith({ query }, workspaceId, peonId, commandId);
}

export async function getReverseCommandForActor(
  workspaceId: string,
  peonId: string,
  commandId: string,
  actorUserId: string,
): Promise<ReverseCommandRecord | null> {
  const record = await getReverseCommand(workspaceId, peonId, commandId);
  return record?.actor.userId === actorUserId ? record : null;
}

async function pendingUsage(
  tx: Transaction,
  clause: string,
  params: unknown[],
): Promise<{ count: number; bytes: number }> {
  const { rows } = await tx.query<{ count: number | string; bytes: number | string }>(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(request_bytes),0) AS bytes
       FROM reverse_commands
      WHERE state IN ('created','sent','accepted','running','unknown')${clause}`,
    params,
  );
  return { count: Number(rows[0]?.count ?? 0), bytes: Number(rows[0]?.bytes ?? 0) };
}

function exceeds(usage: { count: number; bytes: number }, bytes: number, maxCount: number, maxBytes: number): boolean {
  return usage.count + 1 > maxCount || usage.bytes + bytes > maxBytes;
}

export async function createOrGetReverseCommand(
  input: NewReverseCommand,
  limits: ReverseCommandLimits = DEFAULT_REVERSE_COMMAND_LIMITS,
  now = Date.now(),
): Promise<ReverseCommandCreateResult> {
  return transactionWithAdvisoryLock("overseer:reverse-command-admission", async (tx) => {
    await tx.query(
      `DELETE FROM reverse_commands
        WHERE state IN ('created','send_failed') AND updated_at < $1`,
      [now - limits.abandonedCreatedMs],
    );
    const existing = await findWith(tx, input.workspaceId, input.peonId, input.commandId);
    if (existing) {
      return existing.requestHash === input.requestHash
        ? { kind: "existing", record: existing }
        : { kind: "reused", record: existing };
    }

    if ((input.operation as string).startsWith("update.")) {
      const { rows } = await tx.query<ReverseCommandRow>(
        `SELECT ${selectColumns()} FROM reverse_commands
          WHERE workspace_id=$1 AND peon_id=$2
            AND operation LIKE 'update.%'
            AND state IN ('created','sent','accepted','running','unknown')
          ORDER BY requested_at ASC LIMIT 1`,
        [input.workspaceId, input.peonId],
      );
      if (rows[0]) return { kind: "conflict", record: rowToRecord(rows[0]) };
    }

    const [global, workspace, peon, user] = await Promise.all([
      pendingUsage(tx, "", []),
      pendingUsage(tx, " AND workspace_id=$1", [input.workspaceId]),
      pendingUsage(tx, " AND workspace_id=$1 AND peon_id=$2", [input.workspaceId, input.peonId]),
      pendingUsage(tx, " AND actor_user_id=$1", [input.actor.userId]),
    ]);
    if (exceeds(user, input.requestBytes, limits.userPending, limits.userBytes)) return { kind: "overloaded", scope: "user" };
    if (exceeds(peon, input.requestBytes, limits.peonPending, limits.peonBytes)) return { kind: "overloaded", scope: "peon" };
    if (exceeds(workspace, input.requestBytes, limits.workspacePending, limits.workspaceBytes)) return { kind: "overloaded", scope: "workspace" };
    if (exceeds(global, input.requestBytes, limits.globalPending, limits.globalBytes)) return { kind: "overloaded", scope: "global" };

    const { rows } = await tx.query<ReverseCommandRow>(
      `INSERT INTO reverse_commands
        (workspace_id,peon_id,command_id,operation,request_hash,actor_user_id,actor_email,
         target,payload,expected,request_bytes,state,requested_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'created',$12,$12)
       ON CONFLICT (workspace_id,peon_id,command_id) DO NOTHING
       RETURNING ${selectColumns()}`,
      [
        input.workspaceId,
        input.peonId,
        input.commandId,
        input.operation,
        input.requestHash,
        input.actor.userId,
        input.actor.email,
        JSON.stringify(input.target),
        JSON.stringify(input.payload),
        input.expected === null ? null : JSON.stringify(input.expected),
        input.requestBytes,
        input.requestedAt,
      ],
    );
    if (rows[0]) return { kind: "created", record: rowToRecord(rows[0]) };
    const raced = await findWith(tx, input.workspaceId, input.peonId, input.commandId);
    if (!raced) throw new Error("reverse command insert conflict could not be resolved");
    return raced.requestHash === input.requestHash
      ? { kind: "existing", record: raced }
      : { kind: "reused", record: raced };
  });
}

async function updateAndRead(
  workspaceId: string,
  commandId: string,
  sql: string,
  params: unknown[],
): Promise<ReverseCommandRecord | null> {
  const { rows } = await query<ReverseCommandRow>(
    `${sql} RETURNING ${selectColumns()}`,
    [workspaceId, commandId, ...params],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function markReverseCommandSent(
  workspaceId: string,
  peonId: string,
  commandId: string,
  generation: string,
  now = Date.now(),
  resend = false,
): Promise<ReverseCommandRecord | null> {
  return updateAndRead(
    workspaceId,
    commandId,
    `UPDATE reverse_commands
        SET state='sent',connection_generation=$3,sent_at=$4,updated_at=$4,
            attempt_count=attempt_count+1,last_error_code=NULL
      WHERE workspace_id=$1 AND command_id=$2 AND peon_id=$5
        AND state IN ('created','send_failed'${resend ? ",'sent'" : ""})
        AND EXISTS (
          SELECT 1 FROM peon_session_sync
           WHERE peon_id=$5 AND generation=$3
        )`,
    [generation, now, peonId],
  );
}

export async function markReverseCommandSendFailed(
  workspaceId: string,
  peonId: string,
  commandId: string,
  generation: string,
  code: string,
  now = Date.now(),
): Promise<ReverseCommandRecord | null> {
  return updateAndRead(
    workspaceId,
    commandId,
    `UPDATE reverse_commands
        SET state='send_failed',last_error_code=$4,updated_at=$5
      WHERE workspace_id=$1 AND command_id=$2 AND peon_id=$6 AND connection_generation=$3
        AND state IN ('created','sent')`,
    [generation, code, now, peonId],
  );
}

export async function markReverseCommandAccepted(input: {
  workspaceId: string;
  peonId: string;
  commandId: string;
  operation: ReverseCommandOperation;
  generation: string;
  state: "accepted" | "running";
  replayed: boolean;
  acceptedAt: number;
}): Promise<ReverseCommandRecord | null> {
  return updateAndRead(
    input.workspaceId,
    input.commandId,
    `UPDATE reverse_commands
        SET state=$6,accepted_at=COALESCE(accepted_at,$7),replayed=replayed OR $8,
            updated_at=$9,last_error_code=NULL
      WHERE workspace_id=$1 AND command_id=$2 AND peon_id=$3 AND operation=$4
        AND connection_generation=$5 AND state IN ('sent','accepted','running')`,
    [
      input.peonId,
      input.operation,
      input.generation,
      input.state,
      input.acceptedAt,
      input.replayed,
      Date.now(),
    ],
  );
}

export async function markReverseCommandUnknown(
  workspaceId: string,
  peonId: string,
  commandId: string,
  generation: string,
  now = Date.now(),
): Promise<ReverseCommandRecord | null> {
  return updateAndRead(
    workspaceId,
    commandId,
    `UPDATE reverse_commands SET state='unknown',last_error_code='UNKNOWN_OUTCOME',updated_at=$5
      WHERE workspace_id=$1 AND command_id=$2 AND peon_id=$3 AND connection_generation=$4
        AND state IN ('accepted','running','unknown')`,
    [peonId, generation, now],
  );
}

export async function observeReverseCommandTerminal(
  workspaceId: string,
  peonId: string,
  generation: string,
  result: ReverseCommandResultFrame,
  now = Date.now(),
): Promise<ReverseCommandRecord | null> {
  const existing = await getReverseCommand(workspaceId, peonId, result.commandId);
  if (!existing || existing.peonId !== peonId || existing.operation !== result.operation
    || existing.connectionGeneration !== generation) return null;
  assertSafeReverseCommandResult(existing, result);
  if (existing.resultFrame && canonicalJson(existing.resultFrame as unknown as JsonObject)
    !== canonicalJson(result as unknown as JsonObject)) return null;
  return updateAndRead(
    workspaceId,
    result.commandId,
    `UPDATE reverse_commands
        SET state='terminal',completed_at=$5,terminal_status=$6,result_code=$7,
            result_message=$8,terminal_result=$9,result_frame=$10,updated_at=$11,last_error_code=NULL
      WHERE workspace_id=$1 AND command_id=$2 AND peon_id=$3 AND operation=$4
        AND connection_generation=$12`,
    [
      peonId,
      result.operation,
      result.completedAt,
      result.status,
      result.code,
      result.message ?? null,
      result.result === null ? null : JSON.stringify(result.result),
      JSON.stringify(result),
      now,
      generation,
    ],
  );
}

export async function commitEphemeralReverseCommandResult(input: {
  workspaceId: string;
  peonId: string;
  connectionGeneration: string;
  result: ReverseCommandResultFrame;
  now?: number;
}): Promise<ReverseCommandRecord | null> {
  const now = input.now ?? Date.now();
  const committed = await transaction(async (tx) => {
    const current = await findWith(tx, input.workspaceId, input.peonId, input.result.commandId);
    if (!current || current.operation !== input.result.operation
      || current.connectionGeneration !== input.connectionGeneration
      || current.state !== "sent" || current.acceptedAt !== null
      || input.result.result !== null) return null;
    assertSafeReverseCommandResult(current, input.result);
    const updated = await tx.query<ReverseCommandRow>(
      `UPDATE reverse_commands
          SET state='terminal',completed_at=$5,terminal_status=$6,result_code=$7,
              result_message=$8,terminal_result=NULL,result_frame=$9,updated_at=$10,
              durable_committed_at=COALESCE(durable_committed_at,$10),last_error_code=NULL
        WHERE workspace_id=$1 AND command_id=$2 AND peon_id=$3 AND operation=$4
          AND connection_generation=$11 AND state='sent' AND accepted_at IS NULL
        RETURNING ${selectColumns()}`,
      [
        input.workspaceId,
        input.result.commandId,
        input.peonId,
        input.result.operation,
        input.result.completedAt,
        input.result.status,
        input.result.code,
        input.result.message ?? null,
        JSON.stringify(input.result),
        now,
        input.connectionGeneration,
      ],
    );
    if (!updated.rows[0]) return null;
    const record = rowToRecord(updated.rows[0]);
    const audit = await tx.query(
      `INSERT INTO reverse_command_audit
        (workspace_id,peon_id,command_id,user_id,operation,event,result_status,result_code,created_at)
       VALUES ($1,$2,$3,$4,$5,'terminal',$6,$7,$8)
       ON CONFLICT (workspace_id,peon_id,command_id,event) DO NOTHING
       RETURNING command_id`,
      [
        record.workspaceId,
        record.peonId,
        record.commandId,
        record.actor.userId,
        record.operation,
        input.result.status,
        input.result.code,
        now,
      ],
    );
    const event = audit.rows[0] ? await insertEvent(tx, {
      workspaceId: record.workspaceId,
      peonId: record.peonId,
      sessionId: record.target.sessionId ?? null,
      kind: "command",
      payload: {
        userId: record.actor.userId,
        commandId: record.commandId,
        peonId: record.peonId,
        operation: record.operation,
        state: "terminal",
        status: input.result.status,
        code: input.result.code,
        completedAt: input.result.completedAt,
        result: null,
      },
    }) : null;
    return { record, event };
  });
  if (committed?.event) {
    await publishCommittedEvent(committed.event).catch((error) => {
      console.warn("reverse command event fan-out failed:", error instanceof Error ? error.message : String(error));
    });
  }
  return committed?.record ?? null;
}

export async function rebindRecoverableReverseCommands(
  workspaceId: string,
  peonId: string,
  generation: string,
): Promise<ReverseCommandRecord[]> {
  await query(
    `UPDATE reverse_commands
        SET connection_generation=$3,updated_at=CASE WHEN state='terminal' THEN updated_at ELSE $4 END
      WHERE workspace_id=$1 AND peon_id=$2
        AND (state IN ('created','sent','accepted','running','unknown')
          OR (state='terminal' AND durable_committed_at IS NULL))
        AND EXISTS (
          SELECT 1 FROM peon_session_sync
           WHERE peon_id=$2 AND generation=$3
        )`,
    [workspaceId, peonId, generation, Date.now()],
  );
  const { rows } = await query<ReverseCommandRow>(
    `SELECT ${selectColumns()} FROM reverse_commands
      WHERE workspace_id=$1 AND peon_id=$2 AND connection_generation=$3
        AND state IN ('created','sent','accepted','running','unknown')
        AND EXISTS (
          SELECT 1 FROM peon_session_sync
           WHERE peon_id=$2 AND generation=$3
        )
      ORDER BY requested_at,command_id`,
    [workspaceId, peonId, generation],
  );
  return rows.map(rowToRecord);
}

export async function noteReverseCommandDisconnect(
  workspaceId: string,
  peonId: string,
  generation: string,
  code: string,
): Promise<ReverseCommandRecord[]> {
  const { rows } = await query<ReverseCommandRow>(
    `UPDATE reverse_commands SET last_error_code=$4,updated_at=$5
      WHERE workspace_id=$1 AND peon_id=$2 AND connection_generation=$3
        AND state IN ('sent','accepted','running','unknown')
      RETURNING ${selectColumns()}`,
    [workspaceId, peonId, generation, code, Date.now()],
  );
  return rows.map(rowToRecord);
}

async function applySafeProjection(
  tx: Transaction,
  record: ReverseCommandRecord,
  result: ReverseCommandResultFrame,
): Promise<LiveEvent | null> {
  if (!result.result) return null;
  if ((result.status !== "applied" && result.status !== "noop")) return null;
  const sessionId = typeof result.result.sessionId === "string" ? result.result.sessionId : null;
  const status = typeof result.result.sessionStatus === "string" ? result.result.sessionStatus : null;
  if (!sessionId || !status || sessionId !== record.target.sessionId) return null;
  const existing = await tx.query<{ raw: JsonObject }>(
    `SELECT raw FROM sessions WHERE peon_id=$1 AND session_id=$2`,
    [record.peonId, sessionId],
  );
  const raw = existing.rows[0]?.raw;
  if (!raw) return null;
  const syncedAt = Date.now();
  await tx.query(
    `UPDATE sessions SET status=$3,raw=$4,synced_at=$5 WHERE peon_id=$1 AND session_id=$2`,
    [record.peonId, sessionId, status, JSON.stringify({ ...raw, status }), syncedAt],
  );
  return insertEvent(tx, {
    workspaceId: record.workspaceId, peonId: record.peonId, sessionId,
    kind: "session", payload: { peonId: record.peonId, sessionId, status, syncedAt },
  });
}

export interface CommittedReverseCommandResult {
  record: ReverseCommandRecord;
  delivery: { epoch: string; acknowledgedCursor: string };
  event: LiveEvent | null;
  projectionEvent: LiveEvent | null;
}

export async function commitDurableReverseCommandResult(input: {
  workspaceId: string;
  peonId: string;
  connectionGeneration: string;
  syncGeneration: string;
  durable: DurableReverseCommandResult;
}): Promise<CommittedReverseCommandResult> {
  const committed = await transaction(async (tx) => {
    const sync = await tx.query<{ delivery_epoch: string | null; acknowledged_cursor: string | null }>(
      `SELECT delivery_epoch,acknowledged_cursor FROM peon_session_sync
        WHERE peon_id=$1 AND generation=$2`,
      [input.peonId, input.syncGeneration],
    );
    if (!sync.rows[0]) throw new Error("reverse command connection was replaced");

    const record = await findWith(tx, input.workspaceId, input.peonId, input.durable.result.commandId);
    if (!record || record.peonId !== input.peonId
      || record.operation !== input.durable.result.operation
      || record.connectionGeneration !== input.connectionGeneration) {
      throw new Error("uncorrelated reverse command result");
    }
    assertSafeReverseCommandResult(record, input.durable.result);
    if (record.resultFrame && canonicalJson(record.resultFrame as unknown as JsonObject)
      !== canonicalJson(input.durable.result as unknown as JsonObject)) {
      throw new Error("reverse command terminal result changed");
    }

    const inserted = await tx.query(
      `INSERT INTO peon_session_inbox (peon_id,epoch,cursor,created_at,message_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING cursor`,
      [
        input.peonId,
        input.durable.deliveryEpoch,
        input.durable.deliveryCursor,
        Date.now(),
        input.durable.messageId,
      ],
    );
    if (!inserted.rows[0]) {
      const duplicate = await tx.query<{ epoch: string; cursor: string; message_id: string | null }>(
        `SELECT epoch,cursor,message_id FROM peon_session_inbox
          WHERE peon_id=$1 AND (message_id=$2 OR (epoch=$3 AND cursor=$4))`,
        [
          input.peonId,
          input.durable.messageId,
          input.durable.deliveryEpoch,
          input.durable.deliveryCursor,
        ],
      );
      const row = duplicate.rows[0];
      if (!row || row.epoch !== input.durable.deliveryEpoch || row.cursor !== input.durable.deliveryCursor
        || row.message_id !== input.durable.messageId) {
        throw new Error("durable reverse command identity collision");
      }
    }

    const now = Date.now();
    const updated = await tx.query<ReverseCommandRow>(
      `UPDATE reverse_commands
          SET state='terminal',completed_at=$5,terminal_status=$6,result_code=$7,
              result_message=$8,terminal_result=$9,result_frame=$10,updated_at=$11,
              durable_committed_at=COALESCE(durable_committed_at,$11),last_error_code=NULL
        WHERE workspace_id=$1 AND command_id=$2 AND peon_id=$3 AND operation=$4
          AND connection_generation=$12
        RETURNING ${selectColumns()}`,
      [
        input.workspaceId,
        input.durable.result.commandId,
        input.peonId,
        input.durable.result.operation,
        input.durable.result.completedAt,
        input.durable.result.status,
        input.durable.result.code,
        input.durable.result.message ?? null,
        input.durable.result.result === null ? null : JSON.stringify(input.durable.result.result),
        JSON.stringify(input.durable.result),
        now,
        input.connectionGeneration,
      ],
    );
    if (!updated.rows[0]) throw new Error("reverse command result lost its generation fence");
    const next = rowToRecord(updated.rows[0]);
    const projectionEvent = await applySafeProjection(tx, next, input.durable.result);

    const audit = await tx.query(
      `INSERT INTO reverse_command_audit
        (workspace_id,peon_id,command_id,user_id,operation,event,result_status,result_code,created_at)
       VALUES ($1,$2,$3,$4,$5,'terminal',$6,$7,$8)
       ON CONFLICT (workspace_id,peon_id,command_id,event) DO NOTHING
       RETURNING command_id`,
      [
        next.workspaceId,
        next.peonId,
        next.commandId,
        next.actor.userId,
        next.operation,
        input.durable.result.status,
        input.durable.result.code,
        now,
      ],
    );
    const event = audit.rows[0] ? await insertEvent(tx, {
      workspaceId: next.workspaceId,
      peonId: next.peonId,
      sessionId: next.target.sessionId ?? null,
      kind: "command",
      payload: {
        userId: next.actor.userId,
        commandId: next.commandId,
        peonId: next.peonId,
        operation: next.operation,
        state: "terminal",
        status: input.durable.result.status,
        code: input.durable.result.code,
        completedAt: input.durable.result.completedAt,
        result: input.durable.result.result,
      },
    }) : null;

    if (inserted.rows[0]) {
      const advanced = await tx.query(
        `UPDATE peon_session_sync
            SET delivery_epoch=$3,acknowledged_cursor=$4,updated_at=$5
          WHERE peon_id=$1 AND generation=$2 RETURNING peon_id`,
        [input.peonId, input.syncGeneration, input.durable.deliveryEpoch, input.durable.deliveryCursor, now],
      );
      if (!advanced.rows[0]) throw new Error("reverse command connection was replaced");
    }
    const checkpoint = await tx.query<{ delivery_epoch: string | null; acknowledged_cursor: string | null }>(
      `SELECT delivery_epoch,acknowledged_cursor FROM peon_session_sync
        WHERE peon_id=$1 AND generation=$2`,
      [input.peonId, input.syncGeneration],
    );
    const delivery = checkpoint.rows[0];
    if (!delivery?.delivery_epoch || !delivery.acknowledged_cursor) {
      throw new Error("reverse command delivery checkpoint missing");
    }
    return {
      record: next,
      delivery: { epoch: delivery.delivery_epoch, acknowledgedCursor: delivery.acknowledged_cursor },
      event,
      projectionEvent,
    };
  });
  if (committed.event) {
    await publishCommittedEvent(committed.event).catch((error) => {
      console.warn("reverse command event fan-out failed:", error instanceof Error ? error.message : String(error));
    });
  }
  if (committed.projectionEvent) {
    await publishCommittedEvent(committed.projectionEvent).catch((error) => {
      console.warn("reverse command projection fan-out failed:", error instanceof Error ? error.message : String(error));
    });
  }
  return committed;
}

export function reverseCommandRegistryActiveStates(): readonly string[] {
  return ACTIVE_STATES;
}
