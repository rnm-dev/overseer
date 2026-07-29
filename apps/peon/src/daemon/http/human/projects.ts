import express from "express";
import { ProjectDocsError, ProjectServiceError, type ProjectService } from "../../projects/index.js";

export interface HumanProjectsRouterOptions {
  projectService: ProjectService;
  resolveCreateActor?: (req: express.Request) => string | undefined;
}

function sendProjectError(res: express.Response, error: unknown, includeCode = true): void {
  if (error instanceof ProjectServiceError) {
    res.status(error.status).json({ error: error.message, ...(includeCode ? { code: error.kind } : {}) });
    return;
  }
  if (error instanceof ProjectDocsError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: "failed to read project documentation", code: "INTERNAL" });
}

export function createHumanProjectsRouter(options: HumanProjectsRouterOptions): express.Router {
  const router = express.Router();
  const projectService = options.projectService;
  const resolveCreateActor = options.resolveCreateActor ?? (() => undefined);

  router.get("/projects", (_req, res) => {
    res.json({ projects: projectService.list() });
  });

  router.get("/projects/:key", (req, res) => {
    try {
      res.json(projectService.detail(req.params.key));
    } catch (error) {
      sendProjectError(res, error, false);
    }
  });

  router.get("/projects/:key/docs", (req, res) => {
    try {
      res.json(projectService.documentation(req.params.key));
    } catch (error) {
      sendProjectError(res, error);
    }
  });

  router.get("/projects/:key/docs/{*rest}", (req, res) => {
    const docPath = ((req.params.rest as unknown as string[] | undefined) ?? []).join("/");
    try {
      res.json(projectService.document(req.params.key, docPath));
    } catch (error) {
      sendProjectError(res, error);
    }
  });

  router.get("/projects/:key/skills", (req, res) => {
    try {
      res.json(projectService.skills(req.params.key));
    } catch (error) {
      sendProjectError(res, error);
    }
  });

  router.get("/projects/:key/quick-links", (req, res) => {
    try {
      res.json(projectService.listQuickLinks(req.params.key));
    } catch (error) {
      sendProjectError(res, error);
    }
  });

  router.post("/projects/:key/quick-links", (req, res) => {
    try {
      res.status(201).json(projectService.createQuickLink(req.params.key, req.body));
    } catch (error) {
      sendProjectError(res, error);
    }
  });

  router.patch("/projects/:key/quick-links/:id", (req, res) => {
    try {
      res.json(projectService.updateQuickLink(req.params.key, req.params.id, req.body));
    } catch (error) {
      sendProjectError(res, error);
    }
  });

  router.delete("/projects/:key/quick-links/:id", (req, res) => {
    try {
      projectService.removeQuickLink(req.params.key, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      sendProjectError(res, error);
    }
  });

  router.get("/projects/:key/settings", (req, res) => {
    try {
      res.json(projectService.settings(req.params.key));
    } catch (error) {
      sendProjectError(res, error);
    }
  });

  router.patch("/projects/:key/settings", (req, res) => {
    try {
      res.json(projectService.updateSettings(req.params.key, req.body));
    } catch (error) {
      sendProjectError(res, error);
    }
  });

  router.post("/projects", (req, res) => {
    try {
      res.status(201).json(projectService.create(req.body, resolveCreateActor(req)));
    } catch (error) {
      sendProjectError(res, error, false);
    }
  });

  router.post("/projects/:key/archive", (req, res) => {
    try {
      res.json(projectService.archive(req.params.key));
    } catch (error) {
      sendProjectError(res, error, false);
    }
  });

  router.delete("/projects/:key/archive", (req, res) => {
    try {
      res.json(projectService.unarchive(req.params.key));
    } catch (error) {
      sendProjectError(res, error, false);
    }
  });

  router.delete("/projects/:key", (req, res) => {
    try {
      projectService.remove(req.params.key);
      res.json({ ok: true });
    } catch (error) {
      sendProjectError(res, error, false);
    }
  });

  return router;
}
