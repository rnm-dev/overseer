import { randomUUID } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import { WebSocket } from "ws";
import { getPeonTransferConnection, PROJECT_FILE_READ_CAPABILITY } from "./peonTransferConnections.js";

const META_TIMEOUT_MS = 15_000;
const STREAM_HIGH_WATER_MARK = 256 * 1024;
const MAX_REQUESTS_PER_PEON = 32;
const MAX_REQUESTS_GLOBAL = 256;
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

const pending = new Map<string, Pending>();
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

export async function openPeonProjectFile(input: ProjectFileStreamRequest): Promise<ProjectFileStream> {
  validateRequest(input);
  if (pending.size >= MAX_REQUESTS_GLOBAL || countForPeon(input.peonId) >= MAX_REQUESTS_PER_PEON) {
    throw new PeonFileStreamError("PEON_TRANSFER_BUSY", "too many active Peon file transfers", 429);
  }
  const socket = getPeonTransferConnection(input.peonId, PROJECT_FILE_READ_CAPABILITY);
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
        type: "file_open", protocol: 1, requestId, projectId: input.projectId,
        relativePath: input.relativePath, actor: input.actor,
        ...(input.range ? { range: input.range } : {}),
      });
    } catch (error) {
      fail(item, error instanceof PeonFileStreamError ? error : new PeonFileStreamError("PEON_TRANSFER_UNAVAILABLE", "Peon transfer connection is unavailable", 503));
    }
  });
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
  const item = pending.get(key);
  if (!item) return wasRecentlyClosed(key);
  if (item.socket !== socket) return false;
  if (frame.type === "file_error") {
    const status = Number.isInteger(frame.status) && Number(frame.status) >= 400 && Number(frame.status) <= 599 ? Number(frame.status) : 502;
    fail(item, new PeonFileStreamError(stringField(frame, "code", 128) ?? "PEON_FILE_ERROR", stringField(frame, "message", 2048) ?? "Peon could not open the file", status));
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
}
