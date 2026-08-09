import express from "express";
import { canAccessPeon, canAccessProject } from "../modules/access/index.js";
import { connOfRecord, proxyGet } from "../infrastructure/peonHttp/index.js";
import { getIndexedProjectById } from "../modules/projects/index.js";
import { registry } from "../modules/fleet/index.js";
import { membership } from "../modules/workspaces/index.js";
import { userOf } from "./requestContext.js";

export function projectViewerRouter(): express.Router {
  const router = express.Router();

  router.get("/:peonId/:projectId/{*rest}", async (req, res) => {
    const peonId = String(req.params.peonId);
    const projectId = String(req.params.projectId);
    const record = await registry.get(peonId);
    if (!record) return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });

    const auth = userOf(req);
    const role = await membership(record.workspaceId, auth.userId);
    const project = await getIndexedProjectById(peonId, projectId);
    if (!role || !project
      || !(await canAccessPeon(record.workspaceId, auth.userId, role, peonId))
      || !(await canAccessProject(record.workspaceId, auth.userId, role, peonId, project.key, projectId))) {
      return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
    }

    const rest = ((req.params.rest as unknown as string[] | undefined) ?? []).map(encodeURIComponent).join("/");
    await proxyGet(
      connOfRecord(record),
      `/projects/${encodeURIComponent(project.key)}/files/${rest}`,
      req,
      res,
      auth.email,
    );
  });

  return router;
}
