import express from "express";
import { registry, toView } from "../../registry.js";
import { callPeon, connOfRecord, normalizePeonUrl, proxyFileDownload, proxyFileUpload, proxyGet, proxyUpload } from "../../peonClient.js";
import { reconcilePeon } from "../../sessionIndex.js";
import { allowedProjects, canAccessProject, projectMemberCounts } from "../../access.js";
import { ownerOnly, relay, restSegments, withWorkspacePeon } from "../helpers.js";
import {
  folderBrowseSelector,
  projectFileProxyQuery,
} from "../../modules/projects/index.js";
import { projectDocsFromSnapshot } from "../../modules/projectDocs/index.js";
import { appendEvent } from "../../eventLog.js";
import { auditSafeFileErrorBody } from "../../fileErrorSafety.js";
import { FileSandboxError, resolveAttachmentPath, resolveSandboxSegments } from "../../peonFileSandbox.js";
import {
  forgetIndexedProject,
  getIndexedProject,
  getIndexedProjectById,
  getProjectCatalogState,
  hasCanonicalProjectCatalog,
  refreshIndexedProjectQuickLinks,
} from "../../projectIndex.js";

export function registerProjectRoutes(router: express.Router): void {
  const wp = "/workspaces/:wsId/peons/:id";
  const forgetDeletedProject = async (
    c: Parameters<Parameters<typeof withWorkspacePeon>[0]>[2],
    key: string,
    projectId: string | null,
  ) => {
    try {
      await forgetIndexedProject({ workspaceId: c.workspaceId, peonId: c.record.peonId, key, projectId });
    } catch (error) {
      // The Peon has already committed the deletion. Its catalog event will
      // eventually perform the same eviction, so do not turn success into 5xx.
      console.warn("project cache eviction failed:", error instanceof Error ? error.message : String(error));
    }
  };
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
  const revisionedProject = async (
    c: Parameters<Parameters<typeof withWorkspacePeon>[0]>[2],
    key: string,
  ) => {
    const indexed = await getIndexedProject(c.record.peonId, key);
    if (!indexed) return null;
    const base = `/projects/by-id/${encodeURIComponent(indexed.projectId)}`;
    const current = await callPeon(connOfRecord(c.record), "GET", `${base}/settings`, { actor: c.operator.email });
    const digest = current.ok && current.json && typeof current.json === "object"
      ? (current.json as { digest?: unknown }).digest : null;
    return { indexed, base, current, digest: typeof digest === "string" ? digest : null };
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
        res.status(result.status).json({ ...body, projects, catalog: await getProjectCatalogState(c.record) });
  }));
  router.get(`${wp}/projects/suggest-dir`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const label = typeof req.query.label === "string" ? req.query.label : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/projects/suggest-dir${label ? `?label=${encodeURIComponent(label)}` : ""}`, { actor: c.operator.email }), res);
  }));
  router.post(`${wp}/projects`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    relay(await callPeon(connOfRecord(c.record), "POST", "/projects", { actor: c.operator.email, body: req.body, requestId: req.header("Peon-Request-Id") || undefined }), res);
  }));
  // Directory picker for new projects. Keep the public Overseer route stable,
  // but make the one authenticated Fleet HTTP request directly to the Peon's
  // host-filesystem listing endpoint over mesh.
  router.get(`${wp}/folders`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    try {
      const selector = folderBrowseSelector(req.query.path, req.query.limit);
      const segments = selector.path === "/"
        ? []
        : selector.path.replaceAll("\\", "/").split("/").filter(Boolean);
      const suffix = segments.length ? `/${segments.map(encodeURIComponent).join("/")}` : "";
      relay(await callPeon(
        connOfRecord(c.record),
        "GET",
        `/filesystem${suffix}?stat=1`,
        { actor: c.operator.email },
      ), res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "the folder could not be listed";
      res.status(400).json({ error: message, code: "BAD_REQUEST" });
    }
  }));
  router.get(`${wp}/projects/:projectId/docs`, withWorkspacePeon(async (req, res, c) => {
    const projectId = String(req.params.projectId);
    if (!(await canAccessProject(c.workspaceId, c.userId, c.role, c.record.peonId, "", projectId))) {
      return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
    }
    const result = await callPeon(connOfRecord(c.record), "GET", `/projects/by-id/${encodeURIComponent(projectId)}/docs`, { actor: c.operator.email });
    if (!result.ok || !result.json || typeof result.json !== "object") return relay(result, res);
    try {
      res.json(projectDocsFromSnapshot(result.json as Parameters<typeof projectDocsFromSnapshot>[0]));
    } catch {
      res.status(502).json({ error: "Peon returned unsafe project documentation", code: "UNSAFE_RESULT" });
    }
  }));
  router.get(`${wp}/projects/by-id/:projectId/files/{*rest}`, withWorkspacePeon(async (req, res, c) => {
    const projectId = String(req.params.projectId);
    if (!(await canAccessProject(c.workspaceId, c.userId, c.role, c.record.peonId, "", projectId))) {
      return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
    }
    const project = await getIndexedProjectById(c.record.peonId, projectId);
    if (!project) return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    proxyGet(
      connOfRecord(c.record),
      `/projects/${encodeURIComponent(project.key)}/files/${rest}`,
      req,
      res,
      c.operator.email,
    );
  }));
  router.get(`${wp}/projects/:key`, withWorkspaceProject(async (req, res, c) => {
    const indexed = await getIndexedProject(c.record.peonId, String(req.params.key));
    const path = indexed ? `/projects/by-id/${encodeURIComponent(indexed.projectId)}` : proj(String(req.params.key));
    relay(await callPeon(connOfRecord(c.record), "GET", path, { actor: c.operator.email }), res);
  }));
  router.get(`${wp}/projects/:key/skills`, withWorkspaceProject(async (req, res, c) => {
    res.setHeader("Cache-Control", "no-store");
    const indexed = await getIndexedProject(c.record.peonId, String(req.params.key));
    const path = indexed ? `/projects/by-id/${encodeURIComponent(indexed.projectId)}/skills` : `${proj(String(req.params.key))}/skills`;
    relay(await callPeon(connOfRecord(c.record), "GET", path, { actor: c.operator.email }), res);
  }));
  router.get(`${wp}/projects/:key/quick-links`, withWorkspaceProject(async (req, res, c) => {
    const project = await getIndexedProject(c.record.peonId, String(req.params.key));
    const path = project ? `/projects/by-id/${encodeURIComponent(project.projectId)}/quick-links` : `${proj(String(req.params.key))}/quick-links`;
    relay(await callPeon(connOfRecord(c.record), "GET", path, { actor: c.operator.email }), res);
  }));
  router.post(`${wp}/projects/:key/quick-links`, withWorkspaceProject(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const key = String(req.params.key);
    const revision = await revisionedProject(c, key);
    if (!revision?.digest) return relay(revision?.current ?? { status: 404, ok: false, json: { error: "unknown project", code: "UNKNOWN_PROJECT" } }, res);
    const result = await callPeon(connOfRecord(c.record), "POST", `${revision.base}/quick-links`, { actor: c.operator.email, body: req.body, headers: { "Peon-Project-Digest": revision.digest }, requestId: req.header("Peon-Request-Id") || undefined });
    if (result.ok) await refreshQuickLinks(c, key);
    relay(result, res);
  }));
  router.patch(`${wp}/projects/:key/quick-links/:linkId`, withWorkspaceProject(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const key = String(req.params.key);
    const revision = await revisionedProject(c, key);
    if (!revision?.digest) return relay(revision?.current ?? { status: 404, ok: false, json: { error: "unknown project", code: "UNKNOWN_PROJECT" } }, res);
    const path = `${revision.base}/quick-links/${encodeURIComponent(String(req.params.linkId))}`;
    const result = await callPeon(connOfRecord(c.record), "PATCH", path, { actor: c.operator.email, body: req.body, headers: { "Peon-Project-Digest": revision.digest }, requestId: req.header("Peon-Request-Id") || undefined });
    if (result.ok) await refreshQuickLinks(c, key);
    relay(result, res);
  }));
  router.delete(`${wp}/projects/:key/quick-links/:linkId`, withWorkspaceProject(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const key = String(req.params.key);
    const revision = await revisionedProject(c, key);
    if (!revision?.digest) return relay(revision?.current ?? { status: 404, ok: false, json: { error: "unknown project", code: "UNKNOWN_PROJECT" } }, res);
    const path = `${revision.base}/quick-links/${encodeURIComponent(String(req.params.linkId))}`;
    const result = await callPeon(connOfRecord(c.record), "DELETE", path, { actor: c.operator.email, headers: { "Peon-Project-Digest": revision.digest }, requestId: req.header("Peon-Request-Id") || undefined });
    if (result.ok) await refreshQuickLinks(c, key);
    relay(result, res);
  }));
  router.get(`${wp}/projects/:key/settings`, withWorkspaceProject(async (req, res, c) => {
    const indexed = await getIndexedProject(c.record.peonId, String(req.params.key));
    const path = indexed ? `/projects/by-id/${encodeURIComponent(indexed.projectId)}/settings` : `${proj(String(req.params.key))}/settings`;
    relay(await callPeon(connOfRecord(c.record), "GET", path, { actor: c.operator.email }), res);
  }));
  router.patch(`${wp}/projects/:key/settings`, withWorkspaceProject(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const key = String(req.params.key);
    const revision = await revisionedProject(c, key);
    if (!revision?.digest) return relay(revision?.current ?? { status: 404, ok: false, json: { error: "unknown project", code: "UNKNOWN_PROJECT" } }, res);
    relay(await callPeon(connOfRecord(c.record), "PATCH", `${revision.base}/settings`, { actor: c.operator.email, body: req.body, headers: { "Peon-Project-Digest": revision.digest }, requestId: req.header("Peon-Request-Id") || undefined }), res);
  }));
  router.delete(`${wp}/projects/:key`, withWorkspaceProject(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const key = String(req.params.key);
    const revision = await revisionedProject(c, key);
    if (!revision?.digest) return relay(revision?.current ?? { status: 404, ok: false, json: { error: "unknown project", code: "UNKNOWN_PROJECT" } }, res);
    const result = await callPeon(connOfRecord(c.record), "DELETE", revision.base, { actor: c.operator.email, headers: { "Peon-Project-Digest": revision.digest }, requestId: req.header("Peon-Request-Id") || undefined });
    if (result.ok) await forgetDeletedProject(c, key, revision.indexed.projectId);
    relay(result, res);
  }));
  router.get(`${wp}/settings`, withWorkspacePeon(async (_req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    relay(await callPeon(connOfRecord(c.record), "GET", "/settings", { actor: c.operator.email }), res);
  }));
  router.patch(`${wp}/settings`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const current = await callPeon(connOfRecord(c.record), "GET", "/settings", { actor: c.operator.email });
    if (!current.ok || !current.json || typeof current.json !== "object") return relay(current, res);
    const configuration = (current.json as { configuration?: unknown }).configuration;
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
      return res.status(502).json({ error: "Peon settings response has no revision fence", code: "INVALID_PEON_RESPONSE" });
    }
    const identity = configuration as { epoch?: unknown; revision?: unknown; digest?: unknown };
    if (typeof identity.epoch !== "string" || !Number.isSafeInteger(identity.revision)
      || typeof identity.digest !== "string" || !/^[0-9a-f]{64}$/.test(identity.digest)) {
      return res.status(502).json({ error: "Peon settings response has an invalid revision fence", code: "INVALID_PEON_RESPONSE" });
    }
    const result = await callPeon(connOfRecord(c.record), "PATCH", "/settings", {
      actor: c.operator.email,
      body: req.body,
      requestId: req.header("Peon-Request-Id") || undefined,
      headers: {
        "Peon-Configuration-Epoch": identity.epoch,
        "Peon-Configuration-Revision": String(identity.revision),
        "Peon-Configuration-Digest": identity.digest,
      },
    });
    if (result.ok && result.json && typeof result.json === "object") {
      const body = result.json as { name?: unknown; configuration?: { revision?: unknown }; };
      if (typeof body.name === "string" && body.name.trim()) await registry.updateName(c.record.peonId, body.name.trim());
      await appendEvent({
        workspaceId: c.workspaceId,
        peonId: c.record.peonId,
        kind: "configuration",
        payload: {
          operation: "daemon.configuration.changed",
          peonId: c.record.peonId,
          revision: body.configuration?.revision,
          updatedAt: Date.now(),
        },
      }).catch((error) => {
        // The Peon has already committed the fenced HTTP mutation. Never turn
        // that success into a retryable 5xx that could mislead the caller.
        console.warn("configuration invalidation publish failed:", error instanceof Error ? error.message : String(error));
      });
    }
    relay(result, res);
  }));
  router.get(`${wp}/stats`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const period = typeof req.query.period === "string" ? req.query.period : "";
    relay(await callPeon(
      connOfRecord(c.record),
      "GET",
      `/stats${period ? `?period=${encodeURIComponent(period)}` : ""}`,
      { actor: c.operator.email },
    ), res);
  }));
  router.get(`${wp}/analytics`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const suffix = new URLSearchParams(req.query as Record<string, string>).toString();
    relay(await callPeon(
      connOfRecord(c.record),
      "GET",
      `/analytics${suffix ? `?${suffix}` : ""}`,
      { actor: c.operator.email },
    ), res);
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
    relay(await callPeon(
      connOfRecord(c.record),
      "GET",
      `/quota/${provider}${refresh}`,
      { actor: c.operator.email },
    ), res);
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
    relay(await callPeon(
      connOfRecord(c.record),
      "GET",
      `/capabilities/${provider}${refresh}`,
      { actor: c.operator.email },
    ), res);
  }));

  // Express's named wildcard does not match an empty path, so expose the root
  // listing explicitly for filesystem pickers before the nested transfer route.
  router.get(`${wp}/files`, withWorkspacePeon((req, res, c) => proxyFileDownload(connOfRecord(c.record), [], req, res, c.operator.email)));
  // A transcript attachment carries the Peon's absolute path, so `/files/` can
  // be asked for one (`/files//tmp/peon-files/...`). Resolve it against the
  // Peon's file transfer root before proxying; see peonFileSandbox.ts.
  router.get(`${wp}/files/{*rest}`, withWorkspacePeon(async (req, res, c) => {
    const conn = connOfRecord(c.record);
    let segments: string[];
    try {
      segments = await resolveSandboxSegments(conn, restSegments(req), c.operator.email);
    } catch (err) {
      if (!(err instanceof FileSandboxError)) throw err;
      return res.status(err.status).json(auditSafeFileErrorBody(err));
    }
    return proxyFileDownload(conn, segments, req, res, c.operator.email);
  }));
  router.put(`${wp}/files/{*rest}`, withWorkspacePeon(async (req, res, c) => {
    const segments = restSegments(req);
    return proxyFileUpload(connOfRecord(c.record), segments, req, res, c.operator.email);
  }));

  // Read a message attachment by the path its transcript event carries. That
  // path is absolute for every message a client did not just send itself, so
  // this is the surface a client uses instead of guessing the sandbox layout.
  router.get(`${wp}/attachments`, withWorkspacePeon(async (req, res, c) => {
    const conn = connOfRecord(c.record);
    const rawPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!rawPath) return res.status(400).json({ error: "path query parameter is required", code: "BAD_REQUEST" });
    let segments: string[];
    try {
      segments = await resolveAttachmentPath(conn, req.query.path, c.operator.email);
    } catch (err) {
      if (!(err instanceof FileSandboxError)) throw err;
      return res.status(err.status).json(auditSafeFileErrorBody(err));
    }
    return proxyGet(conn, `/files/${segments.map(encodeURIComponent).join("/")}`, req, res, c.operator.email);
  }));

  // Read-only project file browse. Directory listings always use the
  // authenticated Fleet HTTP API, for both listings and file bodies.
  router.get(`${wp}/projects/:key/files/{*rest}`, withWorkspaceProject(async (req, res, c) => {
    const key = String(req.params.key);
    const segments = restSegments(req);
    const rest = segments.map(encodeURIComponent).join("/");
    const qs = projectFileProxyQuery(req.originalUrl);
    proxyGet(connOfRecord(c.record), `/projects/${encodeURIComponent(key)}/files/${rest}${qs}`, req, res, c.operator.email);
  }));
  router.put(`${wp}/projects/:key/files/{*rest}`, withWorkspaceProject(async (req, res, c) => {
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    return proxyUpload(connOfRecord(c.record), `/projects/${encodeURIComponent(String(req.params.key))}/files/${rest}`, req, res, c.operator.email);
  }));
  router.patch(`${wp}/projects/:key/files/{*rest}`, withWorkspaceProject(async (req, res, c) => {
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    relay(await callPeon(connOfRecord(c.record), "PATCH", `/projects/${encodeURIComponent(String(req.params.key))}/files/${rest}`, { actor: c.operator.email, body: req.body }), res);
  }));
  router.delete(`${wp}/projects/:key/files/{*rest}`, withWorkspaceProject(async (req, res, c) => {
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    relay(await callPeon(connOfRecord(c.record), "DELETE", `/projects/${encodeURIComponent(String(req.params.key))}/files/${rest}`, { actor: c.operator.email }), res);
  }));
}
