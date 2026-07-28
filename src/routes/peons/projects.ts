import express from "express";
import { registry, toView } from "../../registry.js";
import { callPeon, connOfRecord, normalizePeonUrl, proxyFileDownload, proxyFileUpload, proxyGet, proxyUpload } from "../../peonClient.js";
import { reconcilePeon } from "../../sessionIndex.js";
import { allowedProjects, canAccessProject, projectMemberCounts } from "../../access.js";
import { ownerOnly, relay, restSegments, withWorkspacePeon } from "../helpers.js";
import { browsePeonFolders, folderBrowseSelector, streamProjectFileResponse } from "../../modules/projects/index.js";
import { listProjectDocs } from "../../modules/projectDocs/index.js";
import { PeonOperationError } from "../../peonOperationChannel.js";
import {
  getIndexedProject,
  getProjectCatalogState,
  hasCanonicalProjectCatalog,
  listIndexedProjects,
  refreshIndexedProjectQuickLinks,
} from "../../projectIndex.js";

export function registerProjectRoutes(router: express.Router): void {
  const wp = "/workspaces/:wsId/peons/:id";
  // Peon detail page — registry view (no fan-out) + proxied projects/settings.
  router.get(wp, withWorkspacePeon(async (_req, res, c) => res.json(toView(c.record))));

  // Edit how the OVERSEER reaches this peon (address + control port). This is
  // overseer-local registry data, not a peon proxy — so it works while the peon is
  // offline/unreachable, which is exactly when you need to fix a bad address. A
  // successful edit warms the session index against the now-reachable peon.
  router.patch(
    wp,
    withWorkspacePeon(async (req, res, c) => {
      if (!ownerOnly(res, c.role)) return;
      const b = req.body ?? {};
      const raw = typeof b.publicUrl === "string" ? b.publicUrl : typeof b.address === "string" ? b.address : "";
      const publicUrl = normalizePeonUrl(raw);
      if (!publicUrl) return res.status(400).json({ error: "callback URL must start with http:// or https:// and contain no credentials, query, or fragment", code: "BAD_URL" });
      const updated = await registry.updateConnection(c.record.peonId, publicUrl);
      if (!updated) return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });
      void reconcilePeon(updated).catch(() => null);
      res.json(toView(updated));
    }),
  );
  // Projects — rollup list + CRUD and consolidated settings proxies. Route
  // order matters: the literal /projects/suggest-dir must precede the
  // /projects/:key param route.
  const proj = (key: string) => `/projects/${encodeURIComponent(key)}`;
  const refreshQuickLinks = async (c: Parameters<Parameters<typeof withWorkspacePeon>[0]>[2], key: string) => {
    const result = await callPeon(connOfRecord(c.record), "GET", `${proj(key)}/quick-links`, { actor: c.operator.email });
    if (!result.ok || !result.json || typeof result.json !== "object") return;
    const links = (result.json as { links?: unknown }).links;
    if (!Array.isArray(links)) return;
    try {
      await refreshIndexedProjectQuickLinks({
        workspaceId: c.workspaceId,
        peonId: c.record.peonId,
        key,
        quickLinks: links,
      });
    } catch (error) {
      console.warn("project quick-link cache refresh failed:", error instanceof Error ? error.message : String(error));
    }
  };
  const withWorkspaceProject = (handler: Parameters<typeof withWorkspacePeon>[0]) => withWorkspacePeon(async (req, res, c) => {
    const key = String(req.params.key);
    let projectId: string | null = null;
    if (await hasCanonicalProjectCatalog(c.record.peonId)) {
      const project = await getIndexedProject(c.record.peonId, key);
      if (!project) return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
      projectId = project.projectId;
    } else if (c.role !== "owner") {
      const detail = await callPeon(connOfRecord(c.record), "GET", proj(key), { actor: c.operator.email });
      if (!detail.ok) return relay(detail, res);
      projectId = detail.json && typeof detail.json === "object" && typeof (detail.json as { projectId?: unknown }).projectId === "string"
        ? (detail.json as { projectId: string }).projectId
        : null;
    }
    if (!(await canAccessProject(c.workspaceId, c.userId, c.role, c.record.peonId, key, projectId))) return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
    return handler(req, res, c);
  });
  router.get(`${wp}/projects`, withWorkspacePeon(async (_req, res, c) => {
    if (await hasCanonicalProjectCatalog(c.record.peonId)) {
      const all = await listIndexedProjects(c.record.peonId);
      // The branch above is intentionally local: canonical project reads remain
      // useful while Peon is offline and cannot race a mutable key lookup.
      const access = (await allowedProjects(c.workspaceId, c.userId, c.role, c.record.peonId)) ?? [];
      const allowedIds = new Set(access.flatMap((item) => item.projectId ? [item.projectId] : []));
      const filtered = c.role === "owner" ? all : all.filter((project) => allowedIds.has(project.projectId));
      const counts = await projectMemberCounts(c.workspaceId, c.record.peonId, filtered);
      const projects = filtered.map((project, index) => ({ ...project, memberCount: counts[index] ?? 0 }));
      return res.json({ projects, catalog: await getProjectCatalogState(c.record) });
    }
    const result = await callPeon(connOfRecord(c.record), "GET", "/projects", { actor: c.operator.email });
    if (!result.ok || !result.json || typeof result.json !== "object") return relay(result, res);
    const access = (await allowedProjects(c.workspaceId, c.userId, c.role, c.record.peonId)) ?? [];
    const allowedIds = new Set(access.flatMap((item) => item.projectId ? [item.projectId] : []));
    const legacyKeys = new Set(access.filter((item) => !item.projectId).map((item) => item.projectKey));
    const body = result.json as { projects?: unknown[] };
    const visible = Array.isArray(body.projects) ? body.projects.filter((project) => {
      if (!project || typeof project !== "object" || typeof (project as { key?: unknown }).key !== "string") return false;
      if (c.role === "owner") return true;
      const key = (project as { key: string }).key;
      const id = (project as { projectId?: unknown }).projectId;
      return typeof id === "string" ? allowedIds.has(id) : legacyKeys.has(key);
    }) : [];
    const typed = visible as Array<{ projectId?: string | null; key: string }>;
    const counts = await projectMemberCounts(c.workspaceId, c.record.peonId, typed);
    const projects = typed.map((project, index) => ({ ...project, memberCount: counts[index] ?? 0 }));
    res.status(result.status).json({ ...body, projects });
  }));
  router.get(`${wp}/projects/suggest-dir`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const label = typeof req.query.label === "string" ? req.query.label : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/projects/suggest-dir${label ? `?label=${encodeURIComponent(label)}` : ""}`, { actor: c.operator.email }), res);
  }));
  router.post(`${wp}/projects`, withWorkspacePeon(async (req, res, c) => { if (!ownerOnly(res, c.role)) return; relay(await callPeon(connOfRecord(c.record), "POST", "/projects", { actor: c.operator.email, body: req.body }), res); }));
  // Directory picker for new projects: folder data travels over the Peon's
  // `folder-listing-v1` reverse WebSocket, so an owner can browse from `/`
  // instead of being confined to the HTTP file-transfer root.
  router.get(`${wp}/folders`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    res.once("close", () => controller.abort());
    try {
      const selector = folderBrowseSelector(req.query.path, req.query.limit);
      res.json(await browsePeonFolders(c.record.peonId, selector, controller.signal));
    } catch (error) {
      if (controller.signal.aborted || res.headersSent || res.destroyed) return;
      const typed = error instanceof PeonOperationError
        ? error
        : new PeonOperationError("FOLDER_LIST_FAILED", "the folder could not be listed", 502);
      res.status(typed.status === 499 ? 502 : typed.status).json({ error: typed.message, code: typed.code });
    }
  }));
  router.get(`${wp}/projects/:projectId/docs`, withWorkspacePeon(async (req, res, c) => {
    const projectId = String(req.params.projectId);
    if (!(await canAccessProject(c.workspaceId, c.userId, c.role, c.record.peonId, "", projectId))) {
      return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
    }
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    res.once("close", () => controller.abort());
    try {
      res.json(await listProjectDocs(c.record.peonId, projectId, controller.signal));
    } catch (error) {
      if (controller.signal.aborted || res.headersSent || res.destroyed) return;
      const typed = error instanceof PeonOperationError
        ? error
        : new PeonOperationError("DOCS_LIST_FAILED", "project documentation could not be listed", 502);
      res.status(typed.status === 499 ? 502 : typed.status).json({ error: typed.message, code: typed.code });
    }
  }));
  router.get(`${wp}/projects/by-id/:projectId/files/{*rest}`, withWorkspacePeon(async (req, res, c) => {
    const projectId = String(req.params.projectId);
    if (!(await canAccessProject(c.workspaceId, c.userId, c.role, c.record.peonId, "", projectId))) {
      return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
    }
    await streamProjectFileResponse({
      req,
      res,
      peonId: c.record.peonId,
      projectId,
      relativePath: restSegments(req).join("/"),
      actor: { userId: c.userId, email: c.operator.email },
    });
  }));
  router.get(`${wp}/projects/:key`, withWorkspaceProject(async (req, res, c) => {
    if (await hasCanonicalProjectCatalog(c.record.peonId)) {
      const project = await getIndexedProject(c.record.peonId, String(req.params.key));
      if (!project) return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
      return res.json(project);
    }
    relay(await callPeon(connOfRecord(c.record), "GET", proj(String(req.params.key)), { actor: c.operator.email }), res);
  }));
  router.get(`${wp}/projects/:key/skills`, withWorkspaceProject(async (req, res, c) => {
    res.setHeader("Cache-Control", "no-store");
    relay(await callPeon(connOfRecord(c.record), "GET", `${proj(String(req.params.key))}/skills`, { actor: c.operator.email }), res);
  }));
  router.get(`${wp}/projects/:key/quick-links`, withWorkspaceProject(async (req, res, c) => {
    if (await hasCanonicalProjectCatalog(c.record.peonId)) {
      const project = await getIndexedProject(c.record.peonId, String(req.params.key));
      if (!project) return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
      return res.json({ links: project.quickLinks ?? [], cache: await getProjectCatalogState(c.record) });
    }
    relay(await callPeon(connOfRecord(c.record), "GET", `${proj(String(req.params.key))}/quick-links`, { actor: c.operator.email }), res);
  }));
  router.post(`${wp}/projects/:key/quick-links`, withWorkspaceProject(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const key = String(req.params.key);
    const result = await callPeon(connOfRecord(c.record), "POST", `${proj(key)}/quick-links`, { actor: c.operator.email, body: req.body });
    if (result.ok) await refreshQuickLinks(c, key);
    relay(result, res);
  }));
  router.patch(`${wp}/projects/:key/quick-links/:linkId`, withWorkspaceProject(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const key = String(req.params.key);
    const path = `${proj(key)}/quick-links/${encodeURIComponent(String(req.params.linkId))}`;
    const result = await callPeon(connOfRecord(c.record), "PATCH", path, { actor: c.operator.email, body: req.body });
    if (result.ok) await refreshQuickLinks(c, key);
    relay(result, res);
  }));
  router.delete(`${wp}/projects/:key/quick-links/:linkId`, withWorkspaceProject(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const key = String(req.params.key);
    const path = `${proj(key)}/quick-links/${encodeURIComponent(String(req.params.linkId))}`;
    const result = await callPeon(connOfRecord(c.record), "DELETE", path, { actor: c.operator.email });
    if (result.ok) await refreshQuickLinks(c, key);
    relay(result, res);
  }));
  router.get(`${wp}/projects/:key/settings`, withWorkspaceProject(async (req, res, c) => {
    if (await hasCanonicalProjectCatalog(c.record.peonId)) {
      const project = await getIndexedProject(c.record.peonId, String(req.params.key));
      if (!project) return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
      return res.json({ projectId: project.projectId, key: project.key, name: project.name ?? project.key, dir: project.dir ?? "", metadata: project.metadata, quickLinks: project.quickLinks ?? [] });
    }
    relay(await callPeon(connOfRecord(c.record), "GET", `${proj(String(req.params.key))}/settings`, { actor: c.operator.email }), res);
  }));
  router.patch(`${wp}/projects/:key/settings`, withWorkspaceProject(async (req, res, c) => { if (!ownerOnly(res, c.role)) return; relay(await callPeon(connOfRecord(c.record), "PATCH", `${proj(String(req.params.key))}/settings`, { actor: c.operator.email, body: req.body }), res); }));
  router.delete(`${wp}/projects/:key`, withWorkspaceProject(async (req, res, c) => { if (!ownerOnly(res, c.role)) return; relay(await callPeon(connOfRecord(c.record), "DELETE", proj(String(req.params.key)), { actor: c.operator.email }), res); }));
  router.get(`${wp}/settings`, withWorkspacePeon(async (_req, res, c) => { if (!ownerOnly(res, c.role)) return; relay(await callPeon(connOfRecord(c.record), "GET", "/settings", { actor: c.operator.email }), res); }));
  router.patch(`${wp}/settings`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const result = await callPeon(connOfRecord(c.record), "PATCH", "/settings", { actor: c.operator.email, body: req.body });
    if (result.ok && result.json && typeof result.json === "object") {
      const name = (result.json as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) await registry.updateName(c.record.peonId, name.trim());
    }
    relay(result, res);
  }));
  router.get(`${wp}/stats`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const period = typeof req.query.period === "string" ? req.query.period : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/stats${period ? `?period=${encodeURIComponent(period)}` : ""}`, { actor: c.operator.email }), res);
  }));
  // Keep provider quota probes on separate requests. Some provider CLIs can be
  // slow or unavailable, and neither should hold up the other provider (or the
  // recorded /stats response).
  router.get(`${wp}/quota/:provider`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const provider = String(req.params.provider);
    if (provider !== "claude-code" && provider !== "codex") {
      return res.status(404).json({ error: "unknown quota provider", code: "UNKNOWN_PROVIDER" });
    }
    const refresh = req.query.refresh === "1" ? "?refresh=1" : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/quota/${provider}${refresh}`, { actor: c.operator.email }), res);
  }));
  // Capability discovery is provider-scoped for the same reason as quota:
  // either CLI may be slow, so callers must be able to fetch them independently.
  router.get(`${wp}/capabilities/:provider`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const provider = String(req.params.provider);
    if (provider !== "claude-code" && provider !== "codex") {
      return res.status(404).json({ error: "unknown capabilities provider", code: "UNKNOWN_PROVIDER" });
    }
    const refresh = req.query.refresh === "1" ? "?refresh=1" : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/capabilities/${provider}${refresh}`, { actor: c.operator.email }), res);
  }));

  // Express's named wildcard does not match an empty path, so expose the root
  // listing explicitly for filesystem pickers before the nested transfer route.
  router.get(`${wp}/files`, withWorkspacePeon((req, res, c) => proxyFileDownload(connOfRecord(c.record), [], req, res, c.operator.email)));
  router.get(`${wp}/files/{*rest}`, withWorkspacePeon((req, res, c) => proxyFileDownload(connOfRecord(c.record), restSegments(req), req, res, c.operator.email)));
  router.put(`${wp}/files/{*rest}`, withWorkspacePeon((req, res, c) => proxyFileUpload(connOfRecord(c.record), restSegments(req), req, res, c.operator.email)));

  // Read-only project file browse — proxied to the peon's per-project files API
  // (sandboxed to the project dir). `?stat=1` ⇒ dir listing / metadata; else content.
  router.get(`${wp}/projects/:key/files/{*rest}`, withWorkspaceProject((req, res, c) => {
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    proxyGet(connOfRecord(c.record), `/projects/${encodeURIComponent(String(req.params.key))}/files/${rest}${qs}`, req, res, c.operator.email);
  }));
  router.put(`${wp}/projects/:key/files/{*rest}`, withWorkspaceProject((req, res, c) => {
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    proxyUpload(connOfRecord(c.record), `/projects/${encodeURIComponent(String(req.params.key))}/files/${rest}`, req, res, c.operator.email);
  }));
  router.patch(`${wp}/projects/:key/files/{*rest}`, withWorkspaceProject(async (req, res, c) => {
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    relay(await callPeon(connOfRecord(c.record), "PATCH", `/projects/${encodeURIComponent(String(req.params.key))}/files/${rest}`, { actor: c.operator.email, body: req.body }), res);
  }));
}
