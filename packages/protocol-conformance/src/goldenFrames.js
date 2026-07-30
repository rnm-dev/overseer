import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedDiagnostics } from "./diagnostics.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATALOG_DEPENDENCIES = ["session-catalog-v1", "durable-delivery-v1"];
const FOLDER_ERRORS = new Set([
  "BAD_REQUEST", "BAD_CURSOR", "SYNC_IN_PROGRESS", "UNKNOWN_PROJECT", "NOT_FOUND",
  "NOT_DIRECTORY", "FORBIDDEN", "INVALID_PATH", "PATH_ESCAPE", "LISTING_TOO_LARGE", "INTERNAL",
]);
const FILE_ERRORS = new Set([
  "BAD_REQUEST", "UNKNOWN_PROJECT", "FILES_DISABLED", "PATH_ESCAPE", "NOT_FOUND",
  "IS_DIRECTORY", "RANGE_NOT_SATISFIABLE", "TRANSFER_CANCELLED", "INTERNAL",
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function integer(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function uuid(value) {
  return typeof value === "string" && UUID.test(value);
}

function actor(value) {
  return isObject(value) && uuid(value.userId)
    && typeof value.email === "string" && value.email.length > 0 && value.email.length <= 320;
}

function catalogCapabilities(frame, errors) {
  const capabilities = frame.capabilities ?? [];
  if (!strings(capabilities)) {
    errors.push("capabilities must be a string array");
    return;
  }
  if (new Set(capabilities).size !== capabilities.length) errors.push("capabilities must be unique");
  const canonical = CATALOG_DEPENDENCIES.map((capability) => capabilities.includes(capability));
  if (canonical[0] !== canonical[1]) errors.push("session catalog and durable delivery negotiate as a pair");
  if (capabilities.includes("project-catalog-v1") && !canonical.every(Boolean)) {
    errors.push("project catalog requires the canonical pair");
  }
}

function validateControlHello(frame, errors) {
  if (frame.type !== "hello" || frame.protocol !== 1) errors.push("expected control hello protocol 1");
  if (frame.peonId !== undefined && !uuid(frame.peonId)) errors.push("peonId must be a UUID");
  catalogCapabilities(frame, errors);
  if (frame.channels !== undefined && !isObject(frame.channels)) errors.push("channels must be an object");
}

function validateControlHelloAck(frame, errors) {
  if (frame.type !== "hello_ack" || frame.protocol !== 1) errors.push("expected control hello_ack protocol 1");
  catalogCapabilities(frame, errors);
}

function validateTransferHello(frame, errors, acknowledgement) {
  if (frame.type !== (acknowledgement ? "hello_ack" : "hello")
    || frame.protocol !== 1 || frame.channel !== "file-transfer") {
    errors.push(`expected file-transfer ${acknowledgement ? "hello_ack" : "hello"} protocol 1`);
  }
  if (!acknowledgement && frame.peonId !== undefined && !uuid(frame.peonId)) errors.push("peonId must be a UUID");
  if (!strings(frame.capabilities)) errors.push("capabilities must be a string array");
}

function validateDurableMessage(frame, errors) {
  if (frame.type !== "durable_message") errors.push("expected durable_message");
  for (const field of ["epoch", "cursor", "messageId", "priority", "capability"]) {
    if (typeof frame[field] !== "string" || frame[field].length === 0) errors.push(`${field} is required`);
  }
  if (!uuid(frame.messageId)) errors.push("messageId must be a UUID");
  if (!["critical", "control", "normal", "bulk"].includes(frame.priority)) errors.push("priority is invalid");
  if (!isObject(frame.payload)) errors.push("payload must be an object");
}

function validateSnapshotRequest(frame, errors, prefix) {
  if (frame.type !== `${prefix}_catalog_snapshot_request`) errors.push(`expected ${prefix} snapshot request`);
  if (!uuid(frame.requestId)) errors.push("requestId must be a UUID");
  if (frame.limit !== undefined && (!integer(frame.limit, 1) || frame.limit > 200)) errors.push("limit exceeds 200");
  if (frame.cursor !== undefined && (typeof frame.cursor !== "string" || frame.cursor.length === 0)) errors.push("cursor is invalid");
}

function validateSnapshotPage(frame, errors, prefix, collection) {
  if (frame.type !== `${prefix}_catalog_snapshot_page`) errors.push(`expected ${prefix} snapshot page`);
  if (!uuid(frame.requestId)) errors.push("requestId must be a UUID");
  for (const field of ["revision", "barrierSeq"]) if (!integer(frame[field])) errors.push(`${field} must be non-negative`);
  if (typeof frame.epoch !== "string" || !frame.epoch) errors.push("epoch is required");
  if (!Array.isArray(frame[collection]) || frame[collection].length > 250) errors.push(`${collection} exceeds page bounds`);
  if (typeof frame.hasMore !== "boolean") errors.push("hasMore is required");
  if (frame.hasMore ? typeof frame.nextCursor !== "string" || !frame.nextCursor : frame.nextCursor !== null) {
    errors.push("cursor does not match hasMore");
  }
}

function validateCatalogEvent(frame, errors, prefix, resource, deletedField) {
  if (frame.type !== `${prefix}_catalog_event`) errors.push(`expected ${prefix} catalog event`);
  if (typeof frame.epoch !== "string" || !frame.epoch) errors.push("epoch is required");
  if (!integer(frame.seq, 1) || !integer(frame.revision, 1)) errors.push("seq and revision must be positive");
  const hasUpsert = isObject(frame[resource]);
  const hasDelete = typeof frame[deletedField] === "string" && frame[deletedField].length > 0;
  if (hasUpsert === hasDelete) errors.push("event must contain exactly one upsert or deletion");
}

function validateCatalogAck(frame, errors, prefix) {
  if (frame.type !== `${prefix}_catalog_ack`) errors.push(`expected ${prefix} catalog ack`);
  if (typeof frame.epoch !== "string" || !frame.epoch || !integer(frame.acknowledgedSeq)) errors.push("invalid catalog acknowledgement");
}

function transcriptEvent(value, errors, sessionId, epoch) {
  if (!isObject(value) || value.sessionId !== sessionId || value.epoch !== epoch) errors.push("invalid transcript event scope");
  if (!integer(value?.seq, 1) || value.revision !== value.seq) errors.push("transcript seq/revision mismatch");
  if (typeof value?.eventId !== "string" || !isObject(value?.event)) errors.push("invalid transcript event");
}

function validateTranscriptRequest(frame, errors) {
  if (frame.type !== "transcript_snapshot_request" || !uuid(frame.requestId)) errors.push("invalid transcript snapshot request");
  if (typeof frame.sessionId !== "string" || !frame.sessionId) errors.push("sessionId is required");
  if (!integer(frame.limit, 1) || frame.limit > 100 || frame.subscribe !== true) errors.push("invalid transcript snapshot bounds");
  if (frame.cursor !== undefined && (typeof frame.cursor !== "string" || !frame.cursor)) errors.push("invalid transcript cursor");
}

function validateTranscriptPage(frame, errors) {
  if (frame.type !== "transcript_snapshot_page" || !uuid(frame.requestId)) errors.push("invalid transcript snapshot page");
  if (typeof frame.sessionId !== "string" || typeof frame.epoch !== "string" || !frame.epoch) errors.push("invalid transcript scope");
  if (!integer(frame.barrierSeq) || frame.revision !== frame.barrierSeq) errors.push("invalid transcript barrier");
  if (!Array.isArray(frame.events) || frame.events.length > 250) errors.push("transcript page events exceed bounds");
  else for (const event of frame.events) transcriptEvent(event, errors, frame.sessionId, frame.epoch);
  if (typeof frame.hasMore !== "boolean"
    || (frame.hasMore ? typeof frame.nextCursor !== "string" || !frame.nextCursor : frame.nextCursor !== null)) {
    errors.push("transcript cursor does not match hasMore");
  }
}

function validateTranscriptDurable(frame, errors) {
  validateDurableMessage(frame, errors);
  if (frame.capability !== "transcript-sync-v1" || !isObject(frame.payload)) errors.push("invalid transcript durable capability");
  else transcriptEvent(frame.payload, errors, frame.payload.sessionId, frame.payload.epoch);
  if (frame.payload?.type !== "transcript_live_event") errors.push("invalid transcript durable payload");
}

function validateTranscriptControl(frame, errors, type) {
  if (frame.type !== type || !uuid(frame.requestId) || typeof frame.sessionId !== "string") errors.push(`invalid ${type}`);
}

function validateFolderRequest(frame, errors) {
  if (frame.type !== "folder_list_request" || !uuid(frame.requestId)) errors.push("invalid folder request identity");
  const firstPage = frame.cursor === undefined;
  if (firstPage) {
    const absolute = typeof frame.path === "string" && frame.path.startsWith("/");
    const project = uuid(frame.projectId);
    if (!absolute && !project) errors.push("folder request requires an absolute path or projectId");
    if (absolute && frame.relativePath !== undefined) errors.push("absolute path cannot include relativePath");
    if (frame.relativePath !== undefined && (typeof frame.relativePath !== "string" || frame.relativePath.startsWith("/"))) {
      errors.push("relativePath must be relative");
    }
  } else if (typeof frame.cursor !== "string" || !frame.cursor) {
    errors.push("cursor is invalid");
  }
  if (frame.limit !== undefined && (!integer(frame.limit, 1) || frame.limit > 500)) errors.push("limit exceeds 500");
}

function validateFolderPage(frame, errors) {
  if (frame.type !== "folder_list_page" || !uuid(frame.requestId)) errors.push("invalid folder page identity");
  if (typeof frame.path !== "string" || !frame.path.startsWith("/")) errors.push("folder path must be absolute");
  if (frame.projectId !== null && !uuid(frame.projectId)) errors.push("projectId must be null or UUID");
  if (!Array.isArray(frame.entries) || frame.entries.length > 20_000) {
    errors.push("entries exceed bounds");
    return;
  }
  for (const entry of frame.entries) {
    if (!isObject(entry) || typeof entry.name !== "string" || !["directory", "file", "other"].includes(entry.type)) {
      errors.push("invalid folder entry");
      continue;
    }
    const hasMetadata = Object.hasOwn(entry, "size") || Object.hasOwn(entry, "mtimeMs");
    if (!hasMetadata && entry.type === "other") errors.push("legacy entries cannot use other");
    if (hasMetadata) {
      if (entry.type === "file" && !integer(entry.size)) errors.push("file size must be non-negative");
      if (entry.type !== "file" && entry.size !== null) errors.push("non-file size must be null");
      if (entry.type === "other" ? entry.mtimeMs !== null : typeof entry.mtimeMs !== "number") {
        errors.push("invalid entry mtimeMs");
      }
    }
  }
  if (typeof frame.hasMore !== "boolean"
    || (frame.hasMore ? typeof frame.nextCursor !== "string" || !frame.nextCursor : frame.nextCursor !== null)) {
    errors.push("folder cursor does not match hasMore");
  }
}

function validateFolderTerminal(frame, errors, kind) {
  if (frame.type !== `folder_list_${kind}`) errors.push(`expected folder_list_${kind}`);
  if (frame.requestId !== null && !uuid(frame.requestId)) errors.push("requestId must be null or UUID");
  if (kind === "error" && (!FOLDER_ERRORS.has(frame.code) || typeof frame.error !== "string" || !frame.error)) {
    errors.push("invalid stable folder error");
  }
}

function validateFileOpen(frame, errors, sandbox) {
  if (frame.type !== "file_open" || frame.protocol !== 1 || !uuid(frame.requestId)) errors.push("invalid file_open identity");
  if (!actor(frame.actor)) errors.push("actor must be server-derived");
  if (sandbox) {
    if (frame.scope !== "sandbox" || typeof frame.path !== "string" || !frame.path) errors.push("sandbox selector is invalid");
    if (frame.projectId !== undefined || frame.relativePath !== undefined) errors.push("sandbox selector cannot include a project");
  } else {
    if (!uuid(frame.projectId) || typeof frame.relativePath !== "string" || !frame.relativePath
      || frame.relativePath.startsWith("/") || frame.relativePath.split("/").includes("..")) {
      errors.push("project selector is invalid");
    }
    if (frame.scope !== undefined || frame.path !== undefined) errors.push("project selector cannot include sandbox fields");
  }
  if (frame.range !== undefined && (!isObject(frame.range) || !integer(frame.range.start)
    || (frame.range.end !== undefined && (!integer(frame.range.end) || frame.range.end < frame.range.start)))) {
    errors.push("range is invalid");
  }
}

function validateFileMeta(frame, errors) {
  if (frame.type !== "file_meta" || !uuid(frame.requestId)) errors.push("invalid file_meta identity");
  if (![200, 206].includes(frame.status) || !integer(frame.contentLength)
    || frame.acceptRanges !== "bytes" || typeof frame.contentType !== "string") errors.push("invalid file metadata");
  if (frame.status === 206 && typeof frame.contentRange !== "string") errors.push("206 requires contentRange");
}

function validateFileSimple(frame, errors, kind) {
  if (frame.type !== `file_${kind}` || !uuid(frame.requestId)) errors.push(`invalid file_${kind} identity`);
  if (kind === "credit" && (!integer(frame.bytes, 1) || frame.bytes > 1024 * 1024)) errors.push("credit exceeds 1 MiB");
  if (kind === "error" && (!integer(frame.status, 400) || !FILE_ERRORS.has(frame.code) || typeof frame.message !== "string")) {
    errors.push("invalid stable file error");
  }
}

const validators = {
  "socket.control.hello": validateControlHello,
  "socket.control.hello_ack": validateControlHelloAck,
  "socket.transfer.hello": (frame, errors) => validateTransferHello(frame, errors, false),
  "socket.transfer.hello_ack": (frame, errors) => validateTransferHello(frame, errors, true),
  "delivery.message": validateDurableMessage,
  "catalog.session.snapshot_request": (frame, errors) => validateSnapshotRequest(frame, errors, "session"),
  "catalog.session.snapshot_page": (frame, errors) => validateSnapshotPage(frame, errors, "session", "sessions"),
  "catalog.session.event": (frame, errors) => validateCatalogEvent(frame, errors, "session", "session", "deletedSessionId"),
  "catalog.session.ack": (frame, errors) => validateCatalogAck(frame, errors, "session"),
  "catalog.project.snapshot_request": (frame, errors) => validateSnapshotRequest(frame, errors, "project"),
  "catalog.project.snapshot_page": (frame, errors) => validateSnapshotPage(frame, errors, "project", "projects"),
  "catalog.project.event": (frame, errors) => validateCatalogEvent(frame, errors, "project", "project", "deletedProjectId"),
  "catalog.project.ack": (frame, errors) => validateCatalogAck(frame, errors, "project"),
  "transcript.snapshot_request": validateTranscriptRequest,
  "transcript.snapshot_page": validateTranscriptPage,
  "transcript.live": validateTranscriptDurable,
  "transcript.cancel": (frame, errors) => validateTranscriptControl(frame, errors, "transcript_snapshot_cancel"),
  "transcript.unsubscribe": (frame, errors) => validateTranscriptControl(frame, errors, "transcript_unsubscribe"),
  "folder.request": validateFolderRequest,
  "folder.page": validateFolderPage,
  "folder.cancel": (frame, errors) => validateFolderTerminal(frame, errors, "cancel"),
  "folder.cancelled": (frame, errors) => validateFolderTerminal(frame, errors, "cancelled"),
  "folder.error": (frame, errors) => validateFolderTerminal(frame, errors, "error"),
  "file.project.open": (frame, errors) => validateFileOpen(frame, errors, false),
  "file.sandbox.open": (frame, errors) => validateFileOpen(frame, errors, true),
  "file.meta": validateFileMeta,
  "file.credit": (frame, errors) => validateFileSimple(frame, errors, "credit"),
  "file.end": (frame, errors) => validateFileSimple(frame, errors, "end"),
  "file.error": (frame, errors) => validateFileSimple(frame, errors, "error"),
};

export function loadFixture(name) {
  const candidate = path.resolve(PACKAGE_ROOT, "fixtures", name);
  const fixtureRoot = path.resolve(PACKAGE_ROOT, "fixtures");
  if (!candidate.startsWith(`${fixtureRoot}${path.sep}`)) throw new Error("fixture path escapes package");
  return JSON.parse(readFileSync(candidate, "utf8"));
}

export function validateGoldenFrame(entry, limits = {}, adapters = {}) {
  const errors = [];
  const validate = adapters[entry.schema] ?? validators[entry.schema];
  if (!validate) return { valid: false, errors: [`no adapter for ${entry.schema}`], bytes: 0 };
  if (!isObject(entry.frame)) return { valid: false, errors: ["frame must be an object"], bytes: 0 };
  validate(entry.frame, errors);
  const bytes = Buffer.byteLength(JSON.stringify(entry.frame), "utf8");
  const byteLimit = limits[entry.limit];
  if (!integer(byteLimit, 1)) errors.push(`unknown byte limit ${entry.limit}`);
  else if (bytes > byteLimit) errors.push(`frame is ${bytes} bytes, limit is ${byteLimit}`);
  return { valid: errors.length === 0, errors, bytes };
}

export function executeGoldenFrames(document, options = {}) {
  const diagnostics = options.diagnostics ?? new BoundedDiagnostics();
  const cases = [];
  for (const entry of document.frames ?? []) {
    const result = validateGoldenFrame(entry, document.limits, options.adapters);
    const expected = entry.valid !== false;
    const passed = result.valid === expected;
    cases.push({ name: entry.name, surface: entry.surface, passed, ...result });
    diagnostics.add(passed ? "golden_frame_passed" : "golden_frame_failed", {
      name: entry.name,
      surface: entry.surface,
      errors: result.errors,
      bytes: result.bytes,
    });
  }
  return {
    formatVersion: 1,
    passed: cases.filter((entry) => entry.passed).length,
    failed: cases.filter((entry) => !entry.passed).length,
    cases,
    diagnostics: diagnostics.artifact(),
  };
}
