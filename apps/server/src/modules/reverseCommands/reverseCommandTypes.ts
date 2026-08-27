import { createHash } from "node:crypto";
import {
  REVERSE_COMMAND_CAPABILITY,
  REVERSE_COMMAND_MAX_FRAME_BYTES,
  REVERSE_COMMAND_OPERATIONS,
  type JsonObject,
  type JsonValue,
  type ReverseCommandAcceptedFrame,
  type ReverseCommandEnvelope,
  type ReverseCommandOperation,
  type ReverseCommandResultFrame,
  type ReverseCommandResultStatus,
  type ReverseCommandStatusFrame,
  type ReverseCommandTarget,
} from "@rnm-dev/protocol";
import type { AuthenticatedActor } from "../auth/index.js";

export {
  REVERSE_COMMAND_CAPABILITY,
  REVERSE_COMMAND_MAX_FRAME_BYTES,
  REVERSE_COMMAND_OPERATIONS,
};
export type {
  JsonObject,
  JsonValue,
  ReverseCommandAcceptedFrame,
  ReverseCommandEnvelope,
  ReverseCommandOperation,
  ReverseCommandResultFrame,
  ReverseCommandResultStatus,
  ReverseCommandStatusFrame,
  ReverseCommandTarget,
};

export type ReverseCommandState =
  | "created"
  | "sent"
  | "accepted"
  | "running"
  | "terminal"
  | "unknown"
  | "send_failed";
/** @deprecated Use AuthenticatedActor from the auth module for new server code. */
export type ReverseCommandActor = AuthenticatedActor;

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
  actor: AuthenticatedActor;
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

// Valid acknowledgements can arrive after a command was rebound to a newer
// socket generation. That is stale correlation noise, not a wire violation.
export class ReverseCommandCorrelationError extends Error {}

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
  actor: AuthenticatedActor;
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

export function reverseCommandPayloadIsTransient(_operation: ReverseCommandOperation): boolean {
  return false;
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
  if (channel.protocol !== 1 || !Array.isArray(channel.operations) || channel.operations.length > 64) {
    throw new ReverseCommandProtocolError("invalid reverse command hello");
  }
  const advertised = channel.operations.map((value) => {
    if (typeof value !== "string" || value.length < 1 || value.length > 80
      || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)) {
      throw new ReverseCommandProtocolError("invalid reverse command operation");
    }
    return value;
  });
  if (new Set(advertised).size !== advertised.length) {
    throw new ReverseCommandProtocolError("duplicate reverse command operation");
  }
  return advertised.filter(isReverseCommandOperation);
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

const RUNTIME_FORBIDDEN_KEY = /(?:credential|secret|token|password|authorization|authresponse|environment|executablepath|filetransferroot)/i;
function assertSafeRuntimeValue(value: unknown, depth = 0): void {
  if (depth > 12) throw new ReverseCommandProtocolError("runtime query result is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new ReverseCommandProtocolError("runtime query result array is too large");
    for (const item of value) assertSafeRuntimeValue(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") {
    throw new ReverseCommandProtocolError("runtime query result contains an unsupported value");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 1_000 || entries.some(([key]) => RUNTIME_FORBIDDEN_KEY.test(key))) {
    throw new ReverseCommandProtocolError("runtime query result contains a forbidden field");
  }
  for (const [, item] of entries) assertSafeRuntimeValue(item, depth + 1);
}

// The shared wire schema intentionally leaves result extensible. Overseer does
// not: every enabled operation must reduce terminal detail to an explicit,
// browser-safe shape before it can be persisted or published.
export function assertSafeReverseCommandResult(
  record: Pick<ReverseCommandRecord, "operation" | "target"> & Partial<Pick<ReverseCommandRecord, "commandId">>,
  result: ReverseCommandResultFrame,
): void {
  if (result.operation !== record.operation) {
    throw new ReverseCommandProtocolError("unsupported reverse command result operation");
  }
  if ((record.operation as string).startsWith("runtime.")) {
    if (result.message !== undefined) throw new ReverseCommandProtocolError("unsafe runtime query result detail");
    if (result.status === "applied" && result.code === "OK" && result.result
      && Buffer.byteLength(JSON.stringify(result.result), "utf8") <= REVERSE_COMMAND_MAX_FRAME_BYTES) {
      assertSafeRuntimeValue(result.result);
      return;
    }
    if (result.status === "rejected" && result.result === null
      && ["BAD_COMMAND", "UNKNOWN_PROVIDER", "PAYLOAD_TOO_LARGE", "RATE_LIMITED"].includes(result.code)) return;
    if (result.status === "failed" && result.result === null && result.code === "INTERNAL") return;
    throw new ReverseCommandProtocolError("invalid runtime query result tuple");
  }
  throw new ReverseCommandProtocolError("unsupported reverse command result operation");
}


function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum;
}

function assertProjectDocPage(value: unknown): void {
  if (value === null) return;
  const page = object(value, "project documentation page");
  strict(page, ["path", "name", "title", "content", "size", "mtimeMs", "truncated"], "project documentation page");
  if (!boundedString(page.path, 4_096) || !boundedString(page.name, 512)
    || !boundedString(page.title, 4_096) || !boundedString(page.content, 48 * 1024)
    || !Number.isSafeInteger(page.size) || Number(page.size) < 0
    || typeof page.mtimeMs !== "number" || !Number.isFinite(page.mtimeMs)
    || typeof page.truncated !== "boolean") {
    throw new ReverseCommandProtocolError("invalid project documentation page");
  }
}

function assertProjectDocTree(value: unknown, depth = 0, count = { value: 0 }): void {
  if (!Array.isArray(value) || depth > 20) throw new ReverseCommandProtocolError("invalid project documentation tree");
  for (const item of value) {
    if (++count.value > 2_000) throw new ReverseCommandProtocolError("project documentation tree is too large");
    const node = object(item, "project documentation node");
    if (node.type === "file") {
      strict(node, ["type", "name", "path", "size", "mtimeMs"], "project documentation file");
      if (!boundedString(node.name, 512) || !boundedString(node.path, 4_096)
        || !Number.isSafeInteger(node.size) || Number(node.size) < 0
        || typeof node.mtimeMs !== "number" || !Number.isFinite(node.mtimeMs)) {
        throw new ReverseCommandProtocolError("invalid project documentation file");
      }
    } else if (node.type === "directory") {
      strict(node, ["type", "name", "path", "children"], "project documentation directory");
      if (!boundedString(node.name, 512) || !boundedString(node.path, 4_096)) {
        throw new ReverseCommandProtocolError("invalid project documentation directory");
      }
      assertProjectDocTree(node.children, depth + 1, count);
    } else {
      throw new ReverseCommandProtocolError("invalid project documentation node");
    }
  }
}

function assertProjectDocumentation(value: unknown): void {
  const documentation = object(value, "project documentation");
  strict(documentation, ["exists", "indexPath", "index", "tree"], "project documentation");
  if (typeof documentation.exists !== "boolean" || documentation.indexPath !== "index.md") {
    throw new ReverseCommandProtocolError("invalid project documentation");
  }
  assertProjectDocPage(documentation.index);
  assertProjectDocTree(documentation.tree);
}

export function parseProjectDocumentationSnapshot(serialized: string): JsonObject {
  if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) {
    throw new ReverseCommandProtocolError("project documentation snapshot is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new ReverseCommandProtocolError("invalid project documentation snapshot");
  }
  assertProjectDocumentation(value);
  return value as JsonObject;
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
  strict(message, [
    "type", "epoch", "cursor", "messageId", "priority", "capability", "payload",
  ], "durable command result");
  if (message.type !== "durable_message" || message.capability !== REVERSE_COMMAND_CAPABILITY) {
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

export function safeReverseCommandTerminalFrame(
  record: ReverseCommandRecord,
): ReverseCommandResultFrame | null {
  if (record.state !== "terminal" || !record.resultFrame) return null;
  try {
    assertSafeReverseCommandResult(record, record.resultFrame);
  } catch {
    return null;
  }
  const frame = record.resultFrame;
  if (record.terminalStatus !== frame.status
    || record.code !== frame.code
    || record.message !== (frame.message ?? null)
    || record.completedAt !== frame.completedAt
    || canonicalJson((record.result ?? null) as JsonValue)
      !== canonicalJson((frame.result ?? null) as JsonValue)) {
    return null;
  }
  return frame;
}

export function safeReverseCommandView(record: ReverseCommandRecord): Record<string, unknown> {
  const terminal = safeReverseCommandTerminalFrame(record);
  const unsafeTerminal = record.state === "terminal" && !terminal;
  return {
    commandId: record.commandId,
    peonId: record.peonId,
    operation: record.operation,
    state: record.state,
    requestedAt: record.requestedAt,
    sentAt: record.sentAt,
    acceptedAt: record.acceptedAt,
    completedAt: terminal?.completedAt ?? null,
    status: terminal?.status ?? null,
    code: unsafeTerminal ? "UNSAFE_RESULT" : terminal?.code ?? record.lastErrorCode,
    message: null,
    result: terminal?.result ?? null,
    replayed: record.replayed,
    committed: record.durableCommittedAt !== null,
  };
}
