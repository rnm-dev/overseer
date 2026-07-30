import { createHash, randomUUID } from "node:crypto";
import { projectStore } from "../../../projects/index.js";
import { settings } from "../../../settings/index.js";
import { ATTACHMENT_UPLOAD_MAX_BYTES, AtomicFileUpload, deleteProjectFile, FileWriteError, PROJECT_UPLOAD_MAX_BYTES, fileWriteFsError, moveProjectFile, projectFileWriteTarget, sandboxFileWriteTarget, } from "../../../files/index.js";
export const FILE_WRITE_CAPABILITY = "file-write-v1";
export const FILE_WRITE_BINARY_HEADER_BYTES = 22;
export const FILE_WRITE_MAX_CHUNK_BYTES = 64 * 1024 - FILE_WRITE_BINARY_HEADER_BYTES;
export const FILE_WRITE_MAX_ACTIVE = 16;
const PROTOCOL_VERSION = 1;
const WRITE_CHUNK_TYPE = 2;
const DEFAULT_IDLE_LEASE_MS = 60_000;
const COMPLETED_TTL_MS = 5 * 60_000;
const MAX_COMPLETED_REQUESTS = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const FRAME_TYPES = new Set(["write_open", "write_end", "write_cancel"]);
function field(frame, name, max) {
    const value = frame[name];
    return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}
function actor(frame) {
    const value = frame.actor;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new FileWriteError(400, "INVALID_ACTOR", "trusted actor is required");
    }
    const candidate = value;
    if (typeof candidate.userId !== "string" || !candidate.userId || candidate.userId.length > 512
        || typeof candidate.email !== "string" || !candidate.email || candidate.email.length > 512
        || candidate.userId.includes("\0") || candidate.email.includes("\0")) {
        throw new FileWriteError(400, "INVALID_ACTOR", "trusted actor is invalid");
    }
    return { userId: candidate.userId, email: candidate.email };
}
function contentLength(frame, maxBytes) {
    if (frame.contentLength === undefined)
        return undefined;
    if (!Number.isSafeInteger(frame.contentLength) || Number(frame.contentLength) < 0) {
        throw new FileWriteError(400, "INVALID_LENGTH", "content length must be a non-negative safe integer");
    }
    const bytes = Number(frame.contentLength);
    if (bytes > maxBytes)
        throw new FileWriteError(413, "FILE_TOO_LARGE", `file exceeds ${maxBytes / (1024 * 1024)}MB limit`);
    return bytes;
}
function claimedSha256(frame) {
    if (frame.sha256 === undefined)
        return null;
    if (typeof frame.sha256 !== "string" || !SHA256.test(frame.sha256)) {
        throw new FileWriteError(400, "INVALID_CHECKSUM", "sha256 must be a lowercase hexadecimal digest");
    }
    return frame.sha256;
}
function requestFingerprint(frame) {
    return createHash("sha256").update(JSON.stringify({
        transferId: frame.transferId,
        commandId: frame.commandId,
        operation: frame.operation,
        scope: frame.scope,
        projectId: frame.projectId,
        relativePath: frame.relativePath,
        path: frame.path,
        destination: frame.destination,
        contentLength: frame.contentLength,
        sha256: frame.sha256,
        actor: frame.actor,
    })).digest("hex");
}
function decodeRequestId(raw) {
    const hex = raw.subarray(2, 18).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class FileWriteChannel {
    capability = FILE_WRITE_CAPABILITY;
    projects;
    sandboxRoot;
    maxActive;
    idleLeaseMs;
    openAtomicUpload;
    moveAtomicFile;
    deleteAtomicFile;
    accepted = false;
    currentSender = null;
    socketGeneration = 0;
    active = new Map();
    admitted = new Map();
    work = new Set();
    completed = new Map();
    constructor(options = {}) {
        this.projects = options.projects ?? projectStore;
        this.sandboxRoot = options.sandboxRoot ?? (() => settings.get().fileTransferRoot);
        this.maxActive = options.maxActive ?? FILE_WRITE_MAX_ACTIVE;
        this.idleLeaseMs = options.idleLeaseMs ?? DEFAULT_IDLE_LEASE_MS;
        this.openAtomicUpload = options.openUpload ?? AtomicFileUpload.open;
        this.moveAtomicFile = options.moveFile ?? moveProjectFile;
        this.deleteAtomicFile = options.deleteFile ?? deleteProjectFile;
    }
    helloState() {
        return {};
    }
    started(_sender) { }
    connecting() { }
    negotiated(accepted, _acknowledgement, sender) {
        if (this.currentSender !== null)
            this.releaseAll();
        this.socketGeneration += 1;
        this.accepted = accepted;
        this.currentSender = accepted ? sender : null;
        if (!accepted)
            this.releaseAll();
    }
    disconnected(_resetAuthority) {
        this.socketGeneration += 1;
        this.accepted = false;
        this.currentSender = null;
        this.releaseAll();
    }
    handles(frame) {
        if (typeof frame.type !== "string" || !FRAME_TYPES.has(frame.type))
            return false;
        if (frame.type === "write_open")
            return true;
        const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
        return this.active.has(requestId) || this.admitted.has(requestId) || this.completed.has(requestId);
    }
    handlesBinary(frame) {
        const raw = Buffer.from(frame);
        if (raw.length < FILE_WRITE_BINARY_HEADER_BYTES || raw[0] !== PROTOCOL_VERSION || raw[1] !== WRITE_CHUNK_TYPE)
            return false;
        return this.active.has(decodeRequestId(raw));
    }
    receiveBinary(frame, sender) {
        if (!this.accepted)
            return sender.disconnect("unnegotiated file write binary frame");
        const raw = Buffer.from(frame);
        if (raw.length <= FILE_WRITE_BINARY_HEADER_BYTES
            || raw.length - FILE_WRITE_BINARY_HEADER_BYTES > FILE_WRITE_MAX_CHUNK_BYTES
            || raw[0] !== PROTOCOL_VERSION
            || raw[1] !== WRITE_CHUNK_TYPE) {
            return sender.disconnect("invalid file write binary frame");
        }
        const requestId = decodeRequestId(raw);
        const active = this.active.get(requestId);
        if (!active || active.sender !== sender || active.ending || active.closed) {
            return sender.disconnect("invalid file write request");
        }
        const sequence = raw.readUInt32BE(18);
        const chunk = raw.subarray(FILE_WRITE_BINARY_HEADER_BYTES);
        if (sequence !== active.nextSequence
            || chunk.length > active.credit
            || active.expectedBytes !== undefined && active.receivedBytes + chunk.length > active.expectedBytes) {
            return sender.disconnect("invalid file write chunk sequence or credit");
        }
        active.nextSequence += 1;
        active.credit -= chunk.length;
        active.receivedBytes += chunk.length;
        this.refreshLease(active);
        active.writing = active.writing.then(async () => {
            if (active.closed)
                return;
            await active.upload.write(chunk);
            if (active.closed || active.ending)
                return;
            active.credit += chunk.length;
            if (!sender.send({ type: "write_credit", requestId, bytes: chunk.length })) {
                sender.disconnect("file write credit backpressure limit exceeded");
            }
        }).catch((error) => this.failActive(active, fileWriteFsError(error)));
    }
    receive(frame, sender) {
        if (!this.accepted)
            return sender.disconnect("unnegotiated file write frame");
        const requestId = field(frame, "requestId", 36);
        if (!requestId || !UUID.test(requestId))
            return sender.disconnect("invalid file write request id");
        if (frame.type === "write_cancel") {
            const active = this.active.get(requestId);
            if (active && active.sender === sender)
                this.release(active);
            const admission = this.admitted.get(requestId);
            if (admission?.sender === sender)
                this.cancelAdmission(requestId, admission);
            return;
        }
        if (frame.type === "write_end") {
            const active = this.active.get(requestId);
            if (!active || active.sender !== sender || active.ending || active.closed) {
                return sender.disconnect("invalid file write completion");
            }
            active.ending = true;
            this.refreshLease(active);
            void active.writing.then(() => this.complete(active)).catch((error) => this.failActive(active, fileWriteFsError(error)));
            return;
        }
        if (frame.protocol !== PROTOCOL_VERSION) {
            return this.sendError(sender, requestId, new FileWriteError(400, "BAD_PROTOCOL", "unsupported file write protocol version"));
        }
        const transferId = field(frame, "transferId", 36);
        const commandId = field(frame, "commandId", 36);
        if (transferId !== requestId || !commandId || !UUID.test(commandId)) {
            return this.sendError(sender, requestId, new FileWriteError(400, "BAD_CORRELATION", "file write transfer and command correlation is invalid"));
        }
        const fingerprint = requestFingerprint(frame);
        this.pruneCompleted();
        const replay = this.completed.get(requestId);
        if (replay) {
            if (replay.fingerprint !== fingerprint) {
                return this.sendError(sender, requestId, new FileWriteError(409, "REQUEST_ID_REUSE", "request ID was reused with different input"));
            }
            if (!sender.send(replay.frame))
                sender.disconnect("file write replay backpressure limit exceeded");
            return;
        }
        const duplicate = this.active.get(requestId);
        if (duplicate) {
            if (duplicate.fingerprint !== fingerprint) {
                return this.sendError(sender, requestId, new FileWriteError(409, "REQUEST_ID_REUSE", "request ID was reused with different input"));
            }
            return this.sendError(sender, requestId, new FileWriteError(409, "DUPLICATE_REQUEST", "file write is already active"));
        }
        const admitted = this.admitted.get(requestId);
        if (admitted) {
            const code = admitted.fingerprint === fingerprint ? "DUPLICATE_REQUEST" : "REQUEST_ID_REUSE";
            const message = admitted.fingerprint === fingerprint ? "file write is already active" : "request ID was reused with different input";
            return this.sendError(sender, requestId, new FileWriteError(409, code, message));
        }
        if (this.work.size >= this.maxActive) {
            return this.sendError(sender, requestId, new FileWriteError(429, "TRANSFER_BUSY", "too many active file writes"));
        }
        try {
            actor(frame);
            if (frame.operation !== "upload" && frame.operation !== "move" && frame.operation !== "delete") {
                throw new FileWriteError(400, "BAD_REQUEST", "unsupported file write operation");
            }
            const admission = this.admit(requestId, fingerprint, frame.operation, sender);
            if (frame.operation === "move" || frame.operation === "delete") {
                void this.mutate(frame, requestId, admission);
                return;
            }
            void this.openUpload(frame, requestId, admission);
        }
        catch (error) {
            this.sendError(sender, requestId, fileWriteFsError(error));
        }
    }
    async openUpload(frame, requestId, admission) {
        const { fingerprint, sender } = admission;
        try {
            let maxBytes;
            let target;
            if (frame.scope === "project") {
                const projectId = field(frame, "projectId", 512);
                const relativePath = field(frame, "relativePath", 4096);
                if (!projectId || projectId.includes("\0"))
                    throw new FileWriteError(400, "INVALID_PROJECT_ID", "a valid project ID is required");
                if (!relativePath)
                    throw new FileWriteError(400, "INVALID_PATH", "a project-relative path is required");
                const project = this.projects.list().find((candidate) => candidate.projectId === projectId);
                if (!project)
                    throw new FileWriteError(404, "UNKNOWN_PROJECT", "unknown project");
                target = projectFileWriteTarget(project, relativePath);
                maxBytes = PROJECT_UPLOAD_MAX_BYTES;
            }
            else if (frame.scope === "sandbox") {
                const relativePath = field(frame, "path", 4096);
                if (!relativePath)
                    throw new FileWriteError(400, "INVALID_PATH", "a sandbox-relative path is required");
                target = sandboxFileWriteTarget(this.sandboxRoot(), relativePath);
                maxBytes = relativePath.startsWith("uploads/") ? ATTACHMENT_UPLOAD_MAX_BYTES : PROJECT_UPLOAD_MAX_BYTES;
            }
            else {
                throw new FileWriteError(400, "BAD_REQUEST", "file write scope must be project or sandbox");
            }
            const expectedBytes = contentLength(frame, maxBytes);
            const upload = await this.openAtomicUpload(target, maxBytes, claimedSha256(frame));
            if (!this.isAdmissionCurrent(requestId, admission)) {
                this.finishAdmission(requestId, admission);
                await upload.cancel();
                return;
            }
            const active = {
                requestId,
                incarnation: admission.incarnation,
                fingerprint,
                sender,
                upload,
                expectedBytes,
                nextSequence: 0,
                credit: FILE_WRITE_MAX_CHUNK_BYTES,
                receivedBytes: 0,
                writing: Promise.resolve(),
                ending: false,
                closed: false,
                lease: null,
            };
            this.finishAdmission(requestId, admission);
            this.active.set(requestId, active);
            active.lease = this.createLease(active);
            if (!sender.send({ type: "write_ready", requestId, maxBytes, credit: FILE_WRITE_MAX_CHUNK_BYTES })) {
                sender.disconnect("file write readiness backpressure limit exceeded");
                this.release(active);
            }
        }
        catch (error) {
            if (this.isAdmissionCurrent(requestId, admission)) {
                this.finishAdmission(requestId, admission);
                this.sendError(sender, requestId, fileWriteFsError(error));
            }
        }
        finally {
            if (this.active.get(requestId)?.incarnation !== admission.incarnation) {
                this.finishWork(admission.incarnation);
            }
        }
    }
    async mutate(frame, requestId, admission) {
        const { fingerprint, sender } = admission;
        let terminal;
        try {
            if (frame.scope !== "project")
                throw new FileWriteError(400, "BAD_REQUEST", "file mutation is project-scoped");
            const projectId = field(frame, "projectId", 512);
            const source = field(frame, "relativePath", 4096);
            if (!projectId || projectId.includes("\0"))
                throw new FileWriteError(400, "INVALID_PROJECT_ID", "a valid project ID is required");
            if (!source)
                throw new FileWriteError(400, "INVALID_PATH", "a project-relative path is required");
            const project = this.projects.list().find((candidate) => candidate.projectId === projectId);
            if (!project)
                throw new FileWriteError(404, "UNKNOWN_PROJECT", "unknown project");
            const result = frame.operation === "delete"
                ? await this.deleteAtomicFile(project, source)
                : await this.moveAtomicFile(project, source, field(frame, "destination", 4096)
                    ?? (() => { throw new FileWriteError(400, "INVALID_PATH", "destination path is required"); })());
            terminal = { type: "write_result", requestId, status: 200, ...result };
        }
        catch (error) {
            terminal = this.terminalErrorFrame(requestId, fileWriteFsError(error));
        }
        try {
            const publish = this.isAdmissionCurrent(requestId, admission);
            this.remember(requestId, fingerprint, terminal);
            this.finishAdmission(requestId, admission);
            if (publish) {
                try {
                    if (!sender.send(terminal))
                        sender.disconnect("file move result backpressure limit exceeded");
                }
                catch {
                    sender.disconnect("file move result publication failed");
                }
            }
        }
        finally {
            this.finishWork(admission.incarnation);
        }
    }
    async complete(active) {
        if (!this.isCurrent(active))
            return;
        try {
            const result = await active.upload.complete(active.expectedBytes);
            if (!this.isCurrent(active))
                return;
            this.closeActive(active);
            this.finishWork(active.incarnation);
            const frame = { type: "write_result", requestId: active.requestId, status: 201, ...result };
            this.remember(active.requestId, active.fingerprint, frame);
            if (!active.sender.send(frame))
                active.sender.disconnect("file write result backpressure limit exceeded");
        }
        catch (error) {
            this.failActive(active, fileWriteFsError(error));
        }
    }
    failActive(active, error) {
        if (!this.isCurrent(active))
            return;
        this.closeActive(active);
        void active.upload.cancel().finally(() => this.finishWork(active.incarnation));
        this.sendTerminalError(active.sender, active.requestId, active.fingerprint, error);
    }
    sendTerminalError(sender, requestId, fingerprint, error) {
        const frame = this.terminalErrorFrame(requestId, error);
        this.remember(requestId, fingerprint, frame);
        if (!sender.send(frame))
            sender.disconnect("file write error backpressure limit exceeded");
    }
    terminalErrorFrame(requestId, error) {
        return { type: "write_error", requestId, status: error.status, code: error.code, message: error.message };
    }
    sendError(sender, requestId, error) {
        if (!sender.send({ type: "write_error", requestId, status: error.status, code: error.code, message: error.message })) {
            sender.disconnect("file write refusal backpressure limit exceeded");
        }
    }
    isCurrent(active) {
        return !active.closed && this.active.get(active.requestId) === active;
    }
    closeActive(active) {
        if (active.closed)
            return;
        active.closed = true;
        if (active.lease)
            clearTimeout(active.lease);
        active.lease = null;
        this.active.delete(active.requestId);
    }
    release(active) {
        if (!this.isCurrent(active))
            return;
        this.closeActive(active);
        void active.writing.finally(() => active.upload.cancel()).finally(() => this.finishWork(active.incarnation));
    }
    releaseAll() {
        for (const active of [...this.active.values()])
            this.release(active);
        for (const [requestId, admission] of [...this.admitted])
            this.cancelAdmission(requestId, admission);
    }
    admit(requestId, fingerprint, operation, sender) {
        const admission = {
            operation,
            fingerprint,
            incarnation: randomUUID(),
            sender,
            socketGeneration: this.socketGeneration,
            senderGeneration: sender.generation,
            cancelled: false,
            lease: setTimeout(() => {
                if (!this.isAdmissionCurrent(requestId, admission))
                    return;
                this.cancelAdmission(requestId, admission);
                this.sendError(sender, requestId, new FileWriteError(408, "TRANSFER_TIMEOUT", "file write admission timed out"));
            }, this.idleLeaseMs),
        };
        admission.lease?.unref();
        this.admitted.set(requestId, admission);
        this.work.add(admission.incarnation);
        return admission;
    }
    isAdmissionCurrent(requestId, admission) {
        return this.accepted
            && !admission.cancelled
            && this.currentSender === admission.sender
            && admission.socketGeneration === this.socketGeneration
            && admission.senderGeneration === admission.sender.generation
            && this.admitted.get(requestId)?.incarnation === admission.incarnation;
    }
    finishAdmission(requestId, admission) {
        if (this.admitted.get(requestId)?.incarnation !== admission.incarnation)
            return;
        if (admission.lease)
            clearTimeout(admission.lease);
        admission.lease = null;
        this.admitted.delete(requestId);
    }
    cancelAdmission(requestId, admission) {
        admission.cancelled = true;
        if (admission.lease)
            clearTimeout(admission.lease);
        admission.lease = null;
        // A move is a single non-cancellable native rename once dispatched. Keep
        // its request ownership even when nobody may receive the result anymore;
        // retries must observe the same pending effect until it settles.
        if (admission.operation === "upload")
            this.finishAdmission(requestId, admission);
    }
    finishWork(incarnation) {
        this.work.delete(incarnation);
    }
    createLease(active) {
        const timer = setTimeout(() => {
            if (!this.isCurrent(active))
                return;
            this.failActive(active, new FileWriteError(408, "TRANSFER_TIMEOUT", "file write timed out"));
        }, this.idleLeaseMs);
        timer.unref();
        return timer;
    }
    refreshLease(active) {
        if (active.lease)
            clearTimeout(active.lease);
        active.lease = this.createLease(active);
    }
    remember(requestId, fingerprint, frame) {
        this.pruneCompleted();
        this.completed.set(requestId, { fingerprint, frame, expiresAt: Date.now() + COMPLETED_TTL_MS });
        this.pruneCompleted();
    }
    pruneCompleted() {
        const now = Date.now();
        for (const [requestId, value] of this.completed) {
            if (value.expiresAt <= now || this.completed.size > MAX_COMPLETED_REQUESTS)
                this.completed.delete(requestId);
        }
    }
}
