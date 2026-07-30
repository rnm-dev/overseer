import { promises as fs } from "node:fs";
import path from "node:path";
import { projectStore } from "../../../projects/index.js";
import { resolveWithinDir } from "../../../files/index.js";
export const PROJECT_FILE_READ_CAPABILITY = "project-file-read-v1";
export const SANDBOX_FILE_READ_CAPABILITY = "sandbox-file-read-v1";
export const PROJECT_FILE_BINARY_HEADER_BYTES = 22;
export const PROJECT_FILE_MAX_CHUNK_BYTES = 64 * 1024 - PROJECT_FILE_BINARY_HEADER_BYTES;
export const PROJECT_FILE_MAX_ACTIVE = 32;
const PROTOCOL_VERSION = 1;
const MAX_CREDIT_BYTES = 1024 * 1024;
const RETRY_DELAY_MS = 5;
const MAX_RETRY_DELAY_MS = 1000;
const DEFAULT_IDLE_LEASE_MS = 60_000;
const CLOSED_REQUEST_TTL_MS = 30_000;
const MAX_CLOSED_REQUESTS = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FRAME_TYPES = new Set(["file_open", "file_credit", "file_cancel"]);
const MIME_BY_EXTENSION = {
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
class ProjectFileError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
function stringField(frame, key, max) {
    const value = frame[key];
    return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}
function relativeFilePath(frame) {
    const value = stringField(frame, "relativePath", 4096);
    if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[a-z]:\//i.test(value)
        || value.split("/").some((part) => part === "" || part === "..")) {
        throw new ProjectFileError(400, "INVALID_PROJECT_PATH", "a non-empty project-relative path is required");
    }
    return value;
}
function requestedRange(value) {
    if (value === undefined)
        return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ProjectFileError(416, "INVALID_RANGE", "invalid byte range");
    }
    const range = value;
    if (!Number.isSafeInteger(range.start) || Number(range.start) < 0
        || (range.end !== undefined && (!Number.isSafeInteger(range.end) || Number(range.end) < Number(range.start)))) {
        throw new ProjectFileError(416, "INVALID_RANGE", "invalid byte range");
    }
    return { start: Number(range.start), ...(range.end === undefined ? {} : { end: Number(range.end) }) };
}
function validateActor(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ProjectFileError(400, "INVALID_ACTOR", "trusted actor is required");
    }
    const actor = value;
    if (typeof actor.userId !== "string" || !actor.userId || actor.userId.length > 512
        || typeof actor.email !== "string" || !actor.email || actor.email.length > 512
        || actor.userId.includes("\0") || actor.email.includes("\0")) {
        throw new ProjectFileError(400, "INVALID_ACTOR", "trusted actor is invalid");
    }
}
function filesystemError(error) {
    if (error instanceof ProjectFileError)
        return error;
    const code = error.code;
    if (code === "ENOENT")
        return new ProjectFileError(404, "NOT_FOUND", "file does not exist");
    if (code === "EACCES" || code === "EPERM")
        return new ProjectFileError(403, "FORBIDDEN", "file is not readable");
    if (code === "EISDIR")
        return new ProjectFileError(400, "IS_DIRECTORY", "path is a directory");
    if (code === "ENOTDIR" || code === "ELOOP" || code === "EINVAL")
        return new ProjectFileError(400, "INVALID_PROJECT_PATH", "project file path is invalid");
    return new ProjectFileError(500, "INTERNAL", "failed to read project file");
}
function etag(stat) {
    return `W/\"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}\"`;
}
function encodeChunk(requestId, sequence, data) {
    const output = Buffer.allocUnsafe(PROJECT_FILE_BINARY_HEADER_BYTES + data.byteLength);
    output[0] = PROTOCOL_VERSION;
    output[1] = 1;
    Buffer.from(requestId.replaceAll("-", ""), "hex").copy(output, 2);
    output.writeUInt32BE(sequence, 18);
    Buffer.from(data).copy(output, PROJECT_FILE_BINARY_HEADER_BYTES);
    return output;
}
export class ProjectFileReadChannel {
    capability;
    projects;
    maxActive;
    idleLeaseMs;
    fileSystem;
    resolvePath;
    sandboxRoot;
    accepted = false;
    active = new Map();
    recentlyClosed = new Map();
    constructor(options = {}) {
        this.projects = options.projects ?? projectStore;
        this.maxActive = options.maxActive ?? PROJECT_FILE_MAX_ACTIVE;
        this.idleLeaseMs = options.idleLeaseMs ?? DEFAULT_IDLE_LEASE_MS;
        this.fileSystem = options.fileSystem ?? fs;
        this.resolvePath = options.resolvePath ?? resolveWithinDir;
        this.capability = options.capability ?? PROJECT_FILE_READ_CAPABILITY;
        this.sandboxRoot = options.sandboxRoot ?? null;
    }
    helloState() { return {}; }
    started(_sender) { }
    connecting() { }
    negotiated(accepted, _acknowledgement, _sender) {
        this.accepted = accepted;
        if (!accepted)
            this.releaseAll();
    }
    disconnected(_resetAuthority) {
        this.accepted = false;
        this.releaseAll();
    }
    handles(frame) {
        if (typeof frame.type !== "string" || !FRAME_TYPES.has(frame.type))
            return false;
        if (frame.type === "file_open") {
            return this.sandboxRoot ? frame.scope === "sandbox" : frame.scope === undefined || frame.scope === "project";
        }
        const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
        return this.active.has(requestId) || this.wasRecentlyClosed(requestId);
    }
    receive(frame, sender) {
        if (!this.accepted)
            return sender.disconnect("unnegotiated project file frame");
        const requestId = stringField(frame, "requestId", 36);
        if (!requestId || !UUID.test(requestId))
            return sender.disconnect("invalid project file request id");
        if (frame.type === "file_cancel") {
            const active = this.active.get(requestId);
            if (active)
                this.release(active);
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
                if (this.wasRecentlyClosed(requestId))
                    return;
                return sender.disconnect("invalid project file credit");
            }
            if (active.phase === "ending")
                return;
            if (active.phase !== "streaming" || !Number.isSafeInteger(bytes) || Number(bytes) <= 0
                || active.credit + Number(bytes) > MAX_CREDIT_BYTES) {
                return sender.disconnect("invalid project file credit");
            }
            active.credit += Number(bytes);
            this.refreshLease(active);
            void this.pump(active);
            return;
        }
        if (frame.protocol !== PROTOCOL_VERSION)
            return this.error(sender, requestId, 400, "BAD_PROTOCOL", "unsupported file protocol version");
        if (this.active.has(requestId))
            return this.error(sender, requestId, 409, "DUPLICATE_REQUEST", "file request is already active");
        if (this.active.size >= this.maxActive)
            return this.error(sender, requestId, 429, "TRANSFER_BUSY", "too many active file reads");
        let projectId = null;
        let filePath;
        let range;
        try {
            if (this.sandboxRoot) {
                const value = stringField(frame, "path", 4096);
                if (!value || value.includes("\0")) {
                    throw new ProjectFileError(400, "INVALID_PATH", "a non-empty sandbox file path is required");
                }
                filePath = value;
            }
            else {
                projectId = stringField(frame, "projectId", 512);
                if (!projectId || projectId.includes("\0"))
                    throw new ProjectFileError(400, "INVALID_PROJECT_ID", "a valid project ID is required");
                filePath = relativeFilePath(frame);
            }
            range = requestedRange(frame.range);
            validateActor(frame.actor);
        }
        catch (error) {
            const failure = filesystemError(error);
            return this.error(sender, requestId, failure.status, failure.code, failure.message);
        }
        const active = {
            requestId, sender, handle: null, phase: "opening", offset: 0, remaining: 0,
            credit: 0, sequence: 0, pendingFrame: null, pumping: false, retry: null,
            retryDelayMs: RETRY_DELAY_MS, lease: null, cancelled: false,
        };
        this.active.set(requestId, active);
        active.lease = this.createLease(active);
        void this.open(active, projectId, filePath, range);
    }
    async open(active, projectId, filePath, range) {
        try {
            const root = this.sandboxRoot ? this.sandboxRoot().trim() : "";
            const project = this.sandboxRoot ? null : this.projects.list().find((candidate) => candidate.projectId === projectId);
            if (!this.sandboxRoot && !project)
                throw new ProjectFileError(404, "UNKNOWN_PROJECT", "unknown project");
            if (this.sandboxRoot && !root)
                throw new ProjectFileError(503, "FILES_DISABLED", "file transfer is disabled — set fileTransferRoot to enable it");
            const base = project?.dir ?? root;
            const absolute = this.resolvePath(base, filePath);
            if (!absolute)
                throw new ProjectFileError(400, "PATH_ESCAPE", `file path escapes the ${this.sandboxRoot ? "file transfer root" : "project root"}`);
            const handle = await this.fileSystem.open(absolute, "r");
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
            if (!revalidated)
                throw new ProjectFileError(400, "PATH_ESCAPE", `file path escapes the ${this.sandboxRoot ? "file transfer root" : "project root"}`);
            const targetStat = await this.fileSystem.stat(revalidated);
            if (targetStat.dev !== stat.dev || targetStat.ino !== stat.ino) {
                throw new ProjectFileError(409, "FILE_CHANGED", "file changed while it was being opened");
            }
            if (!stat.isFile())
                throw new ProjectFileError(400, stat.isDirectory() ? "IS_DIRECTORY" : "NOT_FILE", "path is not a regular file");
            if (!Number.isSafeInteger(stat.size) || stat.size < 0)
                throw new ProjectFileError(500, "FILE_TOO_LARGE", "file size cannot be represented safely");
            if (!this.isCurrent(active))
                return this.release(active);
            let start = 0;
            let end = stat.size - 1;
            let status = 200;
            if (range) {
                if (range.start >= stat.size)
                    throw new ProjectFileError(416, "RANGE_NOT_SATISFIABLE", "byte range starts beyond the file");
                start = range.start;
                end = Math.min(range.end ?? end, end);
                status = 206;
            }
            const contentLength = stat.size === 0 ? 0 : end - start + 1;
            active.offset = start;
            active.remaining = contentLength;
            active.phase = "streaming";
            this.refreshLease(active);
            const meta = {
                type: "file_meta", requestId: active.requestId, status,
                contentType: MIME_BY_EXTENSION[path.extname(absolute).toLowerCase()] ?? "application/octet-stream",
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
        }
        catch (error) {
            if (!this.isCurrent(active))
                return;
            const failure = filesystemError(error);
            this.error(active.sender, active.requestId, failure.status, failure.code, failure.message);
            this.release(active);
        }
    }
    async pump(active) {
        if (!this.isCurrent(active) || active.pumping)
            return;
        active.pumping = true;
        try {
            while (this.isCurrent(active)) {
                if (active.phase === "ending") {
                    if (!active.sender.send({ type: "file_end", requestId: active.requestId }))
                        return this.retryPump(active);
                    return this.release(active);
                }
                if (active.credit <= 0 || active.remaining <= 0) {
                    if (active.remaining <= 0)
                        active.phase = "ending";
                    if (active.phase === "ending")
                        continue;
                    return;
                }
                if (!active.pendingFrame) {
                    const bytes = Math.min(PROJECT_FILE_MAX_CHUNK_BYTES, active.credit, active.remaining);
                    const buffer = Buffer.allocUnsafe(bytes);
                    const result = await active.handle.read(buffer, 0, bytes, active.offset);
                    if (!this.isCurrent(active))
                        return;
                    if (result.bytesRead <= 0)
                        throw new Error("project file ended before advertised length");
                    active.pendingFrame = encodeChunk(active.requestId, active.sequence, buffer.subarray(0, result.bytesRead));
                }
                if (!active.sender.sendBinary(active.pendingFrame))
                    return this.retryPump(active);
                const payloadBytes = active.pendingFrame.byteLength - PROJECT_FILE_BINARY_HEADER_BYTES;
                active.pendingFrame = null;
                active.credit -= payloadBytes;
                active.remaining -= payloadBytes;
                active.offset += payloadBytes;
                active.sequence += 1;
                active.retryDelayMs = RETRY_DELAY_MS;
                this.refreshLease(active);
                if (active.sequence > 0xffffffff && active.remaining > 0)
                    throw new Error("project file requires too many chunks");
            }
        }
        catch {
            if (this.isCurrent(active)) {
                this.release(active);
                active.sender.disconnect("project file read failed after streaming began");
            }
        }
        finally {
            active.pumping = false;
        }
    }
    retryPump(active) {
        if (!this.isCurrent(active) || active.retry)
            return;
        const delay = active.retryDelayMs;
        active.retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, active.retryDelayMs * 2);
        active.retry = setTimeout(() => {
            active.retry = null;
            void this.pump(active);
        }, delay);
        active.retry.unref();
    }
    createLease(active) {
        const lease = setTimeout(() => {
            if (!this.isCurrent(active))
                return;
            this.release(active);
            active.sender.disconnect("project file transfer timed out");
        }, this.idleLeaseMs);
        lease.unref();
        return lease;
    }
    refreshLease(active) {
        if (!this.isCurrent(active))
            return;
        if (active.lease)
            clearTimeout(active.lease);
        active.lease = this.createLease(active);
    }
    rememberClosed(requestId) {
        const now = Date.now();
        this.recentlyClosed.set(requestId, now + CLOSED_REQUEST_TTL_MS);
        for (const [candidate, expiresAt] of this.recentlyClosed) {
            if (expiresAt <= now || this.recentlyClosed.size > MAX_CLOSED_REQUESTS)
                this.recentlyClosed.delete(candidate);
        }
    }
    wasRecentlyClosed(requestId) {
        const expiresAt = this.recentlyClosed.get(requestId);
        if (!expiresAt)
            return false;
        if (expiresAt <= Date.now()) {
            this.recentlyClosed.delete(requestId);
            return false;
        }
        return true;
    }
    isCurrent(active) {
        return !active.cancelled && this.active.get(active.requestId) === active;
    }
    release(active) {
        if (active.cancelled)
            return;
        active.cancelled = true;
        if (active.retry)
            clearTimeout(active.retry);
        active.retry = null;
        if (active.lease)
            clearTimeout(active.lease);
        active.lease = null;
        this.active.delete(active.requestId);
        this.rememberClosed(active.requestId);
        const handle = active.handle;
        active.handle = null;
        if (handle)
            void handle.close().catch(() => { });
    }
    releaseAll() {
        for (const active of [...this.active.values()])
            this.release(active);
    }
    error(sender, requestId, status, code, message) {
        if (!sender.send({ type: "file_error", requestId, status, code, message })) {
            sender.disconnect("project file error backpressure limit exceeded");
        }
    }
}
export class SandboxFileReadChannel extends ProjectFileReadChannel {
    constructor(options) {
        super({ ...options, capability: SANDBOX_FILE_READ_CAPABILITY });
    }
}
