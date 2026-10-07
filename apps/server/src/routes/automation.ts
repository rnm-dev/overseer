import { randomUUID } from "node:crypto";
import express from "express";
import { callPeon, connOfRecord, proxyFileUpload } from "../infrastructure/peonHttp/index.js";
import {
  automationMayUseProject,
  resolveAutomationRequest,
  type AutomationContext,
} from "../modules/automation/index.js";
import {
  getIndexedSession,
  indexAcceptedSession,
  listSessions,
  recordSessionRequest,
  runIdempotentFollowup,
  validCommandId,
} from "../modules/sessions/index.js";
import { getIndexedProject, getIndexedProjectById } from "../modules/projects/index.js";
import { agentAuthBlocked, transcriptQuery } from "./peons/sessions.js";
import { bearer, relay } from "./requestContext.js";
import { automationOpenApiDocument } from "./automationOpenApi.js";
import { config } from "../infrastructure/config/index.js";

// The automation front door. It is a second entrance onto the operator control
// plane, not a second control plane: every write below ends in the same Fleet
// HTTP call, with the same validation, idempotency and actor attribution the
// browser gets. What differs is only who may knock.
//
// Nothing here reads a cookie, so these writes need no CSRF origin check — and
// nothing here can be reached by a browser that merely carries a logged-in
// Overseer session.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      automation?: AutomationContext;
    }
  }
}

const MAX_SEARCH_LENGTH = 200;
const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

const automationAuth: express.RequestHandler = (req, res, next) => {
  void (async () => {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: "automation token required", code: "UNAUTHENTICATED" });
    const resolved = await resolveAutomationRequest(token);
    if ("code" in resolved) return res.status(resolved.status).json({ error: resolved.message, code: resolved.code });
    req.automation = resolved;
    next();
  })().catch(next);
};

const contextOf = (req: express.Request): AutomationContext => req.automation!;

function positiveInt(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return fallback;
  return Math.min(Math.max(1, Number(raw)), max);
}

function idempotencyKey(req: express.Request): string | null {
  const header = req.headers["idempotency-key"] ?? req.headers["peon-request-id"];
  return typeof header === "string" && validCommandId(header) ? header : null;
}

function sessionView(row: {
  sessionId: string;
  status: string | null;
  title: string | null;
  projectKey: string | null;
  projectId: string | null;
  author: string | null;
  promptPreview: string | null;
  preview: string | null;
  outcome: unknown;
  terminalReason: unknown;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
}) {
  return {
    sessionId: row.sessionId,
    status: row.status,
    // A poller should not have to learn the status vocabulary to ask the one
    // question it actually has.
    running: row.status === "running",
    title: row.title,
    projectKey: row.projectKey,
    projectId: row.projectId,
    author: row.author,
    promptPreview: row.promptPreview,
    preview: row.preview,
    outcome: row.outcome ?? null,
    terminalReason: row.terminalReason ?? null,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    lastActivityAt: row.lastActivityAt,
  };
}

// A session the token may not reach is refused exactly as one that does not
// exist. The scope of a token must not become an oracle for what runs on a
// Peon beside it.
const unknownSession = (res: express.Response) => res.status(404).json({ error: "unknown session", code: "UNKNOWN_SESSION" });

async function authorizeSession(c: AutomationContext, sessionId: string, res: express.Response): Promise<boolean> {
  const indexed = await getIndexedSession(c.record.peonId, sessionId);
  let projectKey = indexed?.projectKey ?? null;
  let projectId = indexed?.projectId ?? null;
  if (!indexed) {
    const lookup = await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(sessionId)}`, { actor: c.operator.email });
    if (!lookup.ok || !lookup.json || typeof lookup.json !== "object") {
      unknownSession(res);
      return false;
    }
    const body = lookup.json as { projectKey?: unknown; projectId?: unknown };
    projectKey = typeof body.projectKey === "string" ? body.projectKey : null;
    projectId = typeof body.projectId === "string" ? body.projectId : null;
  }
  if (!(await automationMayUseProject(c, projectKey, projectId))) {
    unknownSession(res);
    return false;
  }
  return true;
}

export function automationRouter(): express.Router {
  const router = express.Router();

  // The schema describes the shape of the surface and nothing about any
  // particular Peon, so it is readable without a token — a client generator
  // should not need a credential to know what it is generating.
  router.get("/openapi.json", (_req, res) => {
    res.json(automationOpenApiDocument(config.publicUrl));
  });

  router.use(automationAuth);

  // What this token is, so a script can fail loudly at startup instead of
  // silently writing into the wrong project.
  router.get("/whoami", (req, res) => {
    const c = contextOf(req);
    res.json({
      tokenId: c.token.id,
      label: c.token.label,
      workspaceId: c.workspaceId,
      peonId: c.record.peonId,
      peonName: c.record.name ?? null,
      projectKey: c.projectKey,
      projectId: c.projectId,
      owner: c.operator.email,
      expiresAt: c.token.expiresAt,
    });
  });

  // Listing answers from Overseer's durable projection, not from a live call to
  // the Peon: a listing stays fast, and it still works while the Peon is
  // briefly offline.
  router.get("/sessions", (req, res) => {
    void (async () => {
      const c = contextOf(req);
      const rawSearch = typeof req.query.q === "string" ? req.query.q.trim().slice(0, MAX_SEARCH_LENGTH) : "";
      const limit = positiveInt(req.query.limit, DEFAULT_PAGE, MAX_PAGE);
      const offset = typeof req.query.offset === "string" && /^\d+$/.test(req.query.offset) ? Number(req.query.offset) : 0;
      const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
      const { sessions, total } = await listSessions({
        workspaceId: c.workspaceId,
        peonId: c.record.peonId,
        ...(c.projectId ? { projectId: c.projectId } : c.projectKey ? { projectKey: c.projectKey } : {}),
        ...(status ? { status } : {}),
        ...(rawSearch ? { q: rawSearch } : {}),
        // A project-scoped token has already had that one project authorized
        // above, and the project filter is what narrows the rows. The per-row
        // access join is only needed for a Peon-scoped token, whose reach
        // still follows its owner's individual project grants.
        ...(c.role === "owner" || c.projectId || c.projectKey ? {} : { access: { userId: c.userId } }),
        limit,
        offset,
      });
      res.json({ sessions: sessions.map(sessionView), total, limit, offset });
    })().catch((error) => res.status(500).json({ error: error instanceof Error ? error.message : "listing failed", code: "INTERNAL" }));
  });

  router.post("/sessions", (req, res) => {
    void (async () => {
      const c = contextOf(req);
      const requestId = idempotencyKey(req);
      if (!requestId) {
        return res.status(400).json({
          error: "Idempotency-Key is required and must be a non-empty key of at most 255 characters",
          code: "BAD_REQUEST",
        });
      }
      const body = { ...(req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {}) } as Record<string, unknown>;
      // A project-scoped token names its project itself. Letting a caller
      // override it would make the scope advisory.
      if (c.projectKey) body.projectKey = c.projectKey;
      const projectKey = typeof body.projectKey === "string" && body.projectKey ? body.projectKey : null;
      if (projectKey) {
        const indexed = await getIndexedProject(c.record.peonId, projectKey);
        if (!(await automationMayUseProject(c, projectKey, indexed?.projectId ?? null))) {
          return res.status(403).json({ error: "project access required", code: "FORBIDDEN" });
        }
      } else if (c.projectId) {
        return res.status(400).json({ error: "this token is scoped to a project that no longer resolves", code: "BAD_REQUEST" });
      }
      const blocked = await agentAuthBlocked(c.record, body.agent, body.model);
      if (blocked) {
        return res.status(409).json({
          error: blocked === "unauthenticated" ? "this peon's Claude CLI is not signed in — sessions would fail" : "this peon's Claude CLI is broken — sessions would fail",
          code: "AGENT_UNAVAILABLE",
          authState: blocked,
        });
      }
      const result = await callPeon(connOfRecord(c.record), "POST", "/sessions", {
        actor: c.operator.email,
        body,
        requestId,
      });
      const accepted = result.ok && result.json && typeof result.json === "object" ? (result.json as { id?: unknown }) : null;
      const sessionId = accepted && typeof accepted.id === "string" ? accepted.id : null;
      if (sessionId) {
        await recordSessionRequest({
          workspaceId: c.workspaceId,
          userId: c.userId,
          peonId: c.record.peonId,
          sessionId,
          occurrenceKey: `create:${requestId}`,
        }).catch(() => undefined);
      }
      await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
      if (!result.ok) return relay(result, res);
      res.status(result.status).json({ ...(result.json as Record<string, unknown>), sessionId });
    })().catch((error) => res.status(500).json({ error: error instanceof Error ? error.message : "start failed", code: "INTERNAL" }));
  });

  // Reading a session is a reconcile point, exactly as it is for the browser:
  // it republishes the Peon's authoritative record, so a row left "running" by
  // a Peon that died mid-turn heals instead of lying to a poller forever.
  router.get("/sessions/:sid", (req, res) => {
    void (async () => {
      const c = contextOf(req);
      const sid = String(req.params.sid);
      if (!(await authorizeSession(c, sid, res))) return;
      const result = await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(sid)}`, { actor: c.operator.email });
      await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
      if (!result.ok || !result.json || typeof result.json !== "object") return relay(result, res);
      const body = result.json as Record<string, unknown>;
      const projectId = typeof body.projectId === "string" ? body.projectId : null;
      const projectKey = typeof body.projectKey === "string" ? body.projectKey : null;
      const project = projectId
        ? await getIndexedProjectById(c.record.peonId, projectId)
        : projectKey ? await getIndexedProject(c.record.peonId, projectKey) : null;
      res.status(result.status).json({
        ...body,
        sessionId: typeof body.id === "string" ? body.id : sid,
        running: body.status === "running",
        projectId: projectId ?? project?.projectId ?? null,
        projectRoot: project?.dir ?? null,
      });
    })().catch((error) => res.status(500).json({ error: error instanceof Error ? error.message : "read failed", code: "INTERNAL" }));
  });

  router.post("/sessions/:sid/followup", (req, res) => {
    void (async () => {
      const c = contextOf(req);
      const sid = String(req.params.sid);
      const commandId = idempotencyKey(req);
      if (!commandId) {
        return res.status(400).json({
          error: "Idempotency-Key is required and must be a non-empty key of at most 255 characters",
          code: "BAD_REQUEST",
        });
      }
      if (!(await authorizeSession(c, sid, res))) return;
      const body = req.body;
      const result = await runIdempotentFollowup(c.record.peonId, sid, commandId, body, () =>
        callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(sid)}/followup`, {
          actor: c.operator.email, body, requestId: commandId,
        }),
      );
      if (result.ok) {
        await recordSessionRequest({
          workspaceId: c.workspaceId,
          userId: c.userId,
          peonId: c.record.peonId,
          sessionId: sid,
          occurrenceKey: `followup:${commandId}`,
        }).catch(() => undefined);
      }
      await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
      relay(result, res);
    })().catch((error) => res.status(500).json({ error: error instanceof Error ? error.message : "followup failed", code: "INTERNAL" }));
  });

  router.get("/sessions/:sid/transcript", (req, res) => {
    void (async () => {
      const c = contextOf(req);
      const sid = String(req.params.sid);
      if (!(await authorizeSession(c, sid, res))) return;
      const suffix = transcriptQuery(req.query, c.record.capabilities.includes("transcript-pagination-v1"));
      relay(
        await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(sid)}/transcript${suffix}`, { actor: c.operator.email }),
        res,
      );
    })().catch((error) => res.status(500).json({ error: error instanceof Error ? error.message : "transcript failed", code: "INTERNAL" }));
  });

  // Bytes first, then a message that references the committed path. Inline
  // base64 is deliberately absent: a large image belongs in a streamed upload,
  // not in a JSON field under the 1 MB body ceiling.
  router.post("/uploads", (req, res) => {
    void (async () => {
      const c = contextOf(req);
      const rawName = typeof req.query.name === "string" ? req.query.name : "";
      const name = rawName.replace(/[^\w.-]+/g, "_").slice(0, 200);
      if (!name || name === "." || name === "..") {
        return res.status(400).json({ error: "name query parameter is required", code: "BAD_REQUEST" });
      }
      const rawFolder = typeof req.query.folder === "string" ? req.query.folder.replace(/[^\w.-]+/g, "_") : "";
      const folder = rawFolder || randomUUID();
      return proxyFileUpload(connOfRecord(c.record), ["uploads", folder, name], req, res, c.operator.email);
    })().catch((error) => {
      if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : "upload failed", code: "INTERNAL" });
    });
  });

  return router;
}
