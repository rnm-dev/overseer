import express from "express";
import { ErrorCode, fail } from "./error.js";
import { type ProjectService, ProjectServiceError, ProjectDocsError } from "../../projects/index.js";

interface FleetProjectListRecord {
  projectId: string | null;
  key: string;
  path: string | null;
  archivedAt: number | null;
  sessionCount: number;
  activeCount: number;
  lastActivityMs: number | null;
}

export interface SessionProjectReader {
  list(): Array<{ status?: string; projectKey: string | null; projectId: string | null; lastActivityAt: number; dir?: string | null }>;
}

export interface AttachProjectRoutesOptions {
  projectService: ProjectService;
  sessionProjectReader: SessionProjectReader;
}

function failProjectService(res: express.Response, error: unknown): void {
  if (error instanceof ProjectServiceError) {
    const code: ErrorCode = error.kind === "PROJECT_RUNNING" ? "PROJECT_EXISTS" : error.kind;
    fail(res, error.status, code, error.message);
    return;
  }
  if (error instanceof ProjectDocsError) {
    fail(res, error.status, error.code, error.message);
    return;
  }
  fail(res, 500, "INTERNAL", "failed to read project documentation");
}

function projectListRows(projectService: ProjectService, sessionProjectReader: SessionProjectReader): FleetProjectListRecord[] {
  const rows = new Map<string, FleetProjectListRecord>();
  for (const record of projectService.list()) {
    const row: FleetProjectListRecord = {
      projectId: record.projectId,
      key: record.key,
      path: record.dir || null,
      archivedAt: record.archivedAt,
      sessionCount: 0,
      activeCount: 0,
      lastActivityMs: null,
    };
    rows.set(record.projectId, row);
  }

  for (const session of sessionProjectReader.list()) {
    if (!session.projectKey) continue;
    const identity = session.projectId ?? `legacy:${session.projectKey}`;
    let row = rows.get(identity);
    if (!row) {
      row = {
        projectId: session.projectId,
        key: session.projectKey,
        path: session.dir || null,
        archivedAt: null,
        sessionCount: 0,
        activeCount: 0,
        lastActivityMs: null,
      };
      rows.set(identity, row);
    }

    row.sessionCount += 1;
    if (session.status === "running") {
      row.activeCount += 1;
    }
    row.lastActivityMs = row.lastActivityMs === null
      ? session.lastActivityAt
      : Math.max(row.lastActivityMs, session.lastActivityAt);
  }

  return Array.from(rows.values());
}

export function attachProjectRoutes(router: express.Router, options: AttachProjectRoutesOptions): void {
  const { projectService, sessionProjectReader } = options;

  router.get("/projects", (_req, res) => {
    res.json({ projects: projectListRows(projectService, sessionProjectReader) });
  });

  router.get("/projects/suggest-dir", (req, res) => {
    try {
      res.json(projectService.suggest(req.query.label));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.post("/projects", (req, res) => {
    try {
      res.status(201).json(projectService.create(req.body, req.actor ?? undefined));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.get("/projects/:key", (req, res) => {
    try {
      res.json(projectService.detail(req.params.key));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.get("/projects/:key/docs", (req, res) => {
    try {
      res.json(projectService.documentation(req.params.key));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.get("/projects/:key/docs/{*rest}", (req, res) => {
    const docPath = ((req.params.rest as unknown as string[] | undefined) ?? []).join("/");
    try {
      res.json(projectService.document(req.params.key, docPath));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.get("/projects/:key/skills", (req, res) => {
    try {
      res.json(projectService.skills(req.params.key));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.get("/projects/:key/quick-links", (req, res) => {
    try {
      res.json(projectService.listQuickLinks(req.params.key));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.post("/projects/:key/quick-links", (req, res) => {
    try {
      res.status(201).json(projectService.createQuickLink(req.params.key, req.body));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.patch("/projects/:key/quick-links/:id", (req, res) => {
    try {
      res.json(projectService.updateQuickLink(req.params.key, req.params.id, req.body));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.delete("/projects/:key/quick-links/:id", (req, res) => {
    try {
      projectService.removeQuickLink(req.params.key, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.get("/projects/:key/settings", (req, res) => {
    try {
      res.json(projectService.settings(req.params.key));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.patch("/projects/:key/settings", (req, res) => {
    try {
      res.json(projectService.updateSettings(req.params.key, req.body));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.post("/projects/:key/archive", (req, res) => {
    try {
      res.json(projectService.archive(req.params.key));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.delete("/projects/:key/archive", (req, res) => {
    try {
      res.json(projectService.unarchive(req.params.key));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.delete("/projects/:key", (req, res) => {
    try {
      projectService.remove(req.params.key);
      res.json({ ok: true });
    } catch (error) {
      failProjectService(res, error);
    }
  });
}
