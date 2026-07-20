import express from "express";
import type { PeonRecord } from "../../registry.js";
import { callPeon, connOfRecord, proxyGet, proxyStream } from "../../peonClient.js";
import { allowedProjects, canAccessProject } from "../../access.js";
import { ownerOnly, relay, withWorkspacePeon } from "../helpers.js";
import { mintWebPreview } from "../../webPreview.js";
import { runIdempotentFollowup, validCommandId } from "../../followupIdempotency.js";
import { enrichTranscriptMetadata } from "../../transcriptTimestamps.js";
import { indexAcceptedSession } from "../../acceptedSession.js";
import { deleteIndexedSession } from "../../sessionIndex.js";

export function transcriptQuery(query: express.Request["query"], supported: boolean): string {
  if (!supported) return "";
  const params = new URLSearchParams();
  const limit = query.limit;
  const cursor = query.cursor;
  if (typeof limit === "string" && /^\d+$/.test(limit)) params.set("limit", limit);
  if (typeof cursor === "string" && cursor) params.set("cursor", cursor);
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

export function registerSessionRoutes(router: express.Router): void {
  const wp = "/workspaces/:wsId/peons/:id";
  const callSupportedPeonPath = async (
    record: PeonRecord,
    method: "GET" | "POST",
    paths: string[],
    actor: string,
    body?: unknown,
  ) => {
    let result = await callPeon(connOfRecord(record), method, paths[0]!, { actor, body });
    for (let index = 1; index < paths.length && (result.status === 404 || result.status === 401); index += 1) {
      result = await callPeon(connOfRecord(record), method, paths[index]!, { actor, body });
    }
    return result;
  };
  const withWorkspaceSession = (handler: Parameters<typeof withWorkspacePeon>[0]) => withWorkspacePeon(async (req, res, c) => {
    if (c.role !== "owner") {
      const lookup = await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}`, { actor: c.operator.email });
      if (!lookup.ok) return relay(lookup, res);
      const projectKey = lookup.json && typeof lookup.json === "object" && typeof (lookup.json as { projectKey?: unknown }).projectKey === "string"
        ? (lookup.json as { projectKey: string }).projectKey
        : null;
      const projectId = lookup.json && typeof lookup.json === "object" && typeof (lookup.json as { projectId?: unknown }).projectId === "string"
        ? (lookup.json as { projectId: string }).projectId
        : null;
      if (projectKey && !(await canAccessProject(c.workspaceId, c.userId, c.role, c.record.peonId, projectKey, projectId))) {
        return res.status(404).json({ error: "unknown session", code: "UNKNOWN_SESSION" });
      }
    }
    return handler(req, res, c);
  });
  router.get(`${wp}/status`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", "/status", { actor: c.operator.email }), res)));
  router.patch(`${wp}/status`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    relay(await callPeon(connOfRecord(c.record), "PATCH", "/status", { actor: c.operator.email, body: req.body }), res);
  }));
  // Provider capabilities + the peon's global default feed the session pickers.
  // `agent`, `model`, and `reasoningEffort` already ride
  // the generic body passthrough, so this read is the only new proxy route needed.
  // Peons that predate model selection have no /models route (they answer 404 —
  // or, on some builds, 401 for the unknown path since /status uses the same creds
  // and works). Degrade those to an empty catalog so the client silently hides the
  // picker instead of the browser logging a failed probe on every peon page.
  router.get(`${wp}/models`, withWorkspacePeon(async (_req, res, c) => {
    const r = await callPeon(connOfRecord(c.record), "GET", "/models", { actor: c.operator.email });
    if (r.status === 404 || r.status === 401) return res.json({ providers: [], defaultModel: null });
    relay(r, res);
  }));
  router.get(`${wp}/sessions`, withWorkspacePeon(async (_req, res, c) => {
    const result = await callPeon(connOfRecord(c.record), "GET", "/sessions", { actor: c.operator.email });
    if (!result.ok || c.role === "owner" || !result.json || typeof result.json !== "object") return relay(result, res);
    const access = (await allowedProjects(c.workspaceId, c.userId, c.role, c.record.peonId)) ?? [];
    const allowedIds = new Set(access.flatMap((item) => item.projectId ? [item.projectId] : []));
    const legacyKeys = new Set(access.filter((item) => !item.projectId).map((item) => item.projectKey));
    const body = result.json as { sessions?: unknown[] };
    const sessions = Array.isArray(body.sessions) ? body.sessions.filter((session) => {
      if (!session || typeof session !== "object") return false;
      const key = (session as { projectKey?: unknown }).projectKey;
      const id = (session as { projectId?: unknown }).projectId;
      return typeof key !== "string" || !key || (typeof id === "string" ? allowedIds.has(id) : legacyKeys.has(key));
    }) : [];
    res.status(result.status).json({ ...body, sessions });
  }));
  router.get(`${wp}/sessions/:sid`, withWorkspaceSession(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}`, { actor: c.operator.email }), res)));
  router.get(`${wp}/sessions/:sid/transcript`, withWorkspaceSession(async (req, res, c) => {
    const query = transcriptQuery(req.query, c.record.capabilities.includes("transcript-pagination-v1"));
    const r = await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}/transcript${query}`, { actor: c.operator.email });
    const raw = r.json && typeof r.json === "object" ? (r.json as { raw?: unknown }).raw : undefined;
    // Some peon builds fail the whole transcript endpoint when one JSONL row is corrupt.
    // Keep the session page usable; live tail and session metadata still render.
    if (r.status >= 500 && typeof raw === "string" && raw.includes("JSON.parse") && raw.includes("getTranscript")) return res.json({ events: [] });
    if (r.ok && r.json && typeof r.json === "object") {
      const body = r.json as { events?: unknown };
      if (Array.isArray(body.events)) {
        try {
          const events = await enrichTranscriptMetadata(c.record.peonId, String(req.params.sid), body.events);
          return res.status(r.status).json({ ...body, events });
        } catch {
          // Local metadata enrichment is best-effort; never hide a valid transcript
          // because its local metadata could not be read.
        }
      }
    }
    relay(r, res);
  }));
  router.post(
    `${wp}/sessions`,
    withWorkspacePeon(async (req, res, c) => {
      const projectKey = typeof req.body?.projectKey === "string" ? req.body.projectKey : null;
      let projectId: string | null = null;
      if (projectKey && c.role !== "owner") {
        const project = await callPeon(connOfRecord(c.record), "GET", `/projects/${encodeURIComponent(projectKey)}`, { actor: c.operator.email });
        projectId = project.ok && project.json && typeof project.json === "object" && typeof (project.json as { projectId?: unknown }).projectId === "string"
          ? (project.json as { projectId: string }).projectId
          : null;
      }
      if (projectKey && !(await canAccessProject(c.workspaceId, c.userId, c.role, c.record.peonId, projectKey, projectId))) return res.status(403).json({ error: "project access required", code: "FORBIDDEN" });
      const requestId = req.headers["peon-request-id"];
      if (requestId !== undefined && !validCommandId(requestId)) {
        return res.status(400).json({ error: "Peon-Request-Id must be a non-empty idempotency key of at most 255 characters", code: "BAD_REQUEST" });
      }
      // Control plane owns admission (PROTOCOL: "control plane owns admission"). A
      // peon can be online yet have a broken/unauthenticated Claude CLI — it would
      // accept the session and then fail every run. Refuse to route new work there.
      // Older peons that don't report agentAuth (or report "unknown") pass through:
      // we only block on a definitively bad CLI so un-upgraded peons keep working.
      const blocked = await agentAuthBlocked(c.record, req.body?.agent);
      if (blocked) {
        return res.status(409).json({
          error: blocked === "unauthenticated" ? "this peon's Claude CLI is not signed in — sessions would fail" : "this peon's Claude CLI is broken — sessions would fail",
          code: "AGENT_UNAVAILABLE",
          authState: blocked,
        });
      }
      const result = await callPeon(connOfRecord(c.record), "POST", "/sessions", {
        actor: c.operator.email,
        body: req.body,
        requestId: typeof requestId === "string" ? requestId : undefined,
      });
      await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
      relay(result, res);
    }),
  );
  router.patch(`${wp}/sessions/:sid`, withWorkspaceSession(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "PATCH", `/sessions/${encodeURIComponent(String(req.params.sid))}`, { actor: c.operator.email, body: req.body }), res)));
  router.post(`${wp}/sessions/:sid/followup`, withWorkspaceSession(async (req, res, c) => {
    const commandId = req.headers["peon-request-id"];
    if (!validCommandId(commandId)) return res.status(400).json({ error: "Peon-Request-Id must be a non-empty idempotency key of at most 255 characters", code: "BAD_REQUEST" });
    const sid = String(req.params.sid);
    const result = await runIdempotentFollowup(c.record.peonId, sid, commandId, req.body, () =>
      callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(sid)}/followup`, { actor: c.operator.email, body: req.body, requestId: commandId }),
    );
    await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
    relay(result, res);
  }));
  router.get(`${wp}/sessions/:sid/queue`, withWorkspaceSession(async (req, res, c) => {
    relay(await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}/queue`, { actor: c.operator.email }), res);
  }));
  router.post(`${wp}/sessions/:sid/queue`, withWorkspaceSession(async (req, res, c) => {
    relay(await callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(String(req.params.sid))}/queue`, { actor: c.operator.email, body: req.body }), res);
  }));
  router.post(`${wp}/sessions/:sid/queue/:itemId/send`, withWorkspaceSession(async (req, res, c) => {
    relay(await callPeon(
      connOfRecord(c.record),
      "POST",
      `/sessions/${encodeURIComponent(String(req.params.sid))}/queue/${encodeURIComponent(String(req.params.itemId))}/send`,
      { actor: c.operator.email },
    ), res);
  }));
  router.delete(`${wp}/sessions/:sid/queue/:itemId`, withWorkspaceSession(async (req, res, c) => {
    relay(await callPeon(
      connOfRecord(c.record),
      "DELETE",
      `/sessions/${encodeURIComponent(String(req.params.sid))}/queue/${encodeURIComponent(String(req.params.itemId))}`,
      { actor: c.operator.email },
    ), res);
  }));
  router.post(`${wp}/sessions/:sid/cancel`, withWorkspaceSession(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(String(req.params.sid))}/cancel`, { actor: c.operator.email }), res)));
  router.delete(`${wp}/sessions/:sid`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    const result = await callPeon(connOfRecord(c.record), "DELETE", `/sessions/${encodeURIComponent(sid)}`, { actor: c.operator.email });
    if (result.ok) await deleteIndexedSession(c.workspaceId, c.record.peonId, sid);
    relay(result, res);
  }));
  router.post(`${wp}/control/pause`, withWorkspacePeon(async (_req, res, c) => { if (!ownerOnly(res, c.role)) return; relay(await callPeon(connOfRecord(c.record), "POST", "/control/pause", { actor: c.operator.email }), res); }));
  router.post(`${wp}/control/resume`, withWorkspacePeon(async (_req, res, c) => { if (!ownerOnly(res, c.role)) return; relay(await callPeon(connOfRecord(c.record), "POST", "/control/resume", { actor: c.operator.email }), res); }));
  router.post(`${wp}/control/check-update`, withWorkspacePeon(async (_req, res, c) => { if (!ownerOnly(res, c.role)) return; relay(await callPeon(connOfRecord(c.record), "POST", "/control/check-update", { actor: c.operator.email }), res); }));
  router.post(`${wp}/control/update`, withWorkspacePeon(async (_req, res, c) => { if (!ownerOnly(res, c.role)) return; relay(await callPeon(connOfRecord(c.record), "POST", "/control/update", { actor: c.operator.email }), res); }));
  router.get(`${wp}/ai/cli-updates`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const query = req.query.refresh === "true" || req.query.refresh === "1" ? "?refresh=true" : "";
    const paths = ["/ai/cli-updates", "/ai/updates", "/cli-updates"].map((path) => `${path}${query}`);
    relay(await callSupportedPeonPath(c.record, "GET", paths, c.operator.email), res);
  }));
  router.post(`${wp}/ai/cli-updates/:provider`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const provider = String(req.params.provider);
    if (provider !== "codex" && provider !== "claude-code") {
      return res.status(400).json({ error: "provider must be codex or claude-code", code: "BAD_PROVIDER" });
    }
    const encoded = encodeURIComponent(provider);
    const paths = [
      `/ai/cli-updates/${encoded}`,
      `/ai/cli-updates/${encoded}/update`,
      `/ai/updates/${encoded}`,
      `/ai/updates/${encoded}/update`,
      `/cli-updates/${encoded}`,
      `/cli-updates/${encoded}/update`,
    ];
    relay(await callSupportedPeonPath(c.record, "POST", paths, c.operator.email, req.body), res);
  }));
  router.get(`${wp}/sessions/:sid/stream`, withWorkspaceSession((req, res, c) => proxyStream(connOfRecord(c.record), `/sessions/${encodeURIComponent(String(req.params.sid))}/stream`, res, c.operator.email)));

  // First-class session artifact previews. These deliberately mirror Peon's
  // session-scoped API instead of reusing the transfer sandbox: preview paths
  // may be absolute and Peon owns all path/session validation.
  router.get(`${wp}/sessions/:sid/file`, withWorkspaceSession(async (req, res, c) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}/file?path=${encodeURIComponent(path)}`, { actor: c.operator.email }), res);
  }));
  router.get(`${wp}/sessions/:sid/file/raw`, withWorkspaceSession((req, res, c) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    proxyGet(connOfRecord(c.record), `/sessions/${encodeURIComponent(String(req.params.sid))}/file/raw?path=${encodeURIComponent(path)}`, req, res, c.operator.email);
  }));
  router.get(`${wp}/sessions/:sid/file/stream`, withWorkspaceSession((req, res, c) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    proxyStream(connOfRecord(c.record), `/sessions/${encodeURIComponent(String(req.params.sid))}/file/stream?path=${encodeURIComponent(path)}`, res, c.operator.email);
  }));
  router.post(`${wp}/sessions/:sid/preview`, withWorkspaceSession(async (req, res, c) => {
    // callPeon maps the signed-in operator to Peon-Actor. The Peon persists and
    // broadcasts the returned normalized preview event.
    relay(await callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(String(req.params.sid))}/preview`, { actor: c.operator.email, body: req.body }), res);
  }));
  router.post(`${wp}/sessions/:sid/web-preview`, withWorkspaceSession(async (req, res, c) => {
    const htmlPath = typeof req.body?.path === "string" ? req.body.path : "";
    try {
      res.status(201).json(mintWebPreview({
        peonId: c.record.peonId,
        workspaceId: c.record.workspaceId,
        sessionId: String(req.params.sid),
        htmlPath,
        actor: c.operator.email,
      }));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "invalid HTML preview path", code: "BAD_PREVIEW_PATH" });
    }
  }));
}

// Ask a peon's /status whether its legacy/default Claude CLI is usable. Explicit
// non-Claude providers have their own runtime and must not be blocked by this
// provider-specific status field. Returns the offending
// authState ("broken" | "unauthenticated") when new work must NOT be routed there,
// or null when it's fine to proceed — including when we can't tell (peon
// unreachable, no agentAuth field on an older peon, or authState "unknown").
async function agentAuthBlocked(record: PeonRecord, agent: unknown): Promise<"broken" | "unauthenticated" | null> {
if (typeof agent === "string" && agent !== "claude-code") return null;
const r = await callPeon(connOfRecord(record), "GET", "/status");
if (!r.ok || !r.json || typeof r.json !== "object") return null;
const auth = (r.json as { agentAuth?: unknown }).agentAuth;
const state = auth && typeof auth === "object" ? (auth as { authState?: unknown }).authState : undefined;
return state === "broken" || state === "unauthenticated" ? state : null;
}
