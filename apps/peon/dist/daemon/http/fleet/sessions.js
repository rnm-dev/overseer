import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ATTACHMENTS_MAX_COUNT, ATTACHMENTS_MAX_FILE_BYTES } from "../../uploads.js";
import { listAgentDrivers } from "../../agents/index.js";
import { narrowNewSessionAgent, narrowModel, narrowReasoningEffort } from "../../modelCatalog.js";
import { toPublicSessionRecord } from "../../sessions/index.js";
import { toSessionSummary } from "../../sessionSummary.js";
import { parseSessionPageRequest, SessionPaginationError } from "../../sessionPagination.js";
import { fail } from "./error.js";
// Extracted fleet session JSON routes:
// - GET /sessions (including pagination)
// - GET /sessions/:id
// - PATCH /sessions/:id
// - DELETE /sessions/:id
// - POST /sessions
// - POST /sessions/:id/followup
// - POST /sessions/:id/queue
// - GET /sessions/:id/queue
// - PATCH /sessions/:id/queue/:itemId
// - POST /sessions/:id/queue/:itemId/send
// - DELETE /sessions/:id/queue/:itemId
// - POST /sessions/:id/cancel
//
// Excluded here on purpose: transcript and stream routes, session file/preview
// routes (/sessions/:id/files, /sessions/:id/file, /sessions/:id/file/raw,
// /sessions/:id/file/stream, /sessions/:id/preview), stats/analytics, and
// auth/protocol middleware.
export const INCLUDED_FLEET_SESSION_ROUTES = [
    "GET /sessions",
    "GET /sessions/:id",
    "PATCH /sessions/:id",
    "DELETE /sessions/:id",
    "POST /sessions",
    "POST /sessions/:id/followup",
    "POST /sessions/:id/queue",
    "GET /sessions/:id/queue",
    "PATCH /sessions/:id/queue/:itemId",
    "POST /sessions/:id/queue/:itemId/send",
    "DELETE /sessions/:id/queue/:itemId",
    "POST /sessions/:id/cancel",
];
const IMAGE_MIME_BY_EXT = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
};
const IMAGE_EXT_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function narrowPermissionMode(value) {
    return value === "plan" ? "plan" : undefined;
}
function attachmentAbsPath(root, relPath) {
    const abs = resolveInRoot(root, relPath.split("/").filter(Boolean));
    if (!abs)
        throw new AttachmentError(400, "PATH_ESCAPE", `attachment path escapes the file transfer root: ${relPath}`);
    return abs;
}
function resolveInRoot(root, segments) {
    const rootAbs = path.resolve(root);
    const abs = path.resolve(rootAbs, segments.join("/"));
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep))
        return null;
    return abs;
}
class AttachmentError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
function resolveAttachments(raw, fileTransferRoot) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw))
        throw new AttachmentError(400, "BAD_REQUEST", "attachments must be an array");
    if (raw.length === 0)
        return [];
    if (!fileTransferRoot)
        throw new AttachmentError(503, "FILES_DISABLED", "file transfer is disabled — set fileTransferRoot to attach files");
    if (raw.length > ATTACHMENTS_MAX_COUNT) {
        throw new AttachmentError(413, "ATTACHMENT_TOO_LARGE", `too many attachments (max ${ATTACHMENTS_MAX_COUNT} per message)`);
    }
    return raw.map((a, i) => resolveOneAttachment(a, fileTransferRoot, i));
}
function resolveOneAttachment(a, root, i) {
    if (!a || typeof a !== "object")
        throw new AttachmentError(400, "BAD_REQUEST", `attachment[${i}] must be an object`);
    const att = a;
    const type = att.type;
    if (type !== "file" && type !== "image") {
        throw new AttachmentError(400, "BAD_REQUEST", `attachment[${i}].type must be "file" or "image"`);
    }
    if (type === "image" && typeof att.dataBase64 === "string" && att.dataBase64) {
        const mediaType = typeof att.mediaType === "string" ? att.mediaType : "";
        const ext = IMAGE_EXT_BY_MIME[mediaType];
        if (!ext) {
            throw new AttachmentError(415, "UNSUPPORTED_MEDIA_TYPE", `attachment[${i}] unsupported image mediaType (png/jpeg/gif/webp only)`);
        }
        const buf = Buffer.from(att.dataBase64, "base64");
        if (buf.length === 0)
            throw new AttachmentError(400, "BAD_REQUEST", `attachment[${i}] dataBase64 decoded to empty`);
        if (buf.length > ATTACHMENTS_MAX_FILE_BYTES) {
            throw new AttachmentError(413, "ATTACHMENT_TOO_LARGE", `attachment[${i}] exceeds ${ATTACHMENTS_MAX_FILE_BYTES / (1024 * 1024)}MB`);
        }
        const dir = path.join(path.resolve(root), ".peon-inline");
        mkdirSync(dir, { recursive: true });
        const abs = path.join(dir, `${randomUUID()}.${ext}`);
        writeFileSync(abs, buf);
        return { originalName: `pasted-image.${ext}`, filename: path.basename(abs), path: abs, size: buf.length, mimetype: mediaType };
    }
    const rel = typeof att.path === "string" ? att.path.trim() : "";
    if (!rel) {
        throw new AttachmentError(400, "BAD_REQUEST", `attachment[${i}] requires a path (or dataBase64 for an inline image)`);
    }
    const abs = attachmentAbsPath(root, rel);
    let stat;
    try {
        stat = statSync(abs);
    }
    catch {
        throw new AttachmentError(404, "UNKNOWN_ATTACHMENT_PATH", `attachment[${i}] not found: ${rel}`);
    }
    if (stat.isDirectory())
        throw new AttachmentError(400, "BAD_REQUEST", `attachment[${i}] is a directory: ${rel}`);
    if (stat.size > ATTACHMENTS_MAX_FILE_BYTES) {
        throw new AttachmentError(413, "ATTACHMENT_TOO_LARGE", `attachment[${i}] exceeds ${ATTACHMENTS_MAX_FILE_BYTES / (1024 * 1024)}MB`);
    }
    const ext = path.extname(abs).slice(1).toLowerCase();
    if (type === "image" && !IMAGE_MIME_BY_EXT[ext]) {
        throw new AttachmentError(415, "UNSUPPORTED_MEDIA_TYPE", `attachment[${i}] is not a supported image (png/jpeg/gif/webp): ${rel}`);
    }
    const mimetype = IMAGE_MIME_BY_EXT[ext] ?? "application/octet-stream";
    return { originalName: rel, filename: path.basename(abs), path: abs, size: stat.size, mimetype };
}
export function attachSessionRoutes(router, options) {
    const { sessions, getFileTransferRoot, defaultAgent } = options;
    router.get("/sessions", (req, res) => {
        try {
            const pagination = parseSessionPageRequest(req.query.limit, req.query.cursor);
            if (!pagination)
                return res.json({ sessions: sessions.list().map(toSessionSummary) });
            const page = sessions.page(pagination);
            res.json({ ...page, sessions: page.sessions.map(toSessionSummary) });
        }
        catch (error) {
            if (error instanceof SessionPaginationError)
                return fail(res, 400, error.code, error.message);
            throw error;
        }
    });
    router.get("/sessions/:id", (req, res) => {
        const record = sessions.get(req.params.id);
        if (!record)
            return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
        res.json(toPublicSessionRecord(record));
    });
    router.patch("/sessions/:id", (req, res) => {
        const title = req.body?.title;
        if (title !== null && typeof title !== "string") {
            return fail(res, 400, "BAD_REQUEST", "title must be a string or null");
        }
        const record = sessions.rename(req.params.id, title);
        if (!record)
            return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
        res.json(toPublicSessionRecord(record));
    });
    router.post("/sessions", (req, res) => {
        const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
        if (!prompt)
            return fail(res, 400, "BAD_REQUEST", "prompt is required");
        const dir = typeof req.body?.dir === "string" && req.body.dir.trim() ? req.body.dir.trim() : undefined;
        const projectKey = typeof req.body?.projectKey === "string" && req.body.projectKey.trim()
            ? req.body.projectKey.trim()
            : undefined;
        const permissionMode = narrowPermissionMode(req.body?.permissionMode);
        const agent = narrowNewSessionAgent(req.body?.agent);
        const selectedAgent = agent ?? defaultAgent;
        const model = narrowModel(req.body?.model, selectedAgent);
        const reasoningEffort = narrowReasoningEffort(req.body?.reasoningEffort, selectedAgent, model);
        const commandId = typeof req.body?.commandId === "string" && req.body.commandId.trim() ? req.body.commandId.trim() : undefined;
        if (req.body?.agent !== undefined && !agent) {
            return fail(res, 400, "BAD_REQUEST", `agent must be one of: ${listAgentDrivers({ visible: true, available: true }).map((driver) => driver.id).join(", ")}`);
        }
        const headerId = req.headers["peon-request-id"];
        const bodyId = req.body?.id;
        const id = [typeof headerId === "string" ? headerId : "", typeof bodyId === "string" ? bodyId : ""].find((v) => UUID_RE.test(v));
        if (id) {
            const existing = sessions.get(id);
            if (existing)
                return res.status(200).json(existing);
        }
        let attachments;
        try {
            attachments = resolveAttachments(req.body?.attachments, getFileTransferRoot());
        }
        catch (err) {
            if (err instanceof AttachmentError)
                return fail(res, err.status, err.code, err.message);
            throw err;
        }
        try {
            const record = sessions.start({
                prompt,
                dir,
                projectKey,
                permissionMode,
                model,
                reasoningEffort,
                agent,
                id: id || undefined,
                author: req.actor ?? undefined,
                commandId,
                attachments,
                expectsOutcome: req.body?.expectsOutcome === true,
            });
            res.status(201).json(toPublicSessionRecord(record));
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.startsWith("dir does not exist"))
                return fail(res, 400, "DIR_MISSING", message);
            fail(res, 500, "INTERNAL", message);
        }
    });
    router.post("/sessions/:id/followup", (req, res) => {
        const record = sessions.get(req.params.id);
        if (!record)
            return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
        const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
        if (!prompt)
            return fail(res, 400, "BAD_REQUEST", "prompt is required");
        const permissionMode = narrowPermissionMode(req.body?.permissionMode);
        const model = narrowModel(req.body?.model, record.agent);
        const reasoningEffort = narrowReasoningEffort(req.body?.reasoningEffort, record.agent, model ?? record.model);
        const commandId = typeof req.body?.commandId === "string" && req.body.commandId.trim() ? req.body.commandId.trim() : undefined;
        let attachments;
        try {
            attachments = resolveAttachments(req.body?.attachments, getFileTransferRoot());
        }
        catch (err) {
            if (err instanceof AttachmentError)
                return fail(res, err.status, err.code, err.message);
            throw err;
        }
        try {
            const updated = sessions.resume(req.params.id, prompt, attachments, permissionMode, req.actor ?? undefined, model, reasoningEffort, commandId);
            res.status(201).json(toPublicSessionRecord(updated));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message === "a resume is already in progress")
                return fail(res, 409, "RESUME_IN_PROGRESS", message);
            if (message === "unknown session")
                return fail(res, 404, "UNKNOWN_SESSION", message);
            fail(res, 500, "INTERNAL", message);
        }
    });
    router.post("/sessions/:id/queue", (req, res) => {
        const record = sessions.get(req.params.id);
        if (!record)
            return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
        const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
        if (!prompt)
            return fail(res, 400, "BAD_REQUEST", "prompt is required");
        const permissionMode = narrowPermissionMode(req.body?.permissionMode);
        const model = narrowModel(req.body?.model, record.agent);
        const reasoningEffort = narrowReasoningEffort(req.body?.reasoningEffort, record.agent, model ?? record.model);
        const commandId = typeof req.body?.commandId === "string" && req.body.commandId.trim() ? req.body.commandId.trim() : undefined;
        let attachments;
        try {
            attachments = resolveAttachments(req.body?.attachments, getFileTransferRoot());
        }
        catch (error) {
            if (error instanceof AttachmentError)
                return fail(res, error.status, error.code, error.message);
            throw error;
        }
        const updated = sessions.enqueue(record.id, prompt, attachments, permissionMode, req.actor ?? undefined, model, reasoningEffort, commandId, req.body?.startNow === true);
        res.status(201).json(toPublicSessionRecord(updated));
    });
    router.get("/sessions/:id/queue", (req, res) => {
        const queue = sessions.queued(req.params.id);
        if (!queue)
            return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
        res.json({ items: queue });
    });
    router.patch("/sessions/:id/queue/:itemId", (req, res) => {
        const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
        if (!prompt)
            return fail(res, 400, "BAD_REQUEST", "prompt is required");
        const result = sessions.editQueued(req.params.id, req.params.itemId, prompt);
        if (result === "unknown_session")
            return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
        if (result === "not_found")
            return fail(res, 404, "UNKNOWN_QUEUE_ITEM", "unknown queue item");
        res.json(result);
    });
    router.post("/sessions/:id/queue/:itemId/send", (req, res) => {
        const result = sessions.sendQueuedNow(req.params.id, req.params.itemId);
        if (result === "unknown_session")
            return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
        if (result === "not_found")
            return fail(res, 404, "UNKNOWN_QUEUE_ITEM", "unknown queue item");
        res.json({ ok: true });
    });
    router.delete("/sessions/:id/queue/:itemId", (req, res) => {
        const result = sessions.removeQueued(req.params.id, req.params.itemId);
        if (result === "unknown_session")
            return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
        if (result === "not_found")
            return fail(res, 404, "UNKNOWN_QUEUE_ITEM", "unknown queue item");
        res.json({ ok: true });
    });
    router.post("/sessions/:id/cancel", (req, res) => {
        if (!sessions.cancel(req.params.id)) {
            return fail(res, 409, "SESSION_NOT_RUNNING", "session is not the active running session");
        }
        res.json({ ok: true });
    });
    router.delete("/sessions/:id", (req, res) => {
        const result = sessions.delete(req.params.id);
        if (result === "not_found")
            return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
        if (result === "running")
            return fail(res, 409, "SESSION_NOT_RUNNING", "session is running — cancel it before deleting");
        res.json({ ok: true });
    });
}
