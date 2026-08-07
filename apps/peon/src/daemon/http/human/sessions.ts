import express from "express";
import { createAttachmentUpload, describeUploadError, cleanupUploadedFiles, toAttachmentInfo } from "../../uploads.js";
import { parseSessionPageRequest, SessionPaginationError } from "../../sessionPagination.js";
import { parseReplyTo, ReplyToError, type ReplyTo, type SessionJsonService, type SessionRecord } from "../../sessions/index.js";
import type { CodingAgent, ReasoningEffort } from "../../modelCatalog.js";
import { type SessionSummary } from "../../sessionSummary.js";

export type HumanSessionService = SessionJsonService;

export interface HumanSessionResponseHelpers {
  toSessionSummary(record: SessionRecord): SessionSummary | Record<string, unknown>;
  toPublicSessionRecord(record: SessionRecord): Record<string, unknown>;
  toSessionView(record: SessionRecord, viewerUsername: string | null): Record<string, unknown>;
  resolveSessionAuthor(req: express.Request): string | undefined;
  resolveSessionViewer(req: express.Request): string | null;
  resolveDefaultAgent(): CodingAgent;
  listAgentsForNewSessionError(): string;
  narrowNewSessionAgent(value: unknown): CodingAgent | undefined;
  narrowModel(value: unknown, agent: CodingAgent): string | undefined;
  narrowReasoningEffort(value: unknown, agent: CodingAgent, model?: unknown): ReasoningEffort | undefined;
}

export interface HumanSessionRouterOptions {
  sessionService: HumanSessionService;
  helpers: HumanSessionResponseHelpers;
  resolveSessionId(): string;
}

declare global {
  namespace Express {
    interface Request {
      acaSessionId?: string;
    }
  }
}

function withUploadErrors(mw: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => mw(req, res, (err: unknown) => (err ? res.status(400).json({ error: describeUploadError(err) }) : next()));
}

function createUploadMiddleware(id: (req: express.Request) => string): express.RequestHandler {
  return withUploadErrors(createAttachmentUpload((req) => id(req)));
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatedReplyTo(service: HumanSessionService, id: string, value: unknown): ReplyTo | undefined {
  const replyTo = parseReplyTo(value);
  return replyTo ? service.validateReplyTo(id, replyTo) : undefined;
}

function requireKnownSession(service: HumanSessionService) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const id = String(req.params.id);
    if (!SESSION_ID_RE.test(id) || !service.get(id)) {
      return res.status(404).json({ error: "unknown session" });
    }
    next();
  };
}

export function createHumanSessionsRouter(options: HumanSessionRouterOptions): express.Router {
  const router = express.Router();
  const service = options.sessionService;
  const {
    resolveSessionAuthor,
    resolveSessionViewer,
    resolveDefaultAgent,
    listAgentsForNewSessionError,
    narrowNewSessionAgent,
    narrowModel,
    narrowReasoningEffort,
    toPublicSessionRecord,
    toSessionSummary,
    toSessionView,
  } = options.helpers;

  const assignSessionId = (req: express.Request, _res: express.Response, next: express.NextFunction): void => {
    req.acaSessionId = options.resolveSessionId();
    next();
  };

  const newSessionUpload = createUploadMiddleware((req) => req.acaSessionId!);
  const followupUpload = createUploadMiddleware((req) => String(req.params.id));

  router.post("/sessions", assignSessionId, newSessionUpload, (req, res) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const dir = typeof req.body?.dir === "string" && req.body.dir.trim() ? req.body.dir.trim() : undefined;
    const projectKey = typeof req.body?.projectKey === "string" && req.body.projectKey.trim() ? req.body.projectKey.trim() : undefined;
    const permissionMode = req.body?.permissionMode === "plan" ? "plan" : undefined;
    const agent = narrowNewSessionAgent(req.body?.agent);
    const selectedAgent = agent ?? resolveDefaultAgent();
    const model = narrowModel(req.body?.model, selectedAgent);
    const reasoningEffort = narrowReasoningEffort(req.body?.reasoningEffort, selectedAgent, model);
    const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
    const files = toAttachmentInfo(uploadedFiles);

    if (req.body?.agent !== undefined && !agent) {
      cleanupUploadedFiles(uploadedFiles);
      return res.status(400).json({ error: `agent must be one of: ${listAgentsForNewSessionError()}` });
    }

    if (!prompt) {
      cleanupUploadedFiles(uploadedFiles);
      return res.status(400).json({ error: "prompt is required" });
    }

    try {
      const record = service.start({
        prompt,
        dir,
        projectKey,
        permissionMode,
        model,
        reasoningEffort,
        agent,
        id: req.acaSessionId,
        attachments: files,
        author: resolveSessionAuthor(req),
        expectsOutcome: req.body?.expectsOutcome === true || req.body?.expectsOutcome === "true",
      });
      res.status(201).json(toPublicSessionRecord(record));
    } catch (error) {
      cleanupUploadedFiles(uploadedFiles);
      const message = error instanceof Error ? error.message : String(error);
      let status = 500;
      if (message.startsWith("a session is already running")) status = 409;
      else if (message.startsWith("dir does not exist")) status = 400;
      res.status(status).json({ error: message });
    }
  });

  router.get("/sessions", (req, res) => {
    const projectKey = typeof req.query.projectKey === "string" ? req.query.projectKey : undefined;
    try {
      const pagination = parseSessionPageRequest(req.query.limit, req.query.cursor);
      if (!pagination) {
        const list = projectKey ? service.list().filter((session) => session.projectKey === projectKey) : service.list();
        return res.json({ sessions: list.map(toSessionSummary) });
      }
      const page = service.page({ ...pagination, projectKey });
      res.json({ ...page, sessions: page.sessions.map(toSessionSummary) });
    } catch (error) {
      if (error instanceof SessionPaginationError) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  router.get("/sessions/:id", (req, res) => {
    const record = service.get(req.params.id);
    if (!record) return res.status(404).json({ error: "unknown session" });
    res.json(toSessionView(record, resolveSessionViewer(req)));
  });

  router.patch("/sessions/:id", (req, res) => {
    if (typeof req.body?.title !== "string") {
      return res.status(400).json({ error: "title (string) is required" });
    }
    const record = service.rename(req.params.id, req.body.title);
    if (!record) return res.status(404).json({ error: "unknown session" });
    res.json(toSessionView(record, resolveSessionViewer(req)));
  });

  router.delete("/sessions/:id", (req, res) => {
    const result = service.delete(req.params.id);
    if (result === "not_found") return res.status(404).json({ error: "unknown session" });
    if (result === "running") return res.status(409).json({ error: "session is running" });
    res.json({ ok: true });
  });

  router.post("/sessions/:id/followup", requireKnownSession(service), followupUpload, (req, res) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const permissionMode = req.body?.permissionMode === "plan" ? "plan" : undefined;
    const record = service.get(String(req.params.id));
    if (!record) {
      return res.status(404).json({ error: "unknown session" });
    }
    const model = narrowModel(req.body?.model, record.agent);
    const reasoningEffort = narrowReasoningEffort(req.body?.reasoningEffort, record.agent, model ?? record.model);
    let replyTo: ReplyTo | undefined;
    try {
      replyTo = validatedReplyTo(service, String(req.params.id), req.body?.replyTo);
    } catch (error) {
      if (error instanceof ReplyToError) return res.status(error.code === "REPLY_SOURCE_NOT_FOUND" ? 404 : 400).json({ error: error.message, code: error.code });
      throw error;
    }
    const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
    const files = toAttachmentInfo(uploadedFiles);

    if (!prompt) {
      cleanupUploadedFiles(uploadedFiles);
      return res.status(400).json({ error: "prompt is required" });
    }

    try {
      const updated = service.resume(
        String(req.params.id),
        prompt,
        files,
        permissionMode,
        resolveSessionAuthor(req),
        model,
        reasoningEffort,
        undefined,
        false,
        replyTo,
      );
      res.status(201).json(toPublicSessionRecord(updated));
    } catch (error) {
      cleanupUploadedFiles(uploadedFiles);
      const message = error instanceof Error ? error.message : String(error);
      let status = 500;
      if (message.startsWith("a session is already running")) status = 409;
      else if (message === "unknown session") status = 404;
      else if (message === "session is not completed") status = 409;
      else if (message === "a resume is already in progress") status = 409;
      res.status(status).json({ error: message });
    }
  });

  router.post("/sessions/:id/queue", requireKnownSession(service), followupUpload, (req, res) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const permissionMode = req.body?.permissionMode === "plan" ? "plan" : undefined;
    const record = service.get(String(req.params.id));
    if (!record) {
      return res.status(404).json({ error: "unknown session" });
    }
    const model = narrowModel(req.body?.model, record.agent);
    const reasoningEffort = narrowReasoningEffort(req.body?.reasoningEffort, record.agent, model ?? record.model);
    let replyTo: ReplyTo | undefined;
    try {
      replyTo = validatedReplyTo(service, record.id, req.body?.replyTo);
    } catch (error) {
      if (error instanceof ReplyToError) return res.status(error.code === "REPLY_SOURCE_NOT_FOUND" ? 404 : 400).json({ error: error.message, code: error.code });
      throw error;
    }
    const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
    const files = toAttachmentInfo(uploadedFiles);
    if (!prompt) {
      cleanupUploadedFiles(uploadedFiles);
      return res.status(400).json({ error: "prompt is required" });
    }
    try {
      const updated = service.enqueue(
        record.id,
        prompt,
        files,
        permissionMode,
        resolveSessionAuthor(req),
        model,
        reasoningEffort,
        undefined,
        req.body?.startNow === "true" || req.body?.startNow === true,
        replyTo,
      );
      res.status(201).json(toPublicSessionRecord(updated));
    } catch (error) {
      cleanupUploadedFiles(uploadedFiles);
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  router.get("/sessions/:id/queue", (req, res) => {
    const queue = service.queued(req.params.id);
    if (!queue) return res.status(404).json({ error: "unknown session" });
    res.json({ items: queue });
  });

  router.patch("/sessions/:id/queue/:itemId", (req, res) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) return res.status(400).json({ error: "prompt is required" });
    let replyTo: ReplyTo | null | undefined;
    try {
      replyTo = req.body && Object.prototype.hasOwnProperty.call(req.body, "replyTo")
        ? req.body.replyTo === null ? null : validatedReplyTo(service, req.params.id, req.body.replyTo)
        : undefined;
    } catch (error) {
      if (error instanceof ReplyToError) return res.status(error.code === "REPLY_SOURCE_NOT_FOUND" ? 404 : 400).json({ error: error.message, code: error.code });
      throw error;
    }
    const result = service.editQueued(req.params.id, req.params.itemId, prompt, replyTo);
    if (result === "unknown_session") return res.status(404).json({ error: "unknown session" });
    if (result === "not_found") return res.status(404).json({ error: "unknown queue item" });
    res.json(result);
  });

  router.post("/sessions/:id/queue/:itemId/steer", (req, res) => {
    const result = service.steerQueued(req.params.id, req.params.itemId);
    if (result === "unknown_session") return res.status(404).json({ error: "unknown session" });
    if (result === "not_found") return res.status(404).json({ error: "unknown queue item" });
    res.json({ ok: true });
  });

  router.post("/sessions/:id/queue/:itemId/send", (req, res) => {
    res.set("Deprecation", "true");
    res.set("Link", `</api/v1/sessions/${encodeURIComponent(req.params.id)}/queue/${encodeURIComponent(req.params.itemId)}/steer>; rel="successor-version"`);
    const result = service.sendQueuedNow(req.params.id, req.params.itemId);
    if (result === "unknown_session") return res.status(404).json({ error: "unknown session" });
    if (result === "not_found") return res.status(404).json({ error: "unknown queue item" });
    res.json({ ok: true });
  });

  router.delete("/sessions/:id/queue/:itemId", (req, res) => {
    const result = service.removeQueued(req.params.id, req.params.itemId);
    if (result === "unknown_session") return res.status(404).json({ error: "unknown session" });
    if (result === "not_found") return res.status(404).json({ error: "unknown queue item" });
    res.json({ ok: true });
  });

  router.post("/sessions/:id/cancel", (req, res) => {
    const cancelled = service.cancel(req.params.id);
    if (!cancelled) return res.status(409).json({ error: "session is not the active running session" });
    res.json({ ok: true });
  });

  return router;
}
