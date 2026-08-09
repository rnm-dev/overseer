import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedDiagnostics } from "./diagnostics.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATALOG_DEPENDENCIES = ["session-catalog-v1", "durable-delivery-v1"];
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
  if (value?.type === "transcript_deleted") {
    if (!integer(value.revision, 0)) errors.push("invalid transcript deletion revision");
    return;
  }
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
  if (!["transcript_live_event", "transcript_deleted"].includes(frame.payload?.type)) errors.push("invalid transcript durable payload");
}

function validateTranscriptControl(frame, errors, type) {
  if (frame.type !== type || !uuid(frame.requestId) || typeof frame.sessionId !== "string") errors.push(`invalid ${type}`);
}

const validators = {
  "socket.control.hello": validateControlHello,
  "socket.control.hello_ack": validateControlHelloAck,
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
