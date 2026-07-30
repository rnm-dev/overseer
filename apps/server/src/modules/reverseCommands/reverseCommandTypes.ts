import { createHash } from "node:crypto";

export const REVERSE_COMMAND_CAPABILITY = "reverse-command-v1";
export const REVERSE_COMMAND_MAX_FRAME_BYTES = 60 * 1024;

export const REVERSE_COMMAND_OPERATIONS = [
  "session.detail", "session.cancel", "session.start", "session.followup",
  "session.queue.list", "session.queue.add", "session.queue.edit",
  "session.queue.remove", "session.queue.send-now",
  "session.metadata.patch", "session.delete",
  "project.create", "project.suggest-directory", "project.detail",
  "project.settings.get", "project.settings.update", "project.delete",
  "project.documentation.index", "project.documentation.read", "project.skills.list",
  "project.quick-links.list", "project.quick-links.create",
  "project.quick-links.update", "project.quick-links.delete",
  "runtime.stats",
  "runtime.analytics",
  "runtime.quota",
  "runtime.capabilities",
  "daemon.configuration.patch",
  "update.check", "update.apply",
  "armory.inventory", "armory.refresh", "armory.install", "armory.update",
  "armory.enable", "armory.disable", "armory.uninstall", "armory.configure", "armory.verify",
  "armory.configuration.delete", "armory.package", "armory.configuration",
  "armory.mcp", "armory.operation", "armory.settings",
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
  projectId?: string;
  packageId?: string;
  operationId?: string;
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

export function reverseCommandPayloadIsTransient(operation: ReverseCommandOperation): boolean {
  return operation === "armory.configure";
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

const SESSION_CANCEL_REJECTED_CODES = new Set([
  "BAD_COMMAND",
  "COMMAND_EXPIRED",
  "COMMAND_LEDGER_FULL",
  "SESSION_NOT_RUNNING",
  "UNKNOWN_SESSION",
]);
const SESSION_CANCEL_FAILED_CODES = new Set(["INTERNAL", "PERSIST_FAILED"]);
const SESSION_CANCEL_TERMINAL_STATES = new Set(["cancelled", "completed"]);
const SESSION_OPERATIONS = new Set(REVERSE_COMMAND_OPERATIONS.filter((value) => value.startsWith("session.")));
const SESSION_REJECTED_CODES = new Set([
  "BAD_COMMAND", "COMMAND_EXPIRED", "COMMAND_LEDGER_FULL", "RESULT_TOO_LARGE",
  "UNKNOWN_SESSION", "UNKNOWN_PROJECT", "UNKNOWN_QUEUE_ITEM", "INVALID_MODEL",
  "INVALID_REASONING_EFFORT", "FILES_DISABLED", "PATH_ESCAPE",
  "UNKNOWN_ATTACHMENT_PATH", "ATTACHMENT_CHANGED", "DIR_MISSING",
  "SESSION_NOT_RUNNING",
]);
const RUNTIME_FORBIDDEN_KEY = /(?:credential|secret|token|password|authorization|authresponse|environment|executablepath|filetransferroot)/i;
const PROJECT_REJECTED_CODES = new Set([
  "BAD_COMMAND", "COMMAND_EXPIRED", "COMMAND_LEDGER_FULL", "UNKNOWN_PROJECT",
  "BAD_REQUEST", "UNKNOWN_QUICK_LINK", "INVALID_PATH", "PATH_ESCAPE", "NOT_FOUND",
  "IS_DIRECTORY", "UNSUPPORTED_MEDIA_TYPE", "FORBIDDEN", "RESULT_TOO_LARGE",
  "INVALID_CURSOR",
]);
const PROJECT_CONFLICT_CODES = new Set([
  "COMMAND_ID_REUSED", "PROJECT_CONFLICT", "PROJECT_EXISTS", "PROJECT_RUNNING",
  "CURSOR_EXPIRED",
]);

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
  if (record.operation === "daemon.configuration.patch") {
    assertSafeDaemonConfigurationResult(result);
    return;
  }
  if (record.operation.startsWith("armory.")) {
    if (result.message !== undefined
      || (result.result !== null && Buffer.byteLength(JSON.stringify(result.result), "utf8") > 48 * 1024)) {
      throw new ReverseCommandProtocolError("unsafe Armory result detail");
    }
    if (result.status === "applied" && result.code === "OK" && result.result) return;
    if (result.result === null && ["rejected", "conflict", "failed"].includes(result.status)
      && /^[A-Z][A-Z0-9_]{1,63}$/.test(result.code)) return;
    throw new ReverseCommandProtocolError("invalid Armory result tuple");
  }
  if (record.operation.startsWith("update.")) {
    assertSafeUpdateResult(record.operation, result);
    return;
  }
  if (record.operation.startsWith("runtime.")) {
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
  if (record.operation.startsWith("project.")) {
    assertSafeProjectResult(record, result);
    return;
  }
  if (SESSION_OPERATIONS.has(record.operation) && record.operation !== "session.cancel") {
    assertSafeSessionResult(record, result);
    return;
  }
  if (record.operation !== "session.cancel") {
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

const PUBLIC_SESSION_FIELDS = [
  "id", "prompt", "title", "followUpPrompts", "queuedFollowUps", "dir", "agent",
  "backendSessionId", "backendTurnId", "backendRuntimeGeneration", "backendTurnStatus",
  "model", "reasoningEffort", "projectId", "projectKey", "candidateProjectKeys",
  "taskKey", "taskTitle", "initiator", "parentSessionId", "spawnDepth", "spawnRequestId",
  "expectsOutcome", "status", "outcome", "startedAt", "endedAt", "turnCount", "turnBudget",
  "usage", "usageByModel", "contextUsage", "autoResumeAttempts", "lastActivityAt",
  "lastUserMessageAt", "lastMessagePreview", "eventCount",
] as const;

function assertPublicSession(value: unknown, sessionId: string): void {
  const detail = object(value, "public session");
  strict(detail, PUBLIC_SESSION_FIELDS, "public session");
  if (detail.id !== sessionId || !isCanonicalUuid(detail.id)
    || (detail.status !== "running" && detail.status !== "completed")) {
    throw new ReverseCommandProtocolError("invalid public session identity");
  }
}

function assertQueueItem(value: unknown, sessionId: string): void {
  const item = object(value, "queue item");
  strict(item, [
    "id", "sessionId", "prompt", "attachments", "permissionMode", "author",
    "model", "reasoningEffort", "commandId", "queuedAt",
  ], "queue item");
  if (!isCanonicalUuid(item.id) || item.sessionId !== sessionId
    || !boundedString(item.prompt, 32 * 1024)
    || !Array.isArray(item.attachments) || item.attachments.length > 20
    || (item.permissionMode !== null && !boundedString(item.permissionMode, 64))
    || (item.author !== null && !boundedString(item.author, 320))
    || (item.model !== null && !boundedString(item.model, 200))
    || (item.reasoningEffort !== null && !boundedString(item.reasoningEffort, 64))
    || (item.commandId !== null && (!boundedString(item.commandId, 255) || item.commandId.length === 0))
    || !Number.isSafeInteger(item.queuedAt) || Number(item.queuedAt) < 0) {
    throw new ReverseCommandProtocolError("invalid queue item");
  }
  for (const attachment of item.attachments) {
    const detail = object(attachment, "queue attachment");
    strict(detail, ["originalName", "filename", "path", "size", "mimetype"], "queue attachment");
    if (!boundedString(detail.originalName, 512) || !boundedString(detail.filename, 512)
      || !boundedString(detail.path, 4_096) || !Number.isSafeInteger(detail.size)
      || Number(detail.size) < 0 || !boundedString(detail.mimetype, 128)) {
      throw new ReverseCommandProtocolError("invalid queue attachment");
    }
  }
}

function assertSafeSessionResult(
  record: Pick<ReverseCommandRecord, "operation" | "target"> & Partial<Pick<ReverseCommandRecord, "commandId">>,
  result: ReverseCommandResultFrame,
): void {
  if (result.message !== undefined
    || (result.result !== null && Buffer.byteLength(JSON.stringify(result.result), "utf8") > 48 * 1024)) {
    throw new ReverseCommandProtocolError("unsafe session result detail");
  }
  if (result.result === null) {
    if (result.status === "rejected" && SESSION_REJECTED_CODES.has(result.code)) return;
    if (result.status === "conflict" && [
      "COMMAND_ID_REUSED", "RESUME_IN_PROGRESS", "SESSION_RUNNING",
    ].includes(result.code)) return;
    if (result.status === "failed" && ["INTERNAL", "PERSIST_FAILED"].includes(result.code)) return;
    throw new ReverseCommandProtocolError("invalid session result tuple");
  }
  if (!["applied", "noop"].includes(result.status) || result.code !== "OK") {
    throw new ReverseCommandProtocolError("invalid session result tuple");
  }
  const sessionId = record.operation === "session.start" ? record.commandId : record.target.sessionId;
  if (!sessionId) throw new ReverseCommandProtocolError("missing session result identity");
  if (["session.detail", "session.start", "session.followup", "session.metadata.patch"].includes(record.operation)) {
    if (result.status !== "applied") throw new ReverseCommandProtocolError("invalid session result status");
    assertPublicSession(result.result, sessionId);
    return;
  }
  const detail = object(result.result, "session result");
  if (detail.sessionId !== sessionId || !isCanonicalUuid(detail.sessionId)) {
    throw new ReverseCommandProtocolError("invalid session result identity");
  }
  if (record.operation === "session.queue.list") {
    strict(detail, ["sessionId", "items"], "queue list");
    if (result.status !== "applied" || !Array.isArray(detail.items)
      || Buffer.byteLength(JSON.stringify(detail.items), "utf8") > 48 * 1024) {
      throw new ReverseCommandProtocolError("invalid queue list");
    }
    for (const item of detail.items) assertQueueItem(item, sessionId);
    return;
  }
  if (record.operation === "session.queue.add" || record.operation === "session.queue.edit") {
    strict(detail, ["sessionId", "itemId", "session"], "queue mutation");
    if (result.status !== "applied" || !isCanonicalUuid(detail.itemId)) {
      throw new ReverseCommandProtocolError("invalid queue mutation");
    }
    assertPublicSession(detail.session, sessionId);
    return;
  }
  if (record.operation === "session.queue.remove" || record.operation === "session.queue.send-now") {
    strict(detail, ["sessionId", "itemId"], "queue mutation");
    if (result.status !== "applied" || !isCanonicalUuid(detail.itemId)) {
      throw new ReverseCommandProtocolError("invalid queue mutation");
    }
    return;
  }
  if (record.operation === "session.delete") {
    strict(detail, ["sessionId", "deleted"], "session deletion");
    if (detail.deleted !== true) throw new ReverseCommandProtocolError("invalid session deletion");
    return;
  }
  throw new ReverseCommandProtocolError("unsupported session result operation");
}


function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum;
}

function projectDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function assertProjectLink(value: unknown): void {
  const link = object(value, "project quick link");
  strict(link, ["id", "title", "url", "order"], "project quick link");
  let parsed: URL;
  try {
    parsed = new URL(String(link.url));
  } catch {
    throw new ReverseCommandProtocolError("invalid project quick link");
  }
  if (!isCanonicalUuid(link.id) || !boundedString(link.title, 120)
    || !boundedString(link.url, 2_048) || !["http:", "https:"].includes(parsed.protocol)
    || !Number.isSafeInteger(link.order) || Number(link.order) < 0) {
    throw new ReverseCommandProtocolError("invalid project quick link");
  }
}

function assertProjectLinks(value: unknown): void {
  if (!Array.isArray(value) || value.length > 100) throw new ReverseCommandProtocolError("invalid project quick links");
  for (const link of value) assertProjectLink(link);
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

function assertProjectBase(
  detail: Record<string, unknown>,
  targetProjectId: string | undefined,
  fields: readonly string[],
): void {
  strict(detail, fields, "project result");
  if (!isCanonicalUuid(detail.projectId) || (targetProjectId && detail.projectId !== targetProjectId)
    || (fields.includes("key") && !boundedString(detail.key, 256))) {
    throw new ReverseCommandProtocolError("invalid project result identity");
  }
}

function assertSafeProjectResult(
  record: Pick<ReverseCommandRecord, "operation" | "target">,
  result: ReverseCommandResultFrame,
): void {
  if (result.message !== undefined
    || (result.result !== null && Buffer.byteLength(JSON.stringify(result.result), "utf8") > 48 * 1024)) {
    throw new ReverseCommandProtocolError("unsafe project result detail");
  }
  if (result.result === null) {
    if (result.status === "rejected" && PROJECT_REJECTED_CODES.has(result.code)) return;
    if (result.status === "conflict" && PROJECT_CONFLICT_CODES.has(result.code)) return;
    if (result.status === "failed" && ["INTERNAL", "PERSIST_FAILED"].includes(result.code)) return;
    throw new ReverseCommandProtocolError("invalid project result tuple");
  }
  if (result.status !== "applied" || result.code !== "OK") {
    throw new ReverseCommandProtocolError("invalid project result tuple");
  }
  const detail = object(result.result, "project result");
  const projectId = record.target.projectId;
  switch (record.operation) {
    case "project.create":
      assertProjectBase(detail, undefined, [
        "projectId", "key", "label", "dir", "quickLinks", "archivedAt",
        "lastSyncedAt", "onboardingSessionId", "digest",
      ]);
      if (!boundedString(detail.label, 512) || !boundedString(detail.dir, 4_096)
        || (detail.archivedAt !== null && !Number.isSafeInteger(detail.archivedAt))
        || !Number.isSafeInteger(detail.lastSyncedAt)
        || (detail.onboardingSessionId !== null && !isCanonicalUuid(detail.onboardingSessionId))
        || !projectDigest(detail.digest)) throw new ReverseCommandProtocolError("invalid project create result");
      assertProjectLinks(detail.quickLinks);
      return;
    case "project.suggest-directory":
      strict(detail, ["key", "dir"], "project suggestion");
      if (!boundedString(detail.key, 256) || !boundedString(detail.dir, 4_096)) {
        throw new ReverseCommandProtocolError("invalid project suggestion");
      }
      return;
    case "project.detail":
      assertProjectBase(detail, projectId, [
        "projectId", "key", "label", "dir", "quickLinks", "archivedAt",
        "lastSyncedAt", "digest", "documentation",
      ]);
      if (!boundedString(detail.label, 512) || !boundedString(detail.dir, 4_096)
        || !projectDigest(detail.digest)) throw new ReverseCommandProtocolError("invalid project detail");
      assertProjectLinks(detail.quickLinks);
      assertProjectDocumentation(detail.documentation);
      return;
    case "project.settings.get":
    case "project.settings.update":
      assertProjectBase(detail, projectId, ["projectId", "key", "name", "dir", "digest"]);
      if (!boundedString(detail.name, 512) || !boundedString(detail.dir, 4_096)
        || !projectDigest(detail.digest)) throw new ReverseCommandProtocolError("invalid project settings result");
      return;
    case "project.delete":
      assertProjectBase(detail, projectId, ["projectId", "digest"]);
      if (!projectDigest(detail.digest)) throw new ReverseCommandProtocolError("invalid project delete result");
      return;
    case "project.documentation.index":
      strict(detail, [
        "snapshotDigest", "byteOffset", "totalBytes", "chunk", "cursor", "nextCursor",
      ], "project documentation index page");
      if (!projectDigest(detail.snapshotDigest) || !Number.isSafeInteger(detail.byteOffset)
        || Number(detail.byteOffset) < 0 || !Number.isSafeInteger(detail.totalBytes)
        || Number(detail.totalBytes) < 0 || Number(detail.totalBytes) > 2 * 1024 * 1024
        || !boundedString(detail.chunk, 32 * 1024) || !boundedString(detail.cursor, 512)
        || (detail.nextCursor !== null && !boundedString(detail.nextCursor, 512))) {
        throw new ReverseCommandProtocolError("invalid project documentation index page");
      }
      return;
    case "project.documentation.read":
      strict(detail, [
        "path", "name", "title", "content", "size", "mtimeMs",
        "truncated", "offset", "nextOffset",
      ], "project documentation read");
      assertProjectDocPage({
        path: detail.path, name: detail.name, title: detail.title, content: detail.content,
        size: detail.size, mtimeMs: detail.mtimeMs, truncated: detail.truncated,
      });
      if (!Number.isSafeInteger(detail.offset) || Number(detail.offset) < 0
        || (detail.nextOffset !== null && (!Number.isSafeInteger(detail.nextOffset)
          || Number(detail.nextOffset) <= Number(detail.offset)))) {
        throw new ReverseCommandProtocolError("invalid project documentation read");
      }
      return;
    case "project.skills.list":
      strict(detail, ["skills"], "project skills");
      if (!Array.isArray(detail.skills) || detail.skills.length > 512) {
        throw new ReverseCommandProtocolError("invalid project skills");
      }
      for (const item of detail.skills) {
        const skill = object(item, "project skill");
        strict(skill, ["name", "description", "path", "scope"], "project skill");
        if (!boundedString(skill.name, 64) || !boundedString(skill.description, 4_096)
          || !boundedString(skill.path, 4_096) || skill.scope !== "project") {
          throw new ReverseCommandProtocolError("invalid project skill");
        }
      }
      return;
    case "project.quick-links.list":
      strict(detail, ["links", "digest"], "project quick link list");
      assertProjectLinks(detail.links);
      if (!projectDigest(detail.digest)) throw new ReverseCommandProtocolError("invalid project quick link list");
      return;
    case "project.quick-links.create":
    case "project.quick-links.update":
      strict(detail, ["link", "digest"], "project quick link mutation");
      assertProjectLink(detail.link);
      if (!projectDigest(detail.digest)) throw new ReverseCommandProtocolError("invalid project quick link mutation");
      return;
    case "project.quick-links.delete":
      assertProjectBase(detail, projectId, ["projectId", "linkId", "digest"]);
      if (!isCanonicalUuid(detail.linkId) || !projectDigest(detail.digest)) {
        throw new ReverseCommandProtocolError("invalid project quick link deletion");
      }
      return;
    default:
      throw new ReverseCommandProtocolError("unsupported project result operation");
  }
}

function assertSafeUpdateResult(
  operation: ReverseCommandOperation,
  result: ReverseCommandResultFrame,
): void {
  if (result.message !== undefined) throw new ReverseCommandProtocolError("unsafe update result detail");
  const detail = result.result;
  if (operation === "update.check") {
    if (!((result.status === "applied" && result.code === "OK")
      || (result.status === "noop" && result.code === "NO_UPDATE"))) {
      if (result.status === "failed" && result.code === "REGISTRY_UNAVAILABLE" && detail === null) return;
      throw new ReverseCommandProtocolError("invalid update.check result tuple");
    }
    assertSafeUpdateStatus(detail);
    return;
  }
  if (result.status === "noop" && result.code === "NO_UPDATE") {
    assertSafeUpdateStatus(detail);
    return;
  }
  if (result.status === "applied" && result.code === "OK") {
    const value = object(detail, "update attestation");
    strict(value, ["version", "revision", "sha256", "attested"], "update attestation");
    if (typeof value.version !== "string" || value.version.length > 100
      || typeof value.revision !== "string" || !/^[0-9A-Za-z._:+-]{1,128}$/.test(value.revision)
      || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)
      || value.attested !== true) {
      throw new ReverseCommandProtocolError("invalid update attestation");
    }
    return;
  }
  if (result.status === "rejected" && result.code === "UPDATE_BLOCKED" && detail === null) return;
  if (result.status === "failed" && [
    "REGISTRY_UNAVAILABLE", "RELEASE_CHANGED", "DOWNLOAD_FAILED",
    "ARCHIVE_INTEGRITY_FAILED", "UPDATE_FAILED", "INSTALL_FAILED_ROLLED_BACK",
    "INSTALL_FAILED_ROLLBACK_FAILED", "RESTART_FAILED_ROLLED_BACK",
    "RESTART_FAILED_ROLLBACK_FAILED", "RESTART_TIMEOUT_ROLLED_BACK",
    "RESTART_TIMEOUT_ROLLBACK_FAILED", "RESTART_TIMEOUT",
  ].includes(result.code) && detail === null) return;
  if (result.status === "failed" && result.code === "ATTESTATION_MISMATCH") {
    const value = object(detail, "update attestation");
    strict(value, ["version", "revision", "sha256", "attested"], "update attestation");
    if (typeof value.version === "string" && value.version.length <= 100
      && (value.revision === null || (typeof value.revision === "string" && /^[0-9A-Za-z._:+-]{1,128}$/.test(value.revision)))
      && (value.sha256 === null || (typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256)))
      && value.attested === false) return;
  }
  throw new ReverseCommandProtocolError("invalid update.apply result tuple");
}

function assertSafeUpdateStatus(value: unknown): void {
  const detail = object(value, "update status");
  strict(detail, [
    "updateAvailable", "currentVersion", "latestVersion", "currentRevision",
    "latestRevision", "checkedAt", "checkError",
  ], "update status");
  if (typeof detail.updateAvailable !== "boolean"
    || (detail.currentVersion !== null && typeof detail.currentVersion !== "string")
    || (detail.latestVersion !== null && typeof detail.latestVersion !== "string")
    || (detail.currentRevision !== null && (typeof detail.currentRevision !== "string" || !/^[0-9a-f]{40}$/.test(detail.currentRevision)))
    || (detail.latestRevision !== null && (typeof detail.latestRevision !== "string" || !/^[0-9a-f]{40}$/.test(detail.latestRevision)))
    || (detail.checkedAt !== null && !Number.isSafeInteger(detail.checkedAt))
    || (detail.checkError !== null && typeof detail.checkError !== "string")) {
    throw new ReverseCommandProtocolError("invalid update status");
  }
}

function assertSafeDaemonConfigurationResult(result: ReverseCommandResultFrame): void {
  if (result.message !== undefined) {
    throw new ReverseCommandProtocolError("unsafe daemon configuration result");
  }
  if (result.status === "failed" && result.result === null
    && ["PERSIST_FAILED", "INTERNAL"].includes(result.code)) return;
  if (result.status === "conflict" && result.code === "COMMAND_ID_REUSED" && result.result === null) return;
  const detail = object(result.result, "daemon configuration result");
  if (result.status === "rejected") {
    strict(detail, ["errors"], "daemon configuration rejection");
    if (!["BAD_REQUEST", "FORBIDDEN_FIELD", "INVALID_VALUE", "PAYLOAD_TOO_LARGE"].includes(result.code)
      || !Array.isArray(detail.errors) || detail.errors.length < 1 || detail.errors.length > 20) {
      throw new ReverseCommandProtocolError("invalid daemon configuration rejection");
    }
    for (const item of detail.errors) assertSafeDaemonConfigurationError(item);
    return;
  }
  strict(detail, [
    "epoch", "previousRevision", "revision", "schemaVersion", "digest", "updatedAt",
    "changedFields", "restart", "errors", "values",
  ], "daemon configuration result");
  const validTuple = ((result.status === "applied" || result.status === "noop") && result.code === "OK")
    || (result.status === "conflict" && ["REVISION_CONFLICT", "COMMAND_ID_REUSED"].includes(result.code));
  if (!validTuple
    || typeof detail.epoch !== "string" || !Number.isSafeInteger(detail.previousRevision)
    || !Number.isSafeInteger(detail.revision) || detail.schemaVersion !== 1
    || typeof detail.digest !== "string" || !/^[0-9a-f]{64}$/.test(detail.digest)) {
    throw new ReverseCommandProtocolError("invalid daemon configuration result identity");
  }
  assertDaemonConfigurationValues(detail.values);
  if (createHash("sha256").update(canonicalJson(detail.values as JsonObject)).digest("hex") !== detail.digest) {
    throw new ReverseCommandProtocolError("daemon configuration result digest mismatch");
  }
  const restart = object(detail.restart, "daemon configuration restart");
  strict(restart, ["required", "components"], "daemon configuration restart");
  const fields = new Set([
    "name", "defaultAgent", "fileTransferRoot", "heartbeatIntervalMs",
    "aiDefaultModel", "aiDefaultReasoningEffort", "soul",
  ]);
  const components = new Set(["daemon", "dashboard", "socket", "provider"]);
  if (typeof restart.required !== "boolean" || !Array.isArray(restart.components)
    || restart.components.some((value) => typeof value !== "string" || !components.has(value))
    || !Array.isArray(detail.changedFields)
    || detail.changedFields.some((value) => typeof value !== "string" || !fields.has(value))
    || new Set(detail.changedFields).size !== detail.changedFields.length
    || !Array.isArray(detail.errors)
    || detail.errors.length !== 0
    || (result.status === "applied"
      ? detail.revision !== Number(detail.previousRevision) + 1 || detail.changedFields.length === 0
      : detail.revision !== detail.previousRevision || detail.changedFields.length !== 0)) {
    throw new ReverseCommandProtocolError("invalid daemon configuration result");
  }
  for (const item of detail.errors) assertSafeDaemonConfigurationError(item);
}

function assertSafeDaemonConfigurationError(value: unknown): void {
  const error = object(value, "daemon configuration error");
  strict(error, ["field", "code", "message"], "daemon configuration error");
  if ((error.field !== undefined && (typeof error.field !== "string"
      || ![
        "name", "defaultAgent", "fileTransferRoot", "heartbeatIntervalMs",
        "aiDefaultModel", "aiDefaultReasoningEffort", "soul",
      ].includes(error.field)))
    || typeof error.code !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    || typeof error.message !== "string" || Buffer.byteLength(error.message, "utf8") > 500
    || /(?:overseerToken|authorization|password|secret|bearer\s+)/i.test(error.message)) {
    throw new ReverseCommandProtocolError("unsafe daemon configuration error");
  }
}

export function assertDaemonConfigurationValues(value: unknown): asserts value is JsonObject {
  const values = object(value, "daemon configuration values");
  strict(values, [
    "name", "defaultAgent", "fileTransferRoot", "heartbeatIntervalMs",
    "aiDefaultModel", "aiDefaultReasoningEffort", "soul",
  ], "daemon configuration values");
  if ((values.name !== null && typeof values.name !== "string")
    || typeof values.defaultAgent !== "string"
    || (values.fileTransferRoot !== null && typeof values.fileTransferRoot !== "string")
    || !Number.isSafeInteger(values.heartbeatIntervalMs) || Number(values.heartbeatIntervalMs) < 1_000
    || (values.aiDefaultModel !== null && typeof values.aiDefaultModel !== "string")
    || (values.aiDefaultReasoningEffort !== null && typeof values.aiDefaultReasoningEffort !== "string")
    || (values.soul !== null && typeof values.soul !== "string")) {
    throw new ReverseCommandProtocolError("invalid daemon configuration values");
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
