import express from "express";
import { registry } from "../modules/fleet/index.js";
import { canAccessPeon } from "../modules/access/index.js";
import {
  decideWorkspaceSignoff,
  getWorkspaceSignoff,
  listSessionSignoffs,
  listWorkspaceSignoffs,
  type Viewer,
} from "../modules/signoffs/index.js";
import { userOf, withWorkspace } from "./requestContext.js";

// Session sign-offs across the workspace (docs/signoffs.md). Peon owns the
// records; these routes decide visibility and the right to decide.
//
// - GET  /workspaces/:wsId/signoffs?scope=open|all
// - GET  /workspaces/:wsId/peons/:peonId/sessions/:sid/signoffs   (open ones, for the session banner)
// - GET  /workspaces/:wsId/peons/:peonId/signoffs/:signoffId
// - POST /workspaces/:wsId/peons/:peonId/signoffs/:signoffId/events
export function signoffsRouter(): express.Router {
  const router = express.Router();
  const viewerOf = (req: express.Request, c: { workspaceId: string; userId: string; role: Viewer["role"] }): Viewer => ({
    workspaceId: c.workspaceId,
    userId: c.userId,
    email: userOf(req).email,
    role: c.role,
  });

  router.get("/workspaces/:wsId/signoffs", withWorkspace(async (req, res, c) => {
    res.setHeader("Cache-Control", "no-store");
    const scope = req.query.scope === "all" ? "all" : "open";
    res.json(await listWorkspaceSignoffs(viewerOf(req, c), scope));
  }));

  const withPeon = (
    handler: (req: express.Request, res: express.Response, viewer: Viewer, record: NonNullable<Awaited<ReturnType<typeof registry.get>>>) => unknown,
  ) => withWorkspace(async (req, res, c) => {
    res.setHeader("Cache-Control", "no-store");
    const record = await registry.get(String(req.params.peonId));
    if (!record || record.workspaceId !== c.workspaceId || !(await canAccessPeon(c.workspaceId, c.userId, c.role, record.peonId))) {
      return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });
    }
    return handler(req, res, viewerOf(req, c), record);
  });

  router.get("/workspaces/:wsId/peons/:peonId/sessions/:sid/signoffs", withPeon(async (req, res, viewer, record) => {
    res.json({ signoffs: await listSessionSignoffs(viewer, record, String(req.params.sid)) });
  }));

  router.get("/workspaces/:wsId/peons/:peonId/signoffs/:signoffId", withPeon(async (req, res, viewer, record) => {
    const result = await getWorkspaceSignoff(viewer, record, String(req.params.signoffId));
    if (!result.ok) return res.status(result.status).json(result.body);
    res.json(result.view);
  }));

  router.post("/workspaces/:wsId/peons/:peonId/signoffs/:signoffId/events", withPeon(async (req, res, viewer, record) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = { kind: body.kind, baseSeq: body.baseSeq, optionId: body.optionId, message: body.message, requestId: body.requestId };
    const result = await decideWorkspaceSignoff(viewer, record, String(req.params.signoffId), input);
    res.status(result.status).json(result.body);
  }));
  return router;
}
