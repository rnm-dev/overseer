import { createHash } from "node:crypto";

export const REVERSE_COMMAND_CAPABILITY = "reverse-command-v1";
export const REVERSE_COMMAND_MAX_FRAME_BYTES = 60 * 1024;

export const REVERSE_COMMAND_OPERATIONS = [
  "session.cancel",
] as const;

export type ReverseCommandOperation = typeof REVERSE_COMMAND_OPERATIONS[number];
export type ReverseCommandState =
  | "created"
  | "sent"
  | "accepted"
  | "running"
  | "terminal"
  | "unknown"
  | "send_failed";
export type ReverseCommandResultStatus =
  | "applied"
  | "noop"
  | "rejected"
  | "conflict"
  | "cancelled"
  | "failed";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ReverseCommandActor {
  userId: string;
  email: string;
}

export interface ReverseCommandTarget {
  peonId: string;
  sessionId?: string;
}

export interface ReverseCommandEnvelope {
  type: "command";
  protocol: 1;
  capability: typeof REVERSE_COMMAND_CAPABILITY;
  commandId: string;
  operation: ReverseCommandOperation;
  target: ReverseCommandTarget;
  actor: ReverseCommandActor;
  payload: JsonObject;
  expected?: JsonObject | null;
  requestedAt: number;
}

export interface ReverseCommandAcceptedFrame {
  type: "command_accepted";
  protocol: 1;
  commandId: string;
  operation: ReverseCommandOperation;
  state: "accepted" | "running";
  replayed: boolean;
  acceptedAt: number;
}

export interface ReverseCommandResultFrame {
  type: "command_result";
  protocol: 1;
  commandId: string;
  operation: ReverseCommandOperation;
  status: ReverseCommandResultStatus;
  code: string;
  message?: string;
  completedAt: number;
  result: JsonObject | null;
}

export interface ReverseCommandStatusFrame {
  type: "command_status";
  protocol: 1;
  commandId: string;
  state: "unknown" | "accepted" | "running" | "terminal";
  result?: ReverseCommandResultFrame;
}

export interface DurableReverseCommandResult {
  channel: "command";
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
  result: ReverseCommandResultFrame;
}

export interface ReverseCommandRecord {
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
  state: ReverseCommandState;
  connectionGeneration: string | null;
  requestedAt: number;
  sentAt: number | null;
  acceptedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  terminalStatus: ReverseCommandResultStatus | null;
  code: string | null;
  message: string | null;
  result: JsonObject | null;
  resultFrame: ReverseCommandResultFrame | null;
  replayed: boolean;
  attemptCount: number;
  lastErrorCode: string | null;
  durableCommittedAt: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESULT_STATUSES = new Set<ReverseCommandResultStatus>([
  "applied",
  "noop",
  "rejected",
  "conflict",
  "cancelled",
  "failed",
]);
const OPERATIONS = new Set<string>(REVERSE_COMMAND_OPERATIONS);

export class ReverseCommandProtocolError extends Error {}

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isReverseCommandOperation(value: unknown): value is ReverseCommandOperation {
  return typeof value === "string" && OPERATIONS.has(value);
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

export function reverseCommandRequestHash(input: {
  operation: ReverseCommandOperation;
  target: ReverseCommandTarget;
  actor: ReverseCommandActor;
  payload: JsonObject;
  expected?: JsonObject | null;
}): string {
  return createHash("sha256").update(canonicalJson({
    protocol: 1,
    capability: REVERSE_COMMAND_CAPABILITY,
    operation: input.operation,
    target: input.target as unknown as JsonObject,
    actor: input.actor as unknown as JsonObject,
    payload: input.payload,
    expected: input.expected ?? null,
  })).digest("hex");
}

export function reverseCommandFrame(record: ReverseCommandRecord): ReverseCommandEnvelope {
  return {
    type: "command",
    protocol: 1,
    capability: REVERSE_COMMAND_CAPABILITY,
    commandId: record.commandId,
    operation: record.operation,
    target: record.target,
    actor: record.actor,
    payload: record.payload,
    expected: record.expected,
    requestedAt: record.requestedAt,
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReverseCommandProtocolError(`invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function strict(value: Record<string, unknown>, fields: readonly string[], field: string): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new ReverseCommandProtocolError(`unknown ${field} field`);
  }
}

function time(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ReverseCommandProtocolError(`invalid ${field}`);
  }
  return value;
}

function commandId(value: unknown): string {
  if (!isCanonicalUuid(value)) throw new ReverseCommandProtocolError("invalid commandId");
  return value;
}

function operation(value: unknown): ReverseCommandOperation {
  if (!isReverseCommandOperation(value)) throw new ReverseCommandProtocolError("invalid reverse command operation");
  return value;
}

export function parseReverseCommandHello(frame: Record<string, unknown>): ReverseCommandOperation[] {
  const channels = object(frame.channels, "channels");
  const channel = object(channels[REVERSE_COMMAND_CAPABILITY], REVERSE_COMMAND_CAPABILITY);
  strict(channel, ["protocol", "operations"], "reverse command hello");
  if (channel.protocol !== 1 || !Array.isArray(channel.operations)) {
    throw new ReverseCommandProtocolError("invalid reverse command hello");
  }
  const operations = channel.operations.map(operation);
  if (new Set(operations).size !== operations.length) {
    throw new ReverseCommandProtocolError("duplicate reverse command operation");
  }
  return operations;
}

export function parseReverseCommandAccepted(value: Record<string, unknown>): ReverseCommandAcceptedFrame {
  strict(value, ["type", "protocol", "commandId", "operation", "state", "replayed", "acceptedAt"], "command_accepted");
  if (value.type !== "command_accepted" || value.protocol !== 1
    || (value.state !== "accepted" && value.state !== "running")
    || typeof value.replayed !== "boolean") {
    throw new ReverseCommandProtocolError("invalid command_accepted frame");
  }
  return {
    type: "command_accepted",
    protocol: 1,
    commandId: commandId(value.commandId),
    operation: operation(value.operation),
    state: value.state,
    replayed: value.replayed,
    acceptedAt: time(value.acceptedAt, "acceptedAt"),
  };
}

export function parseReverseCommandResult(value: unknown): ReverseCommandResultFrame {
  const frame = object(value, "command_result");
  strict(frame, [
    "type", "protocol", "commandId", "operation", "status", "code", "message", "completedAt", "result",
  ], "command_result");
  if (frame.type !== "command_result" || frame.protocol !== 1
    || typeof frame.status !== "string" || !RESULT_STATUSES.has(frame.status as ReverseCommandResultStatus)
    || typeof frame.code !== "string" || frame.code.length < 2 || frame.code.length > 80
    || (frame.message !== undefined && (typeof frame.message !== "string" || frame.message.length > 1_000))
    || !Object.hasOwn(frame, "result")) {
    throw new ReverseCommandProtocolError("invalid command_result frame");
  }
  const result = frame.result === null ? null : object(frame.result, "command result detail") as JsonObject;
  return {
    type: "command_result",
    protocol: 1,
    commandId: commandId(frame.commandId),
    operation: operation(frame.operation),
    status: frame.status as ReverseCommandResultStatus,
    code: frame.code,
    ...(typeof frame.message === "string" ? { message: frame.message } : {}),
    completedAt: time(frame.completedAt, "completedAt"),
    result,
  };
}

const SESSION_CANCEL_REJECTED_CODES = new Set([
  "BAD_COMMAND",
  "COMMAND_EXPIRED",
  "COMMAND_LEDGER_FULL",
  "SESSION_NOT_RUNNING",
  "UNKNOWN_SESSION",
]);
const SESSION_CANCEL_FAILED_CODES = new Set(["INTERNAL", "PERSIST_FAILED"]);
const SESSION_CANCEL_TERMINAL_STATES = new Set(["cancelled", "completed"]);

// The shared wire schema intentionally leaves result extensible. Overseer does
// not: every enabled operation must reduce terminal detail to an explicit,
// browser-safe shape before it can be persisted or published.
export function assertSafeReverseCommandResult(
  record: Pick<ReverseCommandRecord, "operation" | "target">,
  result: ReverseCommandResultFrame,
): void {
  if (record.operation !== "session.cancel" || result.operation !== record.operation) {
    throw new ReverseCommandProtocolError("unsupported reverse command result operation");
  }
  if (result.message !== undefined) {
    throw new ReverseCommandProtocolError("unsafe session.cancel result detail");
  }
  if (result.status === "rejected") {
    if (!SESSION_CANCEL_REJECTED_CODES.has(result.code) || result.result !== null) {
      throw new ReverseCommandProtocolError("invalid session.cancel result tuple");
    }
    return;
  }
  if (result.status === "conflict") {
    if (result.code !== "COMMAND_ID_REUSED" || result.result !== null) {
      throw new ReverseCommandProtocolError("invalid session.cancel result tuple");
    }
    return;
  }
  if (result.status === "failed") {
    if (!SESSION_CANCEL_FAILED_CODES.has(result.code) || result.result !== null) {
      throw new ReverseCommandProtocolError("invalid session.cancel result tuple");
    }
    return;
  }
  if ((result.status !== "applied" && result.status !== "noop") || result.code !== "OK") {
    throw new ReverseCommandProtocolError("invalid session.cancel result tuple");
  }
  const detail = result.result;
  if (!detail || Object.keys(detail).length !== 2
    || !isCanonicalUuid(detail.sessionId)
    || detail.sessionId !== record.target.sessionId
    || typeof detail.sessionStatus !== "string"
    || !SESSION_CANCEL_TERMINAL_STATES.has(detail.sessionStatus)) {
    throw new ReverseCommandProtocolError("unsafe session.cancel result detail");
  }
}

export function parseReverseCommandStatus(value: Record<string, unknown>): ReverseCommandStatusFrame {
  strict(value, ["type", "protocol", "commandId", "state", "result"], "command_status");
  if (value.type !== "command_status" || value.protocol !== 1
    || !["unknown", "accepted", "running", "terminal"].includes(String(value.state))) {
    throw new ReverseCommandProtocolError("invalid command_status frame");
  }
  const state = value.state as ReverseCommandStatusFrame["state"];
  if ((state === "terminal") !== (value.result !== undefined)) {
    throw new ReverseCommandProtocolError("terminal command status/result mismatch");
  }
  return {
    type: "command_status",
    protocol: 1,
    commandId: commandId(value.commandId),
    state,
    ...(state === "terminal" ? { result: parseReverseCommandResult(value.result) } : {}),
  };
}

export function parseDurableReverseCommandResult(message: Record<string, unknown>): DurableReverseCommandResult {
  if (message.capability !== REVERSE_COMMAND_CAPABILITY) {
    throw new ReverseCommandProtocolError("invalid durable reverse command capability");
  }
  if (typeof message.epoch !== "string" || !message.epoch || message.epoch.length > 200
    || typeof message.cursor !== "string" || !message.cursor || message.cursor.length > 200
    || !isCanonicalUuid(message.messageId)
    || !["critical", "control", "normal", "bulk"].includes(String(message.priority))) {
    throw new ReverseCommandProtocolError("invalid durable command result envelope");
  }
  return {
    channel: "command",
    deliveryEpoch: message.epoch,
    deliveryCursor: message.cursor,
    messageId: message.messageId,
    result: parseReverseCommandResult(message.payload),
  };
}

export function safeReverseCommandView(record: ReverseCommandRecord): Record<string, unknown> {
  let terminalDetailSafe = record.state !== "terminal";
  if (record.state === "terminal" && record.resultFrame) {
    try {
      assertSafeReverseCommandResult(record, record.resultFrame);
      terminalDetailSafe = true;
    } catch {
      terminalDetailSafe = false;
    }
  }
  return {
    commandId: record.commandId,
    peonId: record.peonId,
    operation: record.operation,
    state: record.state,
    requestedAt: record.requestedAt,
    sentAt: record.sentAt,
    acceptedAt: record.acceptedAt,
    completedAt: record.completedAt,
    status: terminalDetailSafe ? record.terminalStatus : null,
    code: terminalDetailSafe ? record.code ?? record.lastErrorCode : "UNSAFE_RESULT",
    message: null,
    result: terminalDetailSafe ? record.result : null,
    replayed: record.replayed,
    committed: record.durableCommittedAt !== null,
  };
}
