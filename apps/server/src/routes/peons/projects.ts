import { randomUUID } from "node:crypto";
import express from "express";
import { registry, toView } from "../../registry.js";
import { callPeon, connOfRecord, normalizePeonUrl, proxyFileDownload, proxyFileUpload, proxyGet, proxyUpload } from "../../peonClient.js";
import { reconcilePeon } from "../../sessionIndex.js";
import { allowedProjects, canAccessProject, projectMemberCounts } from "../../access.js";
import { ownerOnly, relay, restSegments, withWorkspacePeon } from "../helpers.js";
import { analyticsQuery, hasRuntimeReverseRead, runtimeReverseRead } from "./runtimeReverseRead.js";
import {
  browsePeonFolders,
  folderBrowseSelector,
  projectFileReadChannel,
  projectFileWriteChannel,
  projectFileProxyQuery,
  projectFolderBrowseSelector,
  projectFolderEntries,
  projectFolderReadChannel,
  streamProjectFileResponse,
  streamSandboxFileResponse,
  sandboxFileWriteChannel,
} from "../../modules/projects/index.js";
import { listProjectDocs } from "../../modules/projectDocs/index.js";
import { PeonOperationError } from "../../peonOperationChannel.js";
import { getPeonConnection, peonConnectionSupports, peonDaemonConfigurationIdentity } from "../../peonConnections.js";
import { peonConnectionSupportsCommand } from "../../peonConnections.js";
import {
  canonicalJson,
  getReverseCommandForActor,
  isCanonicalUuid,
  parseProjectDocumentationSnapshot,
  REVERSE_COMMAND_CAPABILITY,
  reverseCommandHttpResult,
  reverseCommandGateway,
  type JsonObject,
  type ReverseCommandOperation,
} from "../../modules/reverseCommands/index.js";
import {
  FOLDER_LISTING_CAPABILITY,
  FOLDER_LISTING_ENTRY_METADATA_FEATURE,
  type FolderListEntry,
} from "../../peonFolderListing.js";
import { auditSafeFileErrorBody } from "../../fileErrorSafety.js";
import { FileSandboxError, resolveAttachmentPath, resolveSandboxSegments } from "../../peonFileSandbox.js";
import { hasProjectFileTransport, hasSandboxFileTransport } from "../../peonTransferConnections.js";
import { hasFileWriteTransport } from "../../peonTransferConnections.js";
import {
  deletePeonProjectFile,
  movePeonProjectFile,
  PeonFileStreamError,
  uploadPeonProjectFile,
  uploadPeonSandboxFile,
} from "../../peonFileStream.js";
import { recordCommittedAttachmentReceipt } from "../../modules/sessions/attachmentReceipts.js";
import {
  forgetIndexedProject,
  getIndexedProject,
  getProjectCatalogState,
  hasCanonicalProjectCatalog,
  listIndexedProjects,
  refreshIndexedProjectQuickLinks,
} from "../../projectIndex.js";
import {
  DAEMON_CONFIGURATION_CAPABILITY,
  getDaemonConfigurationProjection,
} from "../../modules/daemonConfiguration.js";

export function registerProjectRoutes(router: express.Router): void {
  const wp = "/workspaces/:wsId/peons/:id";
  const attachmentUploadMaxBytes = 25 * 1024 * 1024;
  const projectUploadMaxBytes = 100 * 1024 * 1024;
  const reverseProject = async (
    req: express.Request,
    c: Parameters<Parameters<typeof withWorkspacePeon>[0]>[2],
    operation: ReverseCommandOperation,
    target: { projectId?: string },
    payload: JsonObject = {},
    expected: JsonObject | null = null,
  ) => {
    const socket = getPeonConnection(c.record.peonId);
    if (!socket || !peonConnectionSupports(socket, REVERSE_COMMAND_CAPABILITY)
      || !peonConnectionSupportsCommand(socket, operation)) return null;
    if (!expected && target.projectId && [
      "project.quick-links.create", "project.quick-links.update", "project.quick-links.delete",
    ].includes(operation)) {
      const current = await reverseCommandGateway.submit({
        workspaceId: c.workspaceId,
        peonId: c.record.peonId,
        auth: req.user!,
        operation: "project.settings.get",
        target,
        payload: {},
        waitMs: 15_000,
      });
      const digest = current.status === 200 && current.body.result && typeof current.body.result === "object"
        ? (current.body.result as { digest?: unknown }).digest : null;
      if (typeof digest !== "string") return current;
      expected = { digest };
    }
    return reverseCommandGateway.submit({
      workspaceId: c.workspaceId,
      peonId: c.record.peonId,
      auth: req.user!,
      operation,
      target,
      payload,
      expected,
      waitMs: 15_000,
    });
  };
  const relayReverse = (res: express.Response, result: Awaited<ReturnType<typeof reverseProject>>) => {
    if (!result) return false;
    if (result.status === 200 && result.body.status === "applied") res.json(result.body.result);
    else res.status(result.status).json(result.body);
    return true;
  };
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
  const relayReverseDocumentation = async (
    req: express.Request,
    res: express.Response,
    c: Parameters<Parameters<typeof withWorkspacePeon>[0]>[2],
    projectId: string,
  ): Promise<boolean> => {
    let cursor: string | undefined;
    let snapshotDigest: string | null = null;
    let totalBytes: number | null = null;
    let receivedBytes = 0;
    const chunks: string[] = [];
    for (let pageNumber = 0; pageNumber < 96; pageNumber += 1) {
      const reverse = await reverseProject(req, c, "project.documentation.index", { projectId }, {
        ...(cursor ? { cursor } : {}),
        limit: 32 * 1024,
      });
      if (!reverse) {
        if (pageNumber === 0) return false;
        res.status(503).json({ error: "Peon disconnected during project documentation sync", code: "PEON_OFFLINE" });
        return true;
      }
      if (reverse.status !== 200 || reverse.body.status !== "applied"
        || !reverse.body.result || typeof reverse.body.result !== "object") {
        relayReverse(res, reverse);
        return true;
      }
      const page = reverse.body.result as {
        snapshotDigest?: unknown; byteOffset?: unknown; totalBytes?: unknown;
        chunk?: unknown; cursor?: unknown; nextCursor?: unknown;
      };
      if (typeof page.snapshotDigest !== "string" || typeof page.byteOffset !== "number"
        || typeof page.totalBytes !== "number" || typeof page.chunk !== "string"
        || typeof page.cursor !== "string"
        || (page.nextCursor !== null && typeof page.nextCursor !== "string")
        || page.byteOffset !== receivedBytes
        || (snapshotDigest !== null && page.snapshotDigest !== snapshotDigest)
        || (totalBytes !== null && page.totalBytes !== totalBytes)) {
        res.status(502).json({ error: "Peon returned inconsistent project documentation pages", code: "UNSAFE_RESULT" });
        return true;
      }
      snapshotDigest ??= page.snapshotDigest;
      totalBytes ??= page.totalBytes;
      chunks.push(page.chunk);
      receivedBytes += Buffer.byteLength(page.chunk, "utf8");
      if (receivedBytes > 2 * 1024 * 1024 || receivedBytes > totalBytes) {
        res.status(502).json({ error: "Peon project documentation exceeded the aggregate limit", code: "UNSAFE_RESULT" });
        return true;
      }
      if (page.nextCursor === null) {
        if (receivedBytes !== totalBytes) {
          res.status(502).json({ error: "Peon returned an incomplete project documentation snapshot", code: "UNSAFE_RESULT" });
          return true;
        }
        try {
          res.json(parseProjectDocumentationSnapshot(chunks.join("")));
        } catch {
          res.status(502).json({ error: "Peon returned unsafe project documentation", code: "UNSAFE_RESULT" });
        }
        return true;
      }
      cursor = page.nextCursor;
    }
    res.status(502).json({ error: "Peon project documentation exceeded the page limit", code: "UNSAFE_RESULT" });
    return true;
  };
  const uploadHeaders = (req: express.Request) => {
    const rawLength = req.headers["content-length"];
    const contentLength = typeof rawLength === "string" && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
    const rawSha256 = req.headers["peon-content-sha256"];
    const sha256 = typeof rawSha256 === "string" ? rawSha256.trim().toLowerCase() : undefined;
    const rawRequestId = req.headers["peon-request-id"];
    const requestId = typeof rawRequestId === "string" ? rawRequestId.trim() : undefined;
    return { contentLength, sha256, requestId };
  };
  const replyFileWriteError = (res: express.Response, error: unknown) => {
    const typed = error instanceof PeonFileStreamError
      ? error
      : new PeonFileStreamError("PEON_FILE_ERROR", "Peon could not complete the file write", 502);
    if (!res.headersSent && !res.destroyed) {
      res.status(typed.status === 499 ? 502 : typed.status).json({
        error: auditSafeFileErrorBody(typed).error,
        code: typed.code,
      });
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
    const reverse = await reverseProject(req, c, "project.suggest-directory", {}, { label });
    if (relayReverse(res, reverse)) return;
    relay(await callPeon(connOfRecord(c.record), "GET", `/projects/suggest-dir${label ? `?label=${encodeURIComponent(label)}` : ""}`, { actor: c.operator.email }), res);
  }));
  router.post(`${wp}/projects`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const reverse = await reverseProject(req, c, "project.create", {}, req.body ?? {});
    if (relayReverse(res, reverse)) return;
    relay(await callPeon(connOfRecord(c.record), "POST", "/projects", { actor: c.operator.email, body: req.body }), res);
  }));
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
    if (await relayReverseDocumentation(req, res, c, projectId)) return;
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
    const indexed = await getIndexedProject(c.record.peonId, String(req.params.key));
    if (indexed) {
      const reverse = await reverseProject(req, c, "project.skills.list", { projectId: indexed.projectId });
      if (relayReverse(res, reverse)) return;
    }
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
    const indexed = await getIndexedProject(c.record.peonId, key);
    if (indexed) {
      const reverse = await reverseProject(req, c, "project.quick-links.create", { projectId: indexed.projectId }, req.body ?? {});
      if (relayReverse(res, reverse)) return;
    }
    const result = await callPeon(connOfRecord(c.record), "POST", `${proj(key)}/quick-links`, { actor: c.operator.email, body: req.body });
    if (result.ok) await refreshQuickLinks(c, key);
    relay(result, res);
  }));
  router.patch(`${wp}/projects/:key/quick-links/:linkId`, withWorkspaceProject(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const key = String(req.params.key);
    const indexed = await getIndexedProject(c.record.peonId, key);
    if (indexed) {
      const reverse = await reverseProject(req, c, "project.quick-links.update", { projectId: indexed.projectId }, {
        id: String(req.params.linkId), ...(req.body ?? {}),
      });
      if (relayReverse(res, reverse)) return;
    }
    const path = `${proj(key)}/quick-links/${encodeURIComponent(String(req.params.linkId))}`;
    const result = await callPeon(connOfRecord(c.record), "PATCH", path, { actor: c.operator.email, body: req.body });
    if (result.ok) await refreshQuickLinks(c, key);
    relay(result, res);
  }));
  router.delete(`${wp}/projects/:key/quick-links/:linkId`, withWorkspaceProject(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const key = String(req.params.key);
    const indexed = await getIndexedProject(c.record.peonId, key);
    if (indexed) {
      const reverse = await reverseProject(req, c, "project.quick-links.delete", { projectId: indexed.projectId }, {
        id: String(req.params.linkId),
      });
      if (relayReverse(res, reverse)) return;
    }
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
  router.patch(`${wp}/projects/:key/settings`, withWorkspaceProject(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const key = String(req.params.key);
    const indexed = await getIndexedProject(c.record.peonId, key);
    if (indexed) {
      const read = await reverseProject(req, c, "project.settings.get", { projectId: indexed.projectId });
      const digest = read?.status === 200 && read.body.result && typeof read.body.result === "object"
        ? (read.body.result as { digest?: unknown }).digest : null;
      if (typeof digest === "string") {
        const reverse = await reverseProject(req, c, "project.settings.update", { projectId: indexed.projectId }, req.body ?? {}, { digest });
        if (relayReverse(res, reverse)) return;
      } else if (read) return void res.status(read.status).json(read.body);
    }
    relay(await callPeon(connOfRecord(c.record), "PATCH", `${proj(key)}/settings`, { actor: c.operator.email, body: req.body }), res);
  }));
  router.delete(`${wp}/projects/:key`, withWorkspaceProject(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const key = String(req.params.key);
    const indexed = await getIndexedProject(c.record.peonId, key);
    if (indexed) {
      const read = await reverseProject(req, c, "project.settings.get", { projectId: indexed.projectId });
      const digest = read?.status === 200 && read.body.result && typeof read.body.result === "object"
        ? (read.body.result as { digest?: unknown }).digest : null;
      if (typeof digest === "string") {
        const reverse = await reverseProject(req, c, "project.delete", { projectId: indexed.projectId }, {}, { digest });
        if (reverse?.status === 200 && reverse.body.status === "applied") {
          await forgetDeletedProject(c, key, indexed.projectId);
        }
        if (relayReverse(res, reverse)) return;
      } else if (read) return void res.status(read.status).json(read.body);
    }
    const result = await callPeon(connOfRecord(c.record), "DELETE", proj(key), { actor: c.operator.email });
    if (result.ok) await forgetDeletedProject(c, key, indexed?.projectId ?? null);
    relay(result, res);
  }));
  router.get(`${wp}/settings`, withWorkspacePeon(async (_req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const socket = getPeonConnection(c.record.peonId);
    const savedProjection = await getDaemonConfigurationProjection(c.record.peonId);
    if (socket && peonConnectionSupports(socket, DAEMON_CONFIGURATION_CAPABILITY)) {
      const projection = savedProjection;
      if (!projection) return res.status(503).json({ error: "Peon configuration is still synchronizing", code: "CONFIGURATION_SYNCING" });
      const advertised = peonDaemonConfigurationIdentity(socket);
      const current = advertised?.epoch === projection.epoch
        && advertised.revision === projection.revision
        && advertised.digest === projection.digest;
      return res.json({
        ...projection.values,
        sync: {
          status: current ? "current" : "syncing",
          epoch: projection.epoch,
          revision: projection.revision,
          digest: projection.digest,
          updatedAt: projection.updatedAt,
        },
      });
    }
    if (!socket && savedProjection) {
      return res.json({
        ...savedProjection.values,
        sync: {
          status: "offline",
          epoch: savedProjection.epoch,
          revision: savedProjection.revision,
          digest: savedProjection.digest,
          updatedAt: savedProjection.updatedAt,
        },
      });
    }
    relay(await callPeon(connOfRecord(c.record), "GET", "/settings", { actor: c.operator.email }), res);
  }));
  router.patch(`${wp}/settings`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const requestedCommandId = typeof req.headers["peon-request-id"] === "string"
      ? req.headers["peon-request-id"].trim()
      : null;
    if (requestedCommandId && !isCanonicalUuid(requestedCommandId)) {
      return res.status(400).json({ error: "Peon-Request-Id must be a canonical UUID", code: "BAD_COMMAND" });
    }
    if (requestedCommandId) {
      const existing = await getReverseCommandForActor(
        c.workspaceId,
        c.record.peonId,
        requestedCommandId,
        c.userId,
      );
      if (existing) {
        const originalPatch = existing.payload.patch;
        if (!originalPatch || typeof originalPatch !== "object" || Array.isArray(originalPatch)
          || canonicalJson(originalPatch) !== canonicalJson((req.body ?? {}) as JsonObject)) {
          return res.status(409).json({ error: "command ID was already used for a different request", code: "COMMAND_ID_REUSED" });
        }
        const replay = reverseCommandHttpResult(existing);
        if (replay.status === 200 && existing.result?.values
          && typeof existing.result.values === "object" && !Array.isArray(existing.result.values)) {
          return res.json({
            ...existing.result.values,
            commandId: existing.commandId,
            restart: existing.result.restart,
          });
        }
        return res.status(replay.status).json(replay.body);
      }
    }
    const socket = getPeonConnection(c.record.peonId);
    const savedProjection = await getDaemonConfigurationProjection(c.record.peonId);
    if (!socket && savedProjection) {
      return res.status(503).json({ error: "Peon is offline", code: "PEON_OFFLINE" });
    }
    if (socket && peonConnectionSupports(socket, DAEMON_CONFIGURATION_CAPABILITY)) {
      const projection = savedProjection;
      if (!projection) return res.status(503).json({ error: "Peon configuration is still synchronizing", code: "CONFIGURATION_SYNCING" });
      const advertised = peonDaemonConfigurationIdentity(socket);
      if (advertised?.epoch !== projection.epoch
        || advertised.revision !== projection.revision
        || advertised.digest !== projection.digest) {
        return res.status(503).json({ error: "Peon configuration is still synchronizing", code: "CONFIGURATION_SYNCING" });
      }
      const result = await reverseCommandGateway.submit({
        workspaceId: c.workspaceId,
        peonId: c.record.peonId,
        auth: req.user!,
        operation: "daemon.configuration.patch",
        target: {},
        payload: { patch: req.body ?? {} },
        expected: { epoch: projection.epoch, revision: projection.revision, digest: projection.digest },
        ...(requestedCommandId ? { commandId: requestedCommandId } : {}),
      });
      if (result.status === 200 && result.record?.result) {
        const values = result.record.result.values;
        if (values && typeof values === "object" && !Array.isArray(values)) {
          const name = (values as Record<string, unknown>).name;
          if (typeof name === "string" && name.trim()) await registry.updateName(c.record.peonId, name.trim());
          return res.json({
            ...values,
            commandId: result.record.commandId,
            restart: result.record.result.restart,
          });
        }
      }
      return res.status(result.status).json(result.body);
    }
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
    if (hasRuntimeReverseRead(c.record.peonId, "runtime.stats")) {
      return runtimeReverseRead(req, res, {
        workspaceId: c.workspaceId, peonId: c.record.peonId, operation: "runtime.stats", payload: { period: period || "day" },
      });
    }
    relay(await callPeon(connOfRecord(c.record), "GET", `/stats${period ? `?period=${encodeURIComponent(period)}` : ""}`, { actor: c.operator.email }), res);
  }));
  router.get(`${wp}/analytics`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    if (hasRuntimeReverseRead(c.record.peonId, "runtime.analytics")) {
      const query = analyticsQuery(req.query);
      if (!query) return res.status(400).json({ error: "invalid analytics query", code: "BAD_REQUEST" });
      return runtimeReverseRead(req, res, {
        workspaceId: c.workspaceId, peonId: c.record.peonId, operation: "runtime.analytics", payload: { query },
      });
    }
    const suffix = new URLSearchParams(req.query as Record<string, string>).toString();
    relay(await callPeon(connOfRecord(c.record), "GET", `/analytics${suffix ? `?${suffix}` : ""}`, { actor: c.operator.email }), res);
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
    if (hasRuntimeReverseRead(c.record.peonId, "runtime.quota")) {
      return runtimeReverseRead(req, res, {
        workspaceId: c.workspaceId, peonId: c.record.peonId, operation: "runtime.quota",
        payload: { provider, refresh: req.query.refresh === "1" },
      });
    }
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
    if (hasRuntimeReverseRead(c.record.peonId, "runtime.capabilities")) {
      return runtimeReverseRead(req, res, {
        workspaceId: c.workspaceId, peonId: c.record.peonId, operation: "runtime.capabilities",
        payload: { provider, refresh: req.query.refresh === "1" },
      });
    }
    relay(await callPeon(connOfRecord(c.record), "GET", `/capabilities/${provider}${refresh}`, { actor: c.operator.email }), res);
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
    if (sandboxFileWriteChannel({ capabilityReady: hasFileWriteTransport(c.record.peonId) }) === "proxy") {
      return proxyFileUpload(connOfRecord(c.record), segments, req, res, c.operator.email);
    }
    const path = segments.join("/");
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const transferId = randomUUID();
      const result = await uploadPeonSandboxFile({
        peonId: c.record.peonId,
        workspaceId: c.workspaceId,
        path,
        source: req,
        actor: { userId: c.userId, email: c.operator.email },
        signal: controller.signal,
        maxBytes: path.startsWith("uploads/") ? attachmentUploadMaxBytes : projectUploadMaxBytes,
        ...uploadHeaders(req),
        requestId: transferId,
      });
      if (!res.destroyed) {
        if (path.startsWith("uploads/")) {
          if (!result.sha256) {
            return res.status(502).json({ error: "Peon omitted the committed attachment checksum", code: "INVALID_WRITE_RESULT" });
          }
          const receipt = await recordCommittedAttachmentReceipt({
            workspaceId: c.workspaceId,
            peonId: c.record.peonId,
            actor: { userId: c.userId, email: c.operator.email },
            transferId,
            path: result.path,
            size: result.size,
            sha256: result.sha256,
          });
          return res.status(result.status).json(receipt);
        }
        res.status(result.status).json({ path: result.path, size: result.size, sha256: result.sha256 });
      }
    } catch (error) {
      replyFileWriteError(res, error);
    }
  }));

  // Read a message attachment by the path its transcript event carries. That
  // path is absolute for every message a client did not just send itself, so
  // this is the surface a client uses instead of guessing the sandbox layout.
  router.get(`${wp}/attachments`, withWorkspacePeon(async (req, res, c) => {
    const conn = connOfRecord(c.record);
    const rawPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!rawPath) return res.status(400).json({ error: "path query parameter is required", code: "BAD_REQUEST" });
    if (hasSandboxFileTransport(c.record.peonId)) {
      return streamSandboxFileResponse({
        req,
        res,
        peonId: c.record.peonId,
        path: rawPath,
        actor: { userId: c.userId, email: c.operator.email },
      });
    }
    let segments: string[];
    try {
      segments = await resolveAttachmentPath(conn, req.query.path, c.operator.email);
    } catch (err) {
      if (!(err instanceof FileSandboxError)) throw err;
      return res.status(err.status).json(auditSafeFileErrorBody(err));
    }
    return proxyGet(conn, `/files/${segments.map(encodeURIComponent).join("/")}`, req, res, c.operator.email);
  }));

  // Read-only project file browse. Directory listings use the project-scoped
  // folder-listing operation when its additive entry metadata was negotiated;
  // file bodies use the transfer socket. Older Peons retain the HTTP proxy.
  router.get(`${wp}/projects/:key/files/{*rest}`, withWorkspaceProject(async (req, res, c) => {
    const key = String(req.params.key);
    const segments = restSegments(req);
    const stat = req.query.stat !== undefined;
    const confirmedDirectory = req.query.directory === "1";
    const transportReady = hasProjectFileTransport(c.record.peonId);
    const controlSocket = getPeonConnection(c.record.peonId);
    const folderMetadataReady = Boolean(controlSocket
      && peonConnectionSupports(controlSocket, FOLDER_LISTING_CAPABILITY)
      && peonConnectionSupports(controlSocket, FOLDER_LISTING_ENTRY_METADATA_FEATURE));
    // Both reverse operations address the immutable catalog identity. Skip the
    // lookup only when neither socket can answer.
    const projectId = transportReady || folderMetadataReady
      ? (await getIndexedProject(c.record.peonId, key))?.projectId ?? null
      : null;
    const folderChannel = projectFolderReadChannel({ confirmedDirectory, metadataReady: folderMetadataReady, projectId });
    if (stat && folderChannel === "unavailable") {
      return res.status(409).json({ error: "canonical project identity is temporarily unavailable", code: "PROJECT_IDENTITY_UNAVAILABLE" });
    }
    if (stat && folderChannel === "socket") {
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      res.once("close", () => controller.abort());
      try {
        const listing = await browsePeonFolders(
          c.record.peonId,
          projectFolderBrowseSelector(projectId!, segments),
          controller.signal,
          undefined,
          {},
          true,
        );
        return res.json({ path: segments.join("/"), entries: projectFolderEntries(listing.entries as FolderListEntry[]) });
      } catch (error) {
        if (controller.signal.aborted || res.headersSent || res.destroyed) return;
        const typed = error instanceof PeonOperationError
          ? error
          : new PeonOperationError("FOLDER_LIST_FAILED", "the project folder could not be listed", 502);
        return res.status(typed.status === 499 ? 502 : typed.status).json({ error: typed.message, code: typed.code });
      }
    }
    const readChannel = projectFileReadChannel({ transportReady, projectId });
    if (!stat && readChannel === "unavailable") {
      return res.status(409).json({ error: "canonical project identity is temporarily unavailable", code: "PROJECT_IDENTITY_UNAVAILABLE" });
    }
    if (!stat && readChannel === "socket") {
      return streamProjectFileResponse({
        req,
        res,
        peonId: c.record.peonId,
        projectId: projectId!,
        relativePath: segments.join("/"),
        actor: { userId: c.userId, email: c.operator.email },
      });
    }
    const rest = segments.map(encodeURIComponent).join("/");
    const qs = projectFileProxyQuery(req.originalUrl);
    proxyGet(connOfRecord(c.record), `/projects/${encodeURIComponent(key)}/files/${rest}${qs}`, req, res, c.operator.email);
  }));
  router.put(`${wp}/projects/:key/files/{*rest}`, withWorkspaceProject(async (req, res, c) => {
    const writeReady = hasFileWriteTransport(c.record.peonId);
    const projectId = writeReady
      ? (await getIndexedProject(c.record.peonId, String(req.params.key)))?.projectId ?? null
      : null;
    const writeChannel = projectFileWriteChannel({ capabilityReady: writeReady, projectId });
    if (writeChannel === "unavailable") {
      return res.status(409).json({ error: "canonical project identity is temporarily unavailable", code: "PROJECT_IDENTITY_UNAVAILABLE" });
    }
    if (writeChannel === "socket") {
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      res.once("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const result = await uploadPeonProjectFile({
          peonId: c.record.peonId,
          workspaceId: c.workspaceId,
          projectId: projectId!,
          relativePath: restSegments(req).join("/"),
          source: req,
          actor: { userId: c.userId, email: c.operator.email },
          signal: controller.signal,
          maxBytes: projectUploadMaxBytes,
          ...uploadHeaders(req),
        });
        if (!res.destroyed) res.status(result.status).json({ path: result.path, size: result.size, sha256: result.sha256 });
      } catch (error) {
        replyFileWriteError(res, error);
      }
      return;
    }
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    return proxyUpload(connOfRecord(c.record), `/projects/${encodeURIComponent(String(req.params.key))}/files/${rest}`, req, res, c.operator.email);
  }));
  router.patch(`${wp}/projects/:key/files/{*rest}`, withWorkspaceProject(async (req, res, c) => {
    const writeReady = hasFileWriteTransport(c.record.peonId);
    const projectId = writeReady
      ? (await getIndexedProject(c.record.peonId, String(req.params.key)))?.projectId ?? null
      : null;
    const writeChannel = projectFileWriteChannel({ capabilityReady: writeReady, projectId });
    if (writeChannel === "unavailable") {
      return res.status(409).json({ error: "canonical project identity is temporarily unavailable", code: "PROJECT_IDENTITY_UNAVAILABLE" });
    }
    if (writeChannel === "socket") {
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      res.once("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const destination = typeof req.body?.destination === "string" ? req.body.destination : "";
        const result = await movePeonProjectFile({
          peonId: c.record.peonId,
          workspaceId: c.workspaceId,
          projectId: projectId!,
          relativePath: restSegments(req).join("/"),
          destination,
          actor: { userId: c.userId, email: c.operator.email },
          signal: controller.signal,
          requestId: uploadHeaders(req).requestId,
        });
        if (!res.destroyed) res.status(result.status).json({ path: result.path, size: result.size });
      } catch (error) {
        replyFileWriteError(res, error);
      }
      return;
    }
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    relay(await callPeon(connOfRecord(c.record), "PATCH", `/projects/${encodeURIComponent(String(req.params.key))}/files/${rest}`, { actor: c.operator.email, body: req.body }), res);
  }));
  router.delete(`${wp}/projects/:key/files/{*rest}`, withWorkspaceProject(async (req, res, c) => {
    const writeReady = hasFileWriteTransport(c.record.peonId);
    const projectId = writeReady
      ? (await getIndexedProject(c.record.peonId, String(req.params.key)))?.projectId ?? null
      : null;
    const writeChannel = projectFileWriteChannel({ capabilityReady: writeReady, projectId });
    if (writeChannel === "unavailable") {
      return res.status(409).json({ error: "canonical project identity is temporarily unavailable", code: "PROJECT_IDENTITY_UNAVAILABLE" });
    }
    if (writeChannel === "socket") {
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      res.once("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const correlation = uploadHeaders(req);
        const result = await deletePeonProjectFile({
          peonId: c.record.peonId,
          workspaceId: c.workspaceId,
          projectId: projectId!,
          relativePath: restSegments(req).join("/"),
          actor: { userId: c.userId, email: c.operator.email },
          signal: controller.signal,
          requestId: correlation.requestId,
        });
        if (!res.destroyed) res.status(result.status).json({ path: result.path, size: result.size });
      } catch (error) {
        replyFileWriteError(res, error);
      }
      return;
    }
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    relay(await callPeon(connOfRecord(c.record), "DELETE", `/projects/${encodeURIComponent(String(req.params.key))}/files/${rest}`, { actor: c.operator.email }), res);
  }));
}
