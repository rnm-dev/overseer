import express from "express";
import { ErrorCode, fail } from "./error.js";
import { type ProjectService, ProjectServiceError, ProjectDocsError, ProjectTasksError } from "../../projects/index.js";

interface FleetProjectListRecord {
  projectId: string | null;
  key: string;
  name?: string;
  dir?: string;
  quickLinks?: unknown[];
  syncedAt?: number;
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
  // The Peon-level task switch (settings.tasksEnabled). Off: every task route
  // refuses with 409 TASKS_DISABLED, so no client can read or write task files.
  tasksEnabled?: () => boolean;
}

function failProjectService(res: express.Response, error: unknown): void {
  if (error instanceof ProjectServiceError) {
    fail(res, error.status, error.kind as ErrorCode, error.message);
    return;
  }
  if (error instanceof ProjectDocsError || error instanceof ProjectTasksError) {
    fail(res, error.status, error.code, error.message);
    return;
  }
  fail(res, 500, "INTERNAL", "project request failed");
}

function projectListRows(projectService: ProjectService, sessionProjectReader: SessionProjectReader): FleetProjectListRecord[] {
  const rows = new Map<string, FleetProjectListRecord>();
  for (const record of projectService.list()) {
    const row: FleetProjectListRecord = {
      projectId: record.projectId,
      key: record.key,
      name: record.label,
      dir: record.dir,
      quickLinks: record.quickLinks,
      syncedAt: record.lastSyncedAt,
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
    // A session keeps the project identity it was recorded with, so sessions
    // outlive the project they ran in. Their counts belong to a catalog row
    // only while that project is still registered — otherwise deleting a
    // project would resurrect it here forever, as a nameless duplicate of
    // whatever replaced it. Sessions with no projectId predate stable IDs and
    // still earn a legacy row: the ACL path upstream is keyed by their key.
    if (session.projectId && !rows.has(session.projectId)) continue;
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
  const tasksEnabled = options.tasksEnabled ?? (() => true);
  const digest = (req: express.Request): string => {
    const value = req.headers["peon-project-digest"];
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
      throw new ProjectServiceError(409, "PROJECT_CONFLICT", "a canonical project digest is required");
    }
    return value;
  };

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

  router.get("/projects/by-id/:projectId", (req, res) => {
    try {
      res.json(projectService.detailById(req.params.projectId));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.get("/projects/by-id/:projectId/docs", (req, res) => {
    try {
      res.json(projectService.documentationById(req.params.projectId));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.get("/projects/by-id/:projectId/docs/{*rest}", (req, res) => {
    const docPath = ((req.params.rest as unknown as string[] | undefined) ?? []).join("/");
    try {
      res.json(projectService.documentById(req.params.projectId, docPath));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.use("/projects/by-id/:projectId/tasks", (_req, res, next) => {
    if (tasksEnabled()) return next();
    fail(res, 409, "TASKS_DISABLED", "project tasks are switched off on this Peon");
  });

  router.get("/projects/by-id/:projectId/tasks", (req, res) => {
    try {
      res.json(projectService.tasksById(req.params.projectId));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.post("/projects/by-id/:projectId/tasks/setup", (req, res) => {
    try {
      res.status(201).json(projectService.enableTasksById(req.params.projectId));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.post("/projects/by-id/:projectId/tasks", (req, res) => {
    try {
      res.status(201).json({ task: projectService.createTaskById(req.params.projectId, req.body) });
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.patch("/projects/by-id/:projectId/tasks/:taskId", (req, res) => {
    try {
      res.json({ task: projectService.updateTaskById(req.params.projectId, req.params.taskId, req.body) });
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.post("/projects/by-id/:projectId/tasks/:taskId/move", (req, res) => {
    try {
      res.json({ task: projectService.moveTaskById(req.params.projectId, req.params.taskId, req.body) });
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.delete("/projects/by-id/:projectId/tasks/config", (req, res) => {
    try {
      res.json(projectService.disableTasksById(req.params.projectId));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.get("/projects/by-id/:projectId/skills", (req, res) => {
    try {
      res.json(projectService.skillsById(req.params.projectId));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.get("/projects/by-id/:projectId/quick-links", (req, res) => {
    try {
      res.json(projectService.listQuickLinksById(req.params.projectId));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.post("/projects/by-id/:projectId/quick-links", (req, res) => {
    try {
      res.status(201).json(projectService.createQuickLinkById(req.params.projectId, req.body, digest(req)));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.patch("/projects/by-id/:projectId/quick-links/:id", (req, res) => {
    try {
      res.json(projectService.updateQuickLinkById(req.params.projectId, req.params.id, req.body, digest(req)));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.delete("/projects/by-id/:projectId/quick-links/:id", (req, res) => {
    try {
      res.json(projectService.removeQuickLinkById(req.params.projectId, req.params.id, digest(req)));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.get("/projects/by-id/:projectId/settings", (req, res) => {
    try {
      res.json(projectService.settingsById(req.params.projectId));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.patch("/projects/by-id/:projectId/settings", (req, res) => {
    try {
      res.json(projectService.updateSettingsById(req.params.projectId, req.body, digest(req)));
    } catch (error) {
      failProjectService(res, error);
    }
  });

  router.delete("/projects/by-id/:projectId", (req, res) => {
    try {
      res.json(projectService.removeById(req.params.projectId, digest(req)));
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
