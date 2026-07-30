import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { PeonSocketChannel, PeonSocketFrame, PeonSocketSender } from "../peonSocketProtocol.js";
import { projectStore, type ProjectRecord } from "../../../projects/index.js";
import { resolveWithinDir } from "../../../files/index.js";
import { sessions, type SessionRecord } from "../../../sessions/index.js";

export const PROJECT_FILE_READ_CAPABILITY = "project-file-read-v1";
export const SANDBOX_FILE_READ_CAPABILITY = "sandbox-file-read-v1";
export const SESSION_ARTIFACT_CAPABILITY = "session-artifact-v1";
export const PROJECT_FILE_BINARY_HEADER_BYTES = 22;
export const PROJECT_FILE_MAX_CHUNK_BYTES = 64 * 1024 - PROJECT_FILE_BINARY_HEADER_BYTES;
export const PROJECT_FILE_MAX_ACTIVE = 32;
export const SESSION_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;

const PROTOCOL_VERSION = 1;
const MAX_CREDIT_BYTES = 1024 * 1024;
const RETRY_DELAY_MS = 5;
const MAX_RETRY_DELAY_MS = 1000;
const DEFAULT_IDLE_LEASE_MS = 60_000;
const CLOSED_REQUEST_TTL_MS = 30_000;
const MAX_CLOSED_REQUESTS = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FRAME_TYPES = new Set(["file_open", "file_credit", "file_cancel"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

const SESSION_ARTIFACT_SAFE_MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".webp": "image/webp",
};

interface ProjectLookup { list(): ProjectRecord[] }
interface SessionLookup { get(id: string): SessionRecord | undefined }

interface FileRange { start: number; end?: number }

interface ActiveRead {
  requestId: string;
  resourceId: string | null;
  sender: PeonSocketSender;
  handle: FileHandle | null;
  phase: "opening" | "streaming" | "ending";
  offset: number;
  remaining: number;
  credit: number;
  sequence: number;
  pendingFrame: Buffer | null;
  pumping: boolean;
  retry: ReturnType<typeof setTimeout> | null;
  retryDelayMs: number;
  lease: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
}

interface ProjectFileReadOptions {
  projects?: ProjectLookup;
  maxActive?: number;
  idleLeaseMs?: number;
  fileSystem?: Pick<typeof fs, "open" | "stat">;
  resolvePath?: typeof resolveWithinDir;
  capability?: typeof PROJECT_FILE_READ_CAPABILITY | typeof SANDBOX_FILE_READ_CAPABILITY | typeof SESSION_ARTIFACT_CAPABILITY;
  sandboxRoot?: () => string;
  sessions?: SessionLookup;
}

class ProjectFileError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function stringField(frame: PeonSocketFrame, key: string, max: number): string | null {
  const value = frame[key];
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function relativeFilePath(frame: PeonSocketFrame): string {
  const value = stringField(frame, "relativePath", 4096);
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[a-z]:\//i.test(value)
    || value.split("/").some((part) => part === "" || part === "..")) {
    throw new ProjectFileError(400, "INVALID_PROJECT_PATH", "a non-empty project-relative path is required");
  }
  return value;
}

function requestedRange(value: unknown): FileRange | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectFileError(416, "INVALID_RANGE", "invalid byte range");
  }
  const range = value as Record<string, unknown>;
  if (!Number.isSafeInteger(range.start) || Number(range.start) < 0
    || (range.end !== undefined && (!Number.isSafeInteger(range.end) || Number(range.end) < Number(range.start)))) {
    throw new ProjectFileError(416, "INVALID_RANGE", "invalid byte range");
  }
  return { start: Number(range.start), ...(range.end === undefined ? {} : { end: Number(range.end) }) };
}

function validateActor(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectFileError(400, "INVALID_ACTOR", "trusted actor is required");
  }
  const actor = value as Record<string, unknown>;
  if (typeof actor.userId !== "string" || !actor.userId || actor.userId.length > 512
    || typeof actor.email !== "string" || !actor.email || actor.email.length > 512
    || actor.userId.includes("\0") || actor.email.includes("\0")) {
    throw new ProjectFileError(400, "INVALID_ACTOR", "trusted actor is invalid");
  }
}

function filesystemError(error: unknown): ProjectFileError {
  if (error instanceof ProjectFileError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new ProjectFileError(404, "NOT_FOUND", "file does not exist");
  if (code === "EACCES" || code === "EPERM") return new ProjectFileError(403, "FORBIDDEN", "file is not readable");
  if (code === "EISDIR") return new ProjectFileError(400, "IS_DIRECTORY", "path is a directory");
  if (code === "ENXIO" || code === "ENODEV") return new ProjectFileError(400, "NOT_FILE", "path is not a regular file");
  if (code === "ENOTDIR" || code === "ELOOP" || code === "EINVAL") return new ProjectFileError(400, "INVALID_PROJECT_PATH", "project file path is invalid");
  return new ProjectFileError(500, "INTERNAL", "failed to read project file");
}

function etag(stat: Stats): string {
  return `W/\"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}\"`;
}

function encodeChunk(requestId: string, sequence: number, data: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(PROJECT_FILE_BINARY_HEADER_BYTES + data.byteLength);
  output[0] = PROTOCOL_VERSION;
  output[1] = 1;
  Buffer.from(requestId.replaceAll("-", ""), "hex").copy(output, 2);
  output.writeUInt32BE(sequence, 18);
  Buffer.from(data).copy(output, PROJECT_FILE_BINARY_HEADER_BYTES);
  return output;
}

export class ProjectFileReadChannel implements PeonSocketChannel {
  readonly capability: typeof PROJECT_FILE_READ_CAPABILITY | typeof SANDBOX_FILE_READ_CAPABILITY | typeof SESSION_ARTIFACT_CAPABILITY;
  private readonly projects: ProjectLookup;
  private readonly maxActive: number;
  private readonly idleLeaseMs: number;
  private readonly fileSystem: Pick<typeof fs, "open" | "stat">;
  private readonly resolvePath: typeof resolveWithinDir;
  private readonly sandboxRoot: (() => string) | null;
  private readonly sessions: SessionLookup | null;
  private accepted = false;
  private readonly active = new Map<string, ActiveRead>();
  private readonly recentlyClosed = new Map<string, number>();

  constructor(options: ProjectFileReadOptions = {}) {
    this.projects = options.projects ?? projectStore;
    this.maxActive = options.maxActive ?? PROJECT_FILE_MAX_ACTIVE;
    this.idleLeaseMs = options.idleLeaseMs ?? DEFAULT_IDLE_LEASE_MS;
    this.fileSystem = options.fileSystem ?? fs;
    this.resolvePath = options.resolvePath ?? resolveWithinDir;
    this.capability = options.capability ?? PROJECT_FILE_READ_CAPABILITY;
    this.sandboxRoot = options.sandboxRoot ?? null;
    this.sessions = options.sessions ?? null;
  }

  helloState(): PeonSocketFrame { return {}; }
  started(_sender: PeonSocketSender): void {}
  connecting(): void {}

  negotiated(accepted: boolean, _acknowledgement: PeonSocketFrame, _sender: PeonSocketSender): void {
    this.accepted = accepted;
    if (!accepted) this.releaseAll();
  }

  disconnected(_resetAuthority: boolean): void {
    this.accepted = false;
    this.releaseAll();
  }

  handles(frame: PeonSocketFrame): boolean {
    if (typeof frame.type !== "string" || !FRAME_TYPES.has(frame.type)) return false;
    if (frame.type === "file_open") {
      if (this.sessions) return frame.scope === "session";
      return this.sandboxRoot ? frame.scope === "sandbox" : frame.scope === undefined || frame.scope === "project";
    }
    const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
    return this.active.has(requestId) || this.wasRecentlyClosed(requestId);
  }

  receive(frame: PeonSocketFrame, sender: PeonSocketSender): void {
    if (!this.accepted) return sender.disconnect("unnegotiated project file frame");
    const requestId = stringField(frame, "requestId", 36);
    if (!requestId || !UUID.test(requestId)) return sender.disconnect("invalid project file request id");

    if (frame.type === "file_cancel") {
      const active = this.active.get(requestId);
      if (active) this.release(active);
      return;
    }

    if (frame.type === "file_credit") {
      const active = this.active.get(requestId);
      const bytes = frame.bytes;
      // Overseer replenishes credit after accepting every chunk, including the
      // final chunk. That last grant can cross `file_end` on the full-duplex
      // wire, so a short tombstone is required to keep normal completion from
      // tearing down the shared transfer socket.
      if (!active) {
        if (this.wasRecentlyClosed(requestId)) return;
        return sender.disconnect("invalid project file credit");
      }
      if (active.phase === "ending") return;
      if (active.phase !== "streaming" || !Number.isSafeInteger(bytes) || Number(bytes) <= 0
        || active.credit + Number(bytes) > MAX_CREDIT_BYTES) {
        return sender.disconnect("invalid project file credit");
      }
      active.credit += Number(bytes);
      this.refreshLease(active);
      void this.pump(active);
      return;
    }

    if (frame.protocol !== PROTOCOL_VERSION) return this.error(sender, requestId, 400, "BAD_PROTOCOL", "unsupported file protocol version");
    if (this.active.has(requestId)) return this.error(sender, requestId, 409, "DUPLICATE_REQUEST", "file request is already active");
    if (this.active.size >= this.maxActive) return this.error(sender, requestId, 429, "TRANSFER_BUSY", "too many active file reads");

    let resourceId: string | null = null;
    let filePath: string;
    let range: FileRange | null;
    try {
      if (this.sessions) {
        resourceId = stringField(frame, "sessionId", 512);
        if (!resourceId || resourceId.includes("\0")) throw new ProjectFileError(400, "INVALID_SESSION_ID", "a valid session ID is required");
        filePath = stringField(frame, "path", 4096) ?? "";
        if (!filePath || filePath.includes("\0") || filePath.includes("\\")
          || filePath.split("/").some((part) => part === "..")) {
          throw new ProjectFileError(400, "INVALID_PATH", "a contained session artifact path is required");
        }
      } else if (this.sandboxRoot) {
        const value = stringField(frame, "path", 4096);
        if (!value || value.includes("\0")) {
          throw new ProjectFileError(400, "INVALID_PATH", "a non-empty sandbox file path is required");
        }
        filePath = value;
      } else {
        resourceId = stringField(frame, "projectId", 512);
        if (!resourceId || resourceId.includes("\0")) throw new ProjectFileError(400, "INVALID_PROJECT_ID", "a valid project ID is required");
        filePath = relativeFilePath(frame);
      }
      range = requestedRange(frame.range);
      validateActor(frame.actor);
      if (this.sessions && [...this.active.values()].filter((item) => item.resourceId === resourceId).length >= 8) {
        throw new ProjectFileError(429, "TRANSFER_BUSY", "too many active reads for this session");
      }
    } catch (error) {
      const failure = filesystemError(error);
      return this.error(sender, requestId, failure.status, failure.code, failure.message);
    }

    const active: ActiveRead = {
      requestId, resourceId, sender, handle: null, phase: "opening", offset: 0, remaining: 0,
      credit: 0, sequence: 0, pendingFrame: null, pumping: false, retry: null,
      retryDelayMs: RETRY_DELAY_MS, lease: null, cancelled: false,
    };
    this.active.set(requestId, active);
    active.lease = this.createLease(active);
    void this.open(active, resourceId, filePath, range);
  }

  private async open(active: ActiveRead, resourceId: string | null, filePath: string, range: FileRange | null): Promise<void> {
    try {
      const root = this.sandboxRoot ? this.sandboxRoot().trim() : "";
      const session = this.sessions ? this.sessions.get(resourceId ?? "") : null;
      const project = this.sandboxRoot || this.sessions ? null : this.projects.list().find((candidate) => candidate.projectId === resourceId);
      if (this.sessions && !session) throw new ProjectFileError(404, "UNKNOWN_SESSION", "unknown session");
      if (!this.sandboxRoot && !this.sessions && !project) throw new ProjectFileError(404, "UNKNOWN_PROJECT", "unknown project");
      if (this.sandboxRoot && !root) throw new ProjectFileError(503, "FILES_DISABLED", "file transfer is disabled — set fileTransferRoot to enable it");
      const base = session?.dir ?? project?.dir ?? root;
      const absolute = this.resolvePath(base, filePath);
      const scopeName = this.sessions ? "session root" : this.sandboxRoot ? "file transfer root" : "project root";
      if (!absolute) throw new ProjectFileError(400, "PATH_ESCAPE", `file path escapes the ${scopeName}`);
      // A blocking read-only open can wait forever on a contained FIFO before
      // we get a handle to classify it. Nonblocking has no effect on regular
      // files and lets the post-open fstat reject every special file promptly.
      const handle = await this.fileSystem.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      if (!this.isCurrent(active)) {
        await handle.close();
        return;
      }
      active.handle = handle;
      const stat = await handle.stat();
      // `resolveWithinDir` and `open` are separate syscalls. Re-resolve after
      // opening and compare the opened inode with the currently-contained
      // target so a concurrent directory/symlink swap cannot redirect the
      // stream outside the project root.
      const revalidated = this.resolvePath(base, filePath);
      if (!revalidated) throw new ProjectFileError(400, "PATH_ESCAPE", `file path escapes the ${scopeName}`);
      const targetStat = await this.fileSystem.stat(revalidated);
      if (targetStat.dev !== stat.dev || targetStat.ino !== stat.ino) {
        throw new ProjectFileError(409, "FILE_CHANGED", "file changed while it was being opened");
      }
      if (!stat.isFile()) throw new ProjectFileError(400, stat.isDirectory() ? "IS_DIRECTORY" : "NOT_FILE", "path is not a regular file");
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new ProjectFileError(500, "FILE_TOO_LARGE", "file size cannot be represented safely");
      if (this.sessions && stat.size > SESSION_ARTIFACT_MAX_BYTES) {
        throw new ProjectFileError(413, "FILE_TOO_LARGE", "session artifact exceeds the 1GB transfer limit");
      }
      if (!this.isCurrent(active)) return this.release(active);

      let start = 0;
      let end = stat.size - 1;
      let status: 200 | 206 = 200;
      if (range) {
        if (range.start >= stat.size) throw new ProjectFileError(416, "RANGE_NOT_SATISFIABLE", "byte range starts beyond the file");
        start = range.start;
        end = Math.min(range.end ?? end, end);
        status = 206;
      }
      const contentLength = stat.size === 0 ? 0 : end - start + 1;
      active.offset = start;
      active.remaining = contentLength;
      active.phase = "streaming";
      this.refreshLease(active);
      const meta: PeonSocketFrame = {
        type: "file_meta", requestId: active.requestId, status,
        contentType: (this.sessions ? SESSION_ARTIFACT_SAFE_MIME_BY_EXTENSION : MIME_BY_EXTENSION)[path.extname(absolute).toLowerCase()]
          ?? "application/octet-stream",
        contentLength, acceptRanges: "bytes", etag: etag(stat), lastModified: stat.mtime.toUTCString(),
        ...(status === 206 ? { contentRange: `bytes ${start}-${end}/${stat.size}` } : {}),
      };
      if (!active.sender.send(meta)) {
        this.release(active);
        return active.sender.disconnect("project file metadata backpressure limit exceeded");
      }
      if (contentLength === 0) {
        active.phase = "ending";
        void this.pump(active);
      }
    } catch (error) {
      if (!this.isCurrent(active)) return;
      const failure = filesystemError(error);
      this.error(active.sender, active.requestId, failure.status, failure.code, failure.message);
      this.release(active);
    }
  }

  private async pump(active: ActiveRead): Promise<void> {
    if (!this.isCurrent(active) || active.pumping) return;
    active.pumping = true;
    try {
      while (this.isCurrent(active)) {
        if (active.phase === "ending") {
          if (!active.sender.send({ type: "file_end", requestId: active.requestId })) return this.retryPump(active);
          return this.release(active);
        }
        if (active.credit <= 0 || active.remaining <= 0) {
          if (active.remaining <= 0) active.phase = "ending";
          if (active.phase === "ending") continue;
          return;
        }
        if (!active.pendingFrame) {
          const bytes = Math.min(PROJECT_FILE_MAX_CHUNK_BYTES, active.credit, active.remaining);
          const buffer = Buffer.allocUnsafe(bytes);
          const result = await active.handle!.read(buffer, 0, bytes, active.offset);
          if (!this.isCurrent(active)) return;
          if (result.bytesRead <= 0) throw new Error("project file ended before advertised length");
          active.pendingFrame = encodeChunk(active.requestId, active.sequence, buffer.subarray(0, result.bytesRead));
        }
        if (!active.sender.sendBinary(active.pendingFrame)) return this.retryPump(active);
        const payloadBytes = active.pendingFrame.byteLength - PROJECT_FILE_BINARY_HEADER_BYTES;
        active.pendingFrame = null;
        active.credit -= payloadBytes;
        active.remaining -= payloadBytes;
        active.offset += payloadBytes;
        active.sequence += 1;
        active.retryDelayMs = RETRY_DELAY_MS;
        this.refreshLease(active);
        if (active.sequence > 0xffffffff && active.remaining > 0) throw new Error("project file requires too many chunks");
      }
    } catch {
      if (this.isCurrent(active)) {
        this.release(active);
        active.sender.disconnect("project file read failed after streaming began");
      }
    } finally {
      active.pumping = false;
    }
  }

  private retryPump(active: ActiveRead): void {
    if (!this.isCurrent(active) || active.retry) return;
    const delay = active.retryDelayMs;
    active.retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, active.retryDelayMs * 2);
    active.retry = setTimeout(() => {
      active.retry = null;
      void this.pump(active);
    }, delay);
    active.retry.unref();
  }

  private createLease(active: ActiveRead): ReturnType<typeof setTimeout> {
    const lease = setTimeout(() => {
      if (!this.isCurrent(active)) return;
      this.release(active);
      active.sender.disconnect("project file transfer timed out");
    }, this.idleLeaseMs);
    lease.unref();
    return lease;
  }

  private refreshLease(active: ActiveRead): void {
    if (!this.isCurrent(active)) return;
    if (active.lease) clearTimeout(active.lease);
    active.lease = this.createLease(active);
  }

  private rememberClosed(requestId: string): void {
    const now = Date.now();
    this.recentlyClosed.set(requestId, now + CLOSED_REQUEST_TTL_MS);
    for (const [candidate, expiresAt] of this.recentlyClosed) {
      if (expiresAt <= now || this.recentlyClosed.size > MAX_CLOSED_REQUESTS) this.recentlyClosed.delete(candidate);
    }
  }

  private wasRecentlyClosed(requestId: string): boolean {
    const expiresAt = this.recentlyClosed.get(requestId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.recentlyClosed.delete(requestId);
      return false;
    }
    return true;
  }

  private isCurrent(active: ActiveRead): boolean {
    return !active.cancelled && this.active.get(active.requestId) === active;
  }

  private release(active: ActiveRead): void {
    if (active.cancelled) return;
    active.cancelled = true;
    if (active.retry) clearTimeout(active.retry);
    active.retry = null;
    if (active.lease) clearTimeout(active.lease);
    active.lease = null;
    this.active.delete(active.requestId);
    this.rememberClosed(active.requestId);
    const handle = active.handle;
    active.handle = null;
    if (handle) void handle.close().catch(() => {});
  }

  private releaseAll(): void {
    for (const active of [...this.active.values()]) this.release(active);
  }

  private error(sender: PeonSocketSender, requestId: string, status: number, code: string, message: string): void {
    if (!sender.send({ type: "file_error", requestId, status, code, message })) {
      sender.disconnect("project file error backpressure limit exceeded");
    }
  }
}

export class SandboxFileReadChannel extends ProjectFileReadChannel {
  constructor(options: Omit<ProjectFileReadOptions, "capability"> & { sandboxRoot: () => string }) {
    super({ ...options, capability: SANDBOX_FILE_READ_CAPABILITY });
  }
}

export class SessionArtifactReadChannel extends ProjectFileReadChannel {
  constructor(options: Omit<ProjectFileReadOptions, "capability" | "sessions"> & { sessions?: SessionLookup } = {}) {
    super({ ...options, capability: SESSION_ARTIFACT_CAPABILITY, sessions: options.sessions ?? sessions });
  }
}
