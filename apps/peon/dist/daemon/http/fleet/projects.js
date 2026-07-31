import { fail } from "./error.js";
import { ProjectServiceError, ProjectDocsError } from "../../projects/index.js";
function failProjectService(res, error) {
    if (error instanceof ProjectServiceError) {
        fail(res, error.status, error.kind, error.message);
        return;
    }
    if (error instanceof ProjectDocsError) {
        fail(res, error.status, error.code, error.message);
        return;
    }
    fail(res, 500, "INTERNAL", "failed to read project documentation");
}
function projectListRows(projectService, sessionProjectReader) {
    const rows = new Map();
    for (const record of projectService.list()) {
        const row = {
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
        if (!session.projectKey)
            continue;
        // A session keeps the project identity it was recorded with, so sessions
        // outlive the project they ran in. Their counts belong to a catalog row
        // only while that project is still registered — otherwise deleting a
        // project would resurrect it here forever, as a nameless duplicate of
        // whatever replaced it. Sessions with no projectId predate stable IDs and
        // still earn a legacy row: the ACL path upstream is keyed by their key.
        if (session.projectId && !rows.has(session.projectId))
            continue;
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
export function attachProjectRoutes(router, options) {
    const { projectService, sessionProjectReader } = options;
    const digest = (req) => {
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
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.post("/projects", (req, res) => {
        try {
            res.status(201).json(projectService.create(req.body, req.actor ?? undefined));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.get("/projects/:key", (req, res) => {
        try {
            res.json(projectService.detail(req.params.key));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.get("/projects/by-id/:projectId", (req, res) => {
        try {
            res.json(projectService.detailById(req.params.projectId));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.get("/projects/by-id/:projectId/docs", (req, res) => {
        try {
            res.json(projectService.documentationById(req.params.projectId));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.get("/projects/by-id/:projectId/docs/{*rest}", (req, res) => {
        const docPath = (req.params.rest ?? []).join("/");
        try {
            res.json(projectService.documentById(req.params.projectId, docPath));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.get("/projects/by-id/:projectId/skills", (req, res) => {
        try {
            res.json(projectService.skillsById(req.params.projectId));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.get("/projects/by-id/:projectId/quick-links", (req, res) => {
        try {
            res.json(projectService.listQuickLinksById(req.params.projectId));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.post("/projects/by-id/:projectId/quick-links", (req, res) => {
        try {
            res.status(201).json(projectService.createQuickLinkById(req.params.projectId, req.body, digest(req)));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.patch("/projects/by-id/:projectId/quick-links/:id", (req, res) => {
        try {
            res.json(projectService.updateQuickLinkById(req.params.projectId, req.params.id, req.body, digest(req)));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.delete("/projects/by-id/:projectId/quick-links/:id", (req, res) => {
        try {
            res.json(projectService.removeQuickLinkById(req.params.projectId, req.params.id, digest(req)));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.get("/projects/by-id/:projectId/settings", (req, res) => {
        try {
            res.json(projectService.settingsById(req.params.projectId));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.patch("/projects/by-id/:projectId/settings", (req, res) => {
        try {
            res.json(projectService.updateSettingsById(req.params.projectId, req.body, digest(req)));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.delete("/projects/by-id/:projectId", (req, res) => {
        try {
            res.json(projectService.removeById(req.params.projectId, digest(req)));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.get("/projects/:key/docs", (req, res) => {
        try {
            res.json(projectService.documentation(req.params.key));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.get("/projects/:key/docs/{*rest}", (req, res) => {
        const docPath = (req.params.rest ?? []).join("/");
        try {
            res.json(projectService.document(req.params.key, docPath));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.get("/projects/:key/skills", (req, res) => {
        try {
            res.json(projectService.skills(req.params.key));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.get("/projects/:key/quick-links", (req, res) => {
        try {
            res.json(projectService.listQuickLinks(req.params.key));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.post("/projects/:key/quick-links", (req, res) => {
        try {
            res.status(201).json(projectService.createQuickLink(req.params.key, req.body));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.patch("/projects/:key/quick-links/:id", (req, res) => {
        try {
            res.json(projectService.updateQuickLink(req.params.key, req.params.id, req.body));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.delete("/projects/:key/quick-links/:id", (req, res) => {
        try {
            projectService.removeQuickLink(req.params.key, req.params.id);
            res.json({ ok: true });
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.get("/projects/:key/settings", (req, res) => {
        try {
            res.json(projectService.settings(req.params.key));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.patch("/projects/:key/settings", (req, res) => {
        try {
            res.json(projectService.updateSettings(req.params.key, req.body));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.post("/projects/:key/archive", (req, res) => {
        try {
            res.json(projectService.archive(req.params.key));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.delete("/projects/:key/archive", (req, res) => {
        try {
            res.json(projectService.unarchive(req.params.key));
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
    router.delete("/projects/:key", (req, res) => {
        try {
            projectService.remove(req.params.key);
            res.json({ ok: true });
        }
        catch (error) {
            failProjectService(res, error);
        }
    });
}
