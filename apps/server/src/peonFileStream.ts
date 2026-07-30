import { randomUUID } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import { WebSocket } from "ws";
import { auditSafeFileErrorMessage } from "./fileErrorSafety.js";
import {
  getPeonTransferConnection,
  FILE_WRITE_CAPABILITY,
  PROJECT_FILE_READ_CAPABILITY,
  SANDBOX_FILE_READ_CAPABILITY,
} from "./peonTransferConnections.js";

const META_TIMEOUT_MS = 15_000;
const STREAM_HIGH_WATER_MARK = 256 * 1024;
const MAX_REQUESTS_PER_PEON = 32;
const MAX_REQUESTS_GLOBAL = 256;
const MAX_WRITES_PER_USER = 8;
const MAX_WRITES_PER_WORKSPACE = 64;
const MAX_RESERVED_WRITE_BYTES_PER_USER = 256 * 1024 * 1024;
const MAX_RESERVED_WRITE_BYTES_PER_WORKSPACE = 1024 * 1024 * 1024;
const MAX_RESERVED_WRITE_BYTES_GLOBAL = 4 * 1024 * 1024 * 1024;
const BINARY_HEADER_BYTES = 22;
export const MAX_FILE_CHUNK_BYTES = 64 * 1024 - BINARY_HEADER_BYTES;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ProjectFileRange { start: number; end?: number }
export interface ProjectFileActor { userId: string; email: string }
export interface ProjectFileStreamRequest {
  peonId: string;
  projectId: string;
  relativePath: string;
  actor: ProjectFileActor;
  range?: ProjectFileRange;
  signal?: AbortSignal;
}

export interface SandboxFileStreamRequest {
  peonId: string;
  path: string;
  actor: ProjectFileActor;
  range?: ProjectFileRange;
  signal?: AbortSignal;
}

export interface ProjectFileStream {
  stream: Readable;
  status: 200 | 206;
  contentType: string;
  contentLength: number;
  contentRange?: string;
  acceptRanges?: string;
  etag?: string;
  lastModified?: string;
}

export class PeonFileStreamError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 502) {
    super(message);
    this.name = "PeonFileStreamError";
  }
}

interface Pending {
  requestId: string;
  peonId: string;
  socket: WebSocket;
  stream: PassThrough | null;
  resolve: (value: ProjectFileStream) => void;
  reject: (error: PeonFileStreamError) => void;
  timer: NodeJS.Timeout;
  abort?: () => void;
  expectedSequence: number;
  expectedBytes: number | null;
  receivedBytes: number;
  credit: number;
  withheldCredit: number;
}

interface PendingWrite {
  requestId: string;
  commandId: string;
  peonId: string;
  workspaceId: string;
  userId: string;
  socket: WebSocket;
  source: Readable | null;
  resolve: (value: PeonFileWriteResult) => void;
  reject: (error: PeonFileStreamError) => void;
  timer: NodeJS.Timeout;
  abort?: () => void;
  state: PeonFileWriteLifecycle;
  credit: number;
  wakeCredit: (() => void) | null;
  sequence: number;
  sentBytes: number;
  expectedBytes: number | undefined;
  maxBytes: number;
  reservedBytes: number;
  pumping: boolean;
}

const pending = new Map<string, Pending>();
const pendingWrites = new Map<string, PendingWrite>();
const recentlyClosed = new Map<string, number>();
const keyOf = (peonId: string, requestId: string) => `${peonId}\0${requestId}`;

function rememberClosed(key: string): void {
  const now = Date.now();
  recentlyClosed.set(key, now + 30_000);
  for (const [candidate, expiresAt] of recentlyClosed) {
    if (expiresAt <= now || recentlyClosed.size > 512) recentlyClosed.delete(candidate);
  }
}

function wasRecentlyClosed(key: string): boolean {
  const expiresAt = recentlyClosed.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    recentlyClosed.delete(key);
    return false;
  }
  return true;
}

function validateRelativePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[a-z]:\//i.test(value)
    || value.split("/").some((part) => part === ".." || part === "")) {
    throw new PeonFileStreamError("INVALID_PROJECT_PATH", "a non-empty project-relative path is required", 400);
  }
  return value;
}

function validateRequest(input: ProjectFileStreamRequest): void {
  if (!input.projectId || input.projectId.length > 512 || input.projectId.includes("\0")) throw new PeonFileStreamError("INVALID_PROJECT_ID", "a valid project ID is required", 400);
  validateRelativePath(input.relativePath);
  if (input.range && (!Number.isSafeInteger(input.range.start) || input.range.start < 0
    || (input.range.end !== undefined && (!Number.isSafeInteger(input.range.end) || input.range.end < input.range.start)))) {
    throw new PeonFileStreamError("INVALID_RANGE", "invalid byte range", 416);
  }
}

function countForPeon(peonId: string): number {
  let count = 0;
  for (const item of pending.values()) if (item.peonId === peonId) count += 1;
  for (const item of pendingWrites.values()) if (item.peonId === peonId) count += 1;
  return count;
}

function send(socket: WebSocket, frame: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) throw new PeonFileStreamError("PEON_TRANSFER_UNAVAILABLE", "Peon transfer connection is unavailable", 503);
  socket.send(JSON.stringify(frame));
}

function cleanup(item: Pending): void {
  clearTimeout(item.timer);
  if (item.abort) item.abort();
  const key = keyOf(item.peonId, item.requestId);
  pending.delete(key);
  rememberClosed(key);
}

function fail(item: Pending, error: PeonFileStreamError, notifyPeon = false): void {
  if (!pending.has(keyOf(item.peonId, item.requestId))) return;
  if (notifyPeon && item.socket.readyState === WebSocket.OPEN) {
    item.socket.send(JSON.stringify({ type: "file_cancel", requestId: item.requestId, reason: error.code }));
  }
  cleanup(item);
  if (item.stream) item.stream.destroy(error);
  else item.reject(error);
}

function grant(item: Pending, bytes: number): void {
  if (bytes <= 0 || item.socket.readyState !== WebSocket.OPEN) return;
  item.credit += bytes;
  item.socket.send(JSON.stringify({ type: "file_credit", requestId: item.requestId, bytes }));
}

async function openPeonFile(
  input: ProjectFileStreamRequest | SandboxFileStreamRequest,
  capability: string,
  frame: Record<string, unknown>,
): Promise<ProjectFileStream> {
  if (pending.size >= MAX_REQUESTS_GLOBAL || countForPeon(input.peonId) >= MAX_REQUESTS_PER_PEON) {
    throw new PeonFileStreamError("PEON_TRANSFER_BUSY", "too many active Peon file transfers", 429);
  }
  const socket = getPeonTransferConnection(input.peonId, capability);
  if (!socket) throw new PeonFileStreamError("PEON_TRANSFER_UNAVAILABLE", "Peon transfer connection is unavailable", 503);
  if (input.signal?.aborted) throw new PeonFileStreamError("TRANSFER_CANCELLED", "file transfer was cancelled", 499);

  const requestId = randomUUID();
  return new Promise<ProjectFileStream>((resolve, reject) => {
    const item: Pending = {
      requestId, peonId: input.peonId, socket, stream: null, resolve, reject,
      timer: setTimeout(() => {}, META_TIMEOUT_MS), expectedSequence: 0,
      expectedBytes: null, receivedBytes: 0, credit: 0, withheldCredit: 0,
    };
    clearTimeout(item.timer);
    item.timer = setTimeout(() => fail(item, new PeonFileStreamError("PEON_TRANSFER_TIMEOUT", "Peon did not open the file in time", 504), true), META_TIMEOUT_MS);
    item.timer.unref();
    if (input.signal) {
      const onAbort = () => fail(item, new PeonFileStreamError("TRANSFER_CANCELLED", "file transfer was cancelled", 499), true);
      input.signal.addEventListener("abort", onAbort, { once: true });
      item.abort = () => input.signal?.removeEventListener("abort", onAbort);
    }
    pending.set(keyOf(input.peonId, requestId), item);
    try {
      send(socket, {
        type: "file_open", protocol: 1, requestId, ...frame, actor: input.actor,
        ...(input.range ? { range: input.range } : {}),
      });
    } catch (error) {
      fail(item, error instanceof PeonFileStreamError ? error : new PeonFileStreamError("PEON_TRANSFER_UNAVAILABLE", "Peon transfer connection is unavailable", 503));
    }
  });
}

export async function openPeonProjectFile(input: ProjectFileStreamRequest): Promise<ProjectFileStream> {
  validateRequest(input);
  return openPeonFile(input, PROJECT_FILE_READ_CAPABILITY, {
    projectId: input.projectId,
    relativePath: input.relativePath,
  });
}

export async function openPeonSandboxFile(input: SandboxFileStreamRequest): Promise<ProjectFileStream> {
  if (!input.path || input.path.length > 4096 || input.path.includes("\0")) {
    throw new PeonFileStreamError("INVALID_PATH", "a non-empty sandbox file path is required", 400);
  }
  return openPeonFile(input, SANDBOX_FILE_READ_CAPABILITY, { scope: "sandbox", path: input.path });
}

function stringField(frame: Record<string, unknown>, name: string, max = 1024): string | undefined {
  const value = frame[name];
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function headerField(frame: Record<string, unknown>, name: string, max = 1024): string | undefined {
  const value = stringField(frame, name, max);
  return value !== undefined && !/[\r\n]/.test(value) ? value : undefined;
}

export function handlePeonFileJson(peonId: string, socket: WebSocket, frame: Record<string, unknown>): boolean {
  if (typeof frame.requestId !== "string" || !UUID.test(frame.requestId)) return false;
  const key = keyOf(peonId, frame.requestId);
  const write = pendingWrites.get(key);
  if (write) return handlePeonFileWriteJson(write, socket, frame);
  const item = pending.get(key);
  if (!item) return wasRecentlyClosed(key);
  if (item.socket !== socket) return false;
  if (frame.type === "file_error") {
    const status = Number.isInteger(frame.status) && Number(frame.status) >= 400 && Number(frame.status) <= 599 ? Number(frame.status) : 502;
    const code = stringField(frame, "code", 128) ?? "PEON_FILE_ERROR";
    const message = stringField(frame, "message", 2048) ?? "Peon could not open the file";
    fail(item, new PeonFileStreamError(code, auditSafeFileErrorMessage(code, message), status));
    return true;
  }
  if (frame.type === "file_meta" && !item.stream) {
    const status = frame.status;
    const contentLength = frame.contentLength;
    const contentType = headerField(frame, "contentType", 256);
    if ((status !== 200 && status !== 206) || !Number.isSafeInteger(contentLength) || Number(contentLength) < 0 || !contentType) return false;
    if (status === 206 && !headerField(frame, "contentRange", 256)) return false;
    clearTimeout(item.timer);
    const stream = new PassThrough({ highWaterMark: STREAM_HIGH_WATER_MARK });
    item.stream = stream;
    item.expectedBytes = Number(contentLength);
    stream.on("drain", () => {
      const bytes = item.withheldCredit;
      item.withheldCredit = 0;
      grant(item, bytes);
    });
    stream.on("error", () => {
      if (pending.has(keyOf(item.peonId, item.requestId))) fail(item, new PeonFileStreamError("BROWSER_STREAM_ERROR", "browser file stream closed", 499), true);
    });
    item.resolve({
      stream, status, contentType, contentLength: Number(contentLength),
      contentRange: headerField(frame, "contentRange", 256), acceptRanges: headerField(frame, "acceptRanges", 64),
      etag: headerField(frame, "etag", 512), lastModified: headerField(frame, "lastModified", 128),
    });
    grant(item, STREAM_HIGH_WATER_MARK);
    return true;
  }
  if (frame.type === "file_end" && item.stream && item.expectedBytes !== null) {
    if (item.receivedBytes !== item.expectedBytes) {
      fail(item, new PeonFileStreamError("FILE_LENGTH_MISMATCH", "Peon file stream ended at an unexpected length", 502));
    } else {
      const stream = item.stream;
      cleanup(item);
      stream.end();
    }
    return true;
  }
  return false;
}

function uuidBytes(id: string): Buffer {
  if (!UUID.test(id)) throw new Error("invalid request id");
  return Buffer.from(id.replaceAll("-", ""), "hex");
}

function bytesUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodePeonFileChunk(requestId: string, sequence: number, data: Uint8Array): Buffer {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff || data.byteLength > MAX_FILE_CHUNK_BYTES) throw new Error("invalid file chunk");
  const frame = Buffer.allocUnsafe(BINARY_HEADER_BYTES + data.byteLength);
  frame[0] = 1;
  frame[1] = 1;
  uuidBytes(requestId).copy(frame, 2);
  frame.writeUInt32BE(sequence, 18);
  Buffer.from(data).copy(frame, BINARY_HEADER_BYTES);
  return frame;
}

export function handlePeonFileBinary(peonId: string, socket: WebSocket, raw: Buffer): boolean {
  if (raw.length < BINARY_HEADER_BYTES || raw[0] !== 1 || raw[1] !== 1 || raw.length - BINARY_HEADER_BYTES > MAX_FILE_CHUNK_BYTES) return false;
  const requestId = bytesUuid(raw.subarray(2, 18));
  const key = keyOf(peonId, requestId);
  const item = pending.get(key);
  if (!item) return wasRecentlyClosed(key);
  if (item.socket !== socket || !item.stream || item.expectedBytes === null) return false;
  const sequence = raw.readUInt32BE(18);
  const chunk = raw.subarray(BINARY_HEADER_BYTES);
  if (chunk.length === 0 || sequence !== item.expectedSequence || chunk.length > item.credit || item.receivedBytes + chunk.length > item.expectedBytes) return false;
  item.expectedSequence += 1;
  item.credit -= chunk.length;
  item.receivedBytes += chunk.length;
  if (item.stream.write(chunk)) grant(item, chunk.length);
  else item.withheldCredit += chunk.length;
  return true;
}

export function failPeonFileTransfers(peonId: string, socket: WebSocket, code = "PEON_TRANSFER_DISCONNECTED"): void {
  for (const item of [...pending.values()]) {
    if (item.peonId === peonId && item.socket === socket) fail(item, new PeonFileStreamError(code, "Peon transfer connection closed", 502));
  }
  for (const item of [...pendingWrites.values()]) {
    if (item.peonId === peonId && item.socket === socket) {
      failWrite(item, new PeonFileStreamError(code, "Peon transfer connection closed", 502));
    }
  }
}

export interface PeonFileWriteResult {
  status: number;
  path: string;
  size: number;
  sha256?: string;
}

export interface PeonFileWriteBase {
  peonId: string;
  workspaceId: string;
  actor: ProjectFileActor;
  signal?: AbortSignal;
  requestId?: string;
  commandId?: string;
}

export type PeonFileWriteLifecycle =
  | "pending"
  | "accepted"
  | "streaming"
  | "verifying"
  | "committed"
  | "rejected"
  | "cancelled"
  | "expired";

export function getPeonFileWriteCoordinatorSnapshot(): {
  active: number;
  reservedBytes: number;
  lifecycle: Partial<Record<PeonFileWriteLifecycle, number>>;
} {
  const lifecycle: Partial<Record<PeonFileWriteLifecycle, number>> = {};
  let reservedBytes = 0;
  for (const item of pendingWrites.values()) {
    reservedBytes += item.reservedBytes;
    lifecycle[item.state] = (lifecycle[item.state] ?? 0) + 1;
  }
  return { active: pendingWrites.size, reservedBytes, lifecycle };
}

export interface PeonProjectFileUploadRequest extends PeonFileWriteBase {
  projectId: string;
  relativePath: string;
  source: Readable;
  contentLength?: number;
  sha256?: string;
  maxBytes: number;
}

export interface PeonSandboxFileUploadRequest extends PeonFileWriteBase {
  path: string;
  source: Readable;
  contentLength?: number;
  sha256?: string;
  maxBytes: number;
}

export interface PeonProjectFileMoveRequest extends PeonFileWriteBase {
  projectId: string;
  relativePath: string;
  destination: string;
}

function resetWriteTimer(item: PendingWrite): void {
  clearTimeout(item.timer);
  item.timer = setTimeout(() => {
    failWrite(item, new PeonFileStreamError("PEON_TRANSFER_TIMEOUT", "Peon file write timed out", 504), true);
  }, 5 * 60_000);
  item.timer.unref();
}

function cleanupWrite(item: PendingWrite): void {
  clearTimeout(item.timer);
  item.abort?.();
  item.wakeCredit?.();
  item.wakeCredit = null;
  const key = keyOf(item.peonId, item.requestId);
  pendingWrites.delete(key);
  rememberClosed(key);
}

function failWrite(item: PendingWrite, error: PeonFileStreamError, notifyPeon = false): void {
  if (!pendingWrites.has(keyOf(item.peonId, item.requestId))) return;
  if (notifyPeon && item.socket.readyState === WebSocket.OPEN) {
    item.socket.send(JSON.stringify({ type: "write_cancel", requestId: item.requestId, reason: error.code }));
  }
  cleanupWrite(item);
  item.reject(error);
}

function completeWrite(item: PendingWrite, result: PeonFileWriteResult): void {
  if (!pendingWrites.has(keyOf(item.peonId, item.requestId))) return;
  cleanupWrite(item);
  item.resolve(result);
}

function encodePeonFileWriteChunk(requestId: string, sequence: number, data: Uint8Array): Buffer {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff || data.byteLength > MAX_FILE_CHUNK_BYTES) {
    throw new Error("invalid file write chunk");
  }
  const frame = Buffer.allocUnsafe(BINARY_HEADER_BYTES + data.byteLength);
  frame[0] = 1;
  frame[1] = 2;
  uuidBytes(requestId).copy(frame, 2);
  frame.writeUInt32BE(sequence, 18);
  Buffer.from(data).copy(frame, BINARY_HEADER_BYTES);
  return frame;
}

async function waitForWriteCredit(item: PendingWrite): Promise<void> {
  while (item.credit <= 0) {
    if (!pendingWrites.has(keyOf(item.peonId, item.requestId))) {
      throw new PeonFileStreamError("TRANSFER_CANCELLED", "file write was cancelled", 499);
    }
    await new Promise<void>((resolve) => {
      item.wakeCredit = resolve;
    });
    item.wakeCredit = null;
  }
}

async function pumpWrite(item: PendingWrite): Promise<void> {
  if (!item.source || item.pumping) return;
  item.pumping = true;
  try {
    for await (const value of item.source) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let offset = 0;
      while (offset < chunk.length) {
        await waitForWriteCredit(item);
        const bytes = Math.min(chunk.length - offset, item.credit, MAX_FILE_CHUNK_BYTES);
        if (item.sentBytes + bytes > item.maxBytes) {
          throw new PeonFileStreamError("FILE_TOO_LARGE", `file exceeds ${item.maxBytes / (1024 * 1024)}MB limit`, 413);
        }
        if (item.socket.readyState !== WebSocket.OPEN) {
          throw new PeonFileStreamError("PEON_TRANSFER_DISCONNECTED", "Peon transfer connection closed", 502);
        }
        item.socket.send(encodePeonFileWriteChunk(item.requestId, item.sequence, chunk.subarray(offset, offset + bytes)));
        item.sequence += 1;
        item.credit -= bytes;
        item.sentBytes += bytes;
        offset += bytes;
      }
    }
    if (!pendingWrites.has(keyOf(item.peonId, item.requestId))) return;
    if (item.expectedBytes !== undefined && item.sentBytes !== item.expectedBytes) {
      throw new PeonFileStreamError("LENGTH_MISMATCH", "request body length does not match Content-Length", 400);
    }
    item.state = "verifying";
    resetWriteTimer(item);
    send(item.socket, { type: "write_end", requestId: item.requestId });
  } catch (error) {
    const failure = error instanceof PeonFileStreamError
      ? error
      : new PeonFileStreamError("UPLOAD_FAILED", error instanceof Error ? error.message : "file upload failed", 502);
    failWrite(item, failure, true);
  }
}

function handlePeonFileWriteJson(item: PendingWrite, socket: WebSocket, frame: Record<string, unknown>): boolean {
  if (item.socket !== socket) return false;
  if (frame.type === "write_error") {
    const status = Number.isInteger(frame.status) && Number(frame.status) >= 400 && Number(frame.status) <= 599 ? Number(frame.status) : 502;
    const code = stringField(frame, "code", 128) ?? "PEON_FILE_ERROR";
    const message = stringField(frame, "message", 2048) ?? "Peon refused the file write";
    failWrite(item, new PeonFileStreamError(code, auditSafeFileErrorMessage(code, message), status));
    return true;
  }
  if (frame.type === "write_ready" && item.state === "pending" && item.source) {
    const credit = frame.credit;
    const maxBytes = frame.maxBytes;
    if (
      !Number.isSafeInteger(credit) || Number(credit) <= 0 || Number(credit) > 1024 * 1024
      || !Number.isSafeInteger(maxBytes) || Number(maxBytes) <= 0
    ) return false;
    item.credit = Number(credit);
    item.maxBytes = Math.min(item.maxBytes, Number(maxBytes));
    if (item.expectedBytes !== undefined && item.expectedBytes > item.maxBytes) {
      failWrite(item, new PeonFileStreamError("FILE_TOO_LARGE", `file exceeds ${item.maxBytes / (1024 * 1024)}MB limit`, 413), true);
      return true;
    }
    item.state = "accepted";
    resetWriteTimer(item);
    item.state = "streaming";
    void pumpWrite(item);
    return true;
  }
  if (frame.type === "write_credit" && item.state === "streaming") {
    const bytes = frame.bytes;
    if (!Number.isSafeInteger(bytes) || Number(bytes) <= 0 || item.credit + Number(bytes) > 1024 * 1024) return false;
    item.credit += Number(bytes);
    resetWriteTimer(item);
    item.wakeCredit?.();
    return true;
  }
  if (frame.type === "write_result" && (item.state === "verifying" || !item.source)) {
    const status = Number(frame.status);
    const path = stringField(frame, "path", 4096);
    const size = frame.size;
    const sha256 = stringField(frame, "sha256", 64);
    if (
      !Number.isInteger(status) || status < 200 || status > 299
      || path === undefined || !Number.isSafeInteger(size) || Number(size) < 0
      || sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)
    ) return false;
    completeWrite(item, { status, path, size: Number(size), ...(sha256 ? { sha256 } : {}) });
    return true;
  }
  return false;
}

function validateWriteBase(input: PeonFileWriteBase): void {
  if (!input.workspaceId || input.workspaceId.length > 512 || input.workspaceId.includes("\0")) {
    throw new PeonFileStreamError("INVALID_WORKSPACE_ID", "trusted workspace is invalid", 400);
  }
  if (!input.actor.userId || input.actor.userId.length > 512 || !input.actor.email || input.actor.email.length > 512) {
    throw new PeonFileStreamError("INVALID_ACTOR", "trusted actor is invalid", 400);
  }
  if (input.commandId !== undefined && !UUID.test(input.commandId)) {
    throw new PeonFileStreamError("INVALID_COMMAND_ID", "command correlation ID is invalid", 400);
  }
}

function writeAdmissionUsage(input: PeonFileWriteBase): {
  userCount: number;
  workspaceCount: number;
  userBytes: number;
  workspaceBytes: number;
  globalBytes: number;
} {
  let userCount = 0;
  let workspaceCount = 0;
  let userBytes = 0;
  let workspaceBytes = 0;
  let globalBytes = 0;
  for (const item of pendingWrites.values()) {
    globalBytes += item.reservedBytes;
    if (item.workspaceId === input.workspaceId) {
      workspaceCount += 1;
      workspaceBytes += item.reservedBytes;
    }
    if (item.userId === input.actor.userId) {
      userCount += 1;
      userBytes += item.reservedBytes;
    }
  }
  return { userCount, workspaceCount, userBytes, workspaceBytes, globalBytes };
}

function openPeonWrite(
  input: PeonFileWriteBase,
  source: Readable | null,
  maxBytes: number,
  expectedBytes: number | undefined,
  frame: Record<string, unknown>,
): Promise<PeonFileWriteResult> {
  validateWriteBase(input);
  const reservedBytes = expectedBytes ?? maxBytes;
  const usage = writeAdmissionUsage(input);
  if (
    usage.userCount >= MAX_WRITES_PER_USER
    || usage.workspaceCount >= MAX_WRITES_PER_WORKSPACE
    || usage.userBytes + reservedBytes > MAX_RESERVED_WRITE_BYTES_PER_USER
    || usage.workspaceBytes + reservedBytes > MAX_RESERVED_WRITE_BYTES_PER_WORKSPACE
    || usage.globalBytes + reservedBytes > MAX_RESERVED_WRITE_BYTES_GLOBAL
  ) {
    throw new PeonFileStreamError("TRANSFER_QUOTA_EXCEEDED", "file write capacity is temporarily exhausted", 429);
  }
  if (pending.size + pendingWrites.size >= MAX_REQUESTS_GLOBAL || countForPeon(input.peonId) >= MAX_REQUESTS_PER_PEON) {
    throw new PeonFileStreamError("PEON_TRANSFER_BUSY", "too many active Peon file transfers", 429);
  }
  const socket = getPeonTransferConnection(input.peonId, FILE_WRITE_CAPABILITY);
  if (!socket) throw new PeonFileStreamError("PEON_TRANSFER_UNAVAILABLE", "Peon transfer connection is unavailable", 503);
  if (input.signal?.aborted) throw new PeonFileStreamError("TRANSFER_CANCELLED", "file write was cancelled", 499);
  const requestId = input.requestId && UUID.test(input.requestId) ? input.requestId : randomUUID();
  const commandId = input.commandId ?? requestId;
  const key = keyOf(input.peonId, requestId);
  if (pendingWrites.has(key) || pending.has(key)) throw new PeonFileStreamError("DUPLICATE_REQUEST", "file request is already active", 409);

  return new Promise<PeonFileWriteResult>((resolve, reject) => {
    const item: PendingWrite = {
      requestId,
      commandId,
      peonId: input.peonId,
      workspaceId: input.workspaceId,
      userId: input.actor.userId,
      socket,
      source,
      resolve,
      reject,
      timer: setTimeout(() => {}, META_TIMEOUT_MS),
      state: "pending",
      credit: 0,
      wakeCredit: null,
      sequence: 0,
      sentBytes: 0,
      expectedBytes,
      maxBytes,
      reservedBytes,
      pumping: false,
    };
    clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      failWrite(item, new PeonFileStreamError("PEON_TRANSFER_TIMEOUT", "Peon did not accept the file write in time", 504), true);
    }, META_TIMEOUT_MS);
    item.timer.unref();
    if (input.signal) {
      const onAbort = () => failWrite(item, new PeonFileStreamError("TRANSFER_CANCELLED", "file write was cancelled", 499), true);
      input.signal.addEventListener("abort", onAbort, { once: true });
      item.abort = () => input.signal?.removeEventListener("abort", onAbort);
    }
    pendingWrites.set(key, item);
    try {
      send(socket, {
        type: "write_open",
        protocol: 1,
        requestId,
        transferId: requestId,
        commandId,
        ...frame,
        actor: input.actor,
        ...(expectedBytes === undefined ? {} : { contentLength: expectedBytes }),
      });
      if (!source) item.state = "verifying";
    } catch (error) {
      failWrite(item, error instanceof PeonFileStreamError
        ? error
        : new PeonFileStreamError("PEON_TRANSFER_UNAVAILABLE", "Peon transfer connection is unavailable", 503));
    }
  });
}

export function uploadPeonProjectFile(input: PeonProjectFileUploadRequest): Promise<PeonFileWriteResult> {
  validateRequest({
    peonId: input.peonId,
    projectId: input.projectId,
    relativePath: input.relativePath,
    actor: input.actor,
  });
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new PeonFileStreamError("INVALID_LIMIT", "file write limit is invalid", 500);
  }
  if (input.contentLength !== undefined && (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0)) {
    throw new PeonFileStreamError("INVALID_LENGTH", "content length is invalid", 400);
  }
  if (input.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new PeonFileStreamError("INVALID_CHECKSUM", "sha256 must be a lowercase hexadecimal digest", 400);
  }
  return openPeonWrite(input, input.source, input.maxBytes, input.contentLength, {
    operation: "upload",
    scope: "project",
    projectId: input.projectId,
    relativePath: input.relativePath,
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
  });
}

export function uploadPeonSandboxFile(input: PeonSandboxFileUploadRequest): Promise<PeonFileWriteResult> {
  validateRelativePath(input.path);
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new PeonFileStreamError("INVALID_LIMIT", "file write limit is invalid", 500);
  }
  if (input.contentLength !== undefined && (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0)) {
    throw new PeonFileStreamError("INVALID_LENGTH", "content length is invalid", 400);
  }
  if (input.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new PeonFileStreamError("INVALID_CHECKSUM", "sha256 must be a lowercase hexadecimal digest", 400);
  }
  return openPeonWrite(input, input.source, input.maxBytes, input.contentLength, {
    operation: "upload",
    scope: "sandbox",
    path: input.path,
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
  });
}

export function movePeonProjectFile(input: PeonProjectFileMoveRequest): Promise<PeonFileWriteResult> {
  validateRequest({
    peonId: input.peonId,
    projectId: input.projectId,
    relativePath: input.relativePath,
    actor: input.actor,
  });
  validateRelativePath(input.destination);
  return openPeonWrite(input, null, 1, undefined, {
    operation: "move",
    scope: "project",
    projectId: input.projectId,
    relativePath: input.relativePath,
    destination: input.destination,
  });
}
