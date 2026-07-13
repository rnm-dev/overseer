import express from "express";
import { config } from "../config.js";
import { registry, toView, type PeonRecord } from "../registry.js";
import { callPeon, connOfRecord, normalizePeonUrl, proxyStream, proxyGet, proxyFileDownload, proxyFileUpload, proxyUpload } from "../peonClient.js";
import { listSessions, reconcilePeon } from "../sessionIndex.js";
import { bindPeon, mintCredential, revokeCredential, revokeCredentialForPeon } from "../credentials.js";
import { relay, restSegments, withWorkspace, withWorkspacePeon } from "./helpers.js";
import { mintWebPreview } from "../webPreview.js";
import { runIdempotentFollowup, validCommandId } from "../followupIdempotency.js";

// Peons in a workspace (registry-backed, scoped by membership) — mounted on
// /api AFTER operatorAuth. Recruitment/connect + the per-peon proxy surface.
export function peonsRouter(): express.Router {
  const router = express.Router();

  // Dry-run connectivity check before recruiting: reach the peon's /status with
  // the pasted pairing secret and read back its identity. Mints nothing, stores
  // nothing — purely to let the operator confirm the address + secret are right.
  router.post(
    "/workspaces/:wsId/peons/connect",
    withWorkspace(async (req, res) => {
      const address = typeof req.body?.address === "string" ? req.body.address.trim() : "";
      const secret = typeof req.body?.secret === "string" ? req.body.secret.trim() : "";
      if (!address || !secret) return res.status(400).json({ error: "peon address and pairing secret are required", code: "BAD_REQUEST" });
      const baseUrl = normalizePeonUrl(address);
      if (!baseUrl) return res.status(400).json({ error: "that doesn't look like a peon address", code: "BAD_URL" });

      const r = await callPeon({ baseUrl, token: secret }, "GET", "/status", { actor: req.user?.email ?? null, timeoutMs: 8000 });
      if (!r.ok) {
        const message = r.status === 401 ? "the peon rejected that secret" : r.status === 502 ? "couldn't reach the peon at that address" : "the peon answered with an error";
        return res.json({ ok: false, message });
      }
      const name = r.json && typeof r.json === "object" ? (r.json as { name?: unknown }).name : undefined;
      res.json({ ok: true, name: typeof name === "string" ? name : null });
    }),
  );

  // Recruit a peon: the overseer reaches out over the tailnet and pairs it. The
  // operator gives the peon's address + its pairing secret; the overseer mints a
  // workspace-scoped credential and pushes it to the peon's /api/v1/enroll, which
  // makes the peon phone home. Nothing is ever pasted onto the peon by hand.
  router.post(
    "/workspaces/:wsId/peons/recruit",
    withWorkspace(async (req, res, ctx) => {
      const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim() : null;
      const address = typeof req.body?.address === "string" ? req.body.address.trim() : "";
      const secret = typeof req.body?.secret === "string" ? req.body.secret.trim() : "";
      if (!address || !secret) return res.status(400).json({ error: "peon address and pairing secret are required", code: "BAD_REQUEST" });
      const baseUrl = normalizePeonUrl(address);
      if (!baseUrl) return res.status(400).json({ error: "that doesn't look like a peon address", code: "BAD_URL" });
      if (!config.peonCallbackUrl) return res.status(400).json({ error: "OVERSEER_PEON_CALLBACK_URL is not set — the overseer doesn't know where peons should phone home", code: "NO_CALLBACK_URL" });

      const { credential, token } = await mintCredential(ctx.workspaceId, label, ctx.userId);
      const r = await callPeon({ baseUrl, token: secret }, "POST", "/enroll", {
        actor: req.user?.email ?? null,
        body: { overseerUrl: config.peonCallbackUrl, overseerToken: token },
        timeoutMs: 8000,
      });
      if (!r.ok) {
        await revokeCredential(ctx.workspaceId, credential.id);
        // Distinguish the failure modes — they need very different fixes.
        const message =
          r.status === 502
            ? "couldn't reach the peon at that address — is it running and reachable from the overseer (tailnet/LAN)?"
            : r.status === 404
              ? "reached the peon, but it doesn't support enrollment yet (no POST /api/v1/enroll)"
              : r.status === 401
                ? "the peon rejected the pairing secret"
                : "the peon refused enrollment";
        return res.status(r.status === 502 ? 502 : 400).json({ error: message, code: "ENROLL_FAILED", detail: r.json });
      }
      const peonId = r.json && typeof r.json === "object" ? (r.json as { peonId?: unknown }).peonId : undefined;
      if (typeof peonId === "string") await bindPeon(credential.id, peonId);
      res.status(201).json({ credential, enrolled: true, peonId: typeof peonId === "string" ? peonId : null });
    }),
  );

  router.get("/workspaces/:wsId/peons", withWorkspace(async (_req, res, ctx) => res.json({ peons: (await registry.list(ctx.workspaceId)).map(toView) })));
  router.delete(
    "/workspaces/:wsId/peons/:id",
    withWorkspace(async (req, res, ctx) => {
      const id = String(req.params.id);
      const record = await registry.get(id);
      if (!record || record.workspaceId !== ctx.workspaceId) return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });
      await revokeCredentialForPeon(ctx.workspaceId, id);
      await registry.remove(id);
      res.json({ ok: true });
    }),
  );

  // Aggregate live status across the workspace's peons (fan-out, scoped).
  router.get(
    "/workspaces/:wsId/status",
    withWorkspace(async (_req, res, ctx) => {
      const peons = await registry.list(ctx.workspaceId);
      const results = await Promise.all(
        peons.map(async (record) => {
          const view = toView(record);
          if (!view.online) return { ...view, status: null, statusError: "offline", lastError: "offline" };
          // Keep this below the dashboard's 5s polling interval so an unreachable
          // peon cannot leave an old online result visible behind stacked requests.
          const r = await callPeon(connOfRecord(record), "GET", "/status", { timeoutMs: 4_000 });
          if (r.ok) return { ...view, status: r.json, statusError: null, lastError: null };

          // A fresh heartbeat only proves that the peon can reach the overseer.
          // The dashboard's status probe also verifies the reverse/control path;
          // if that fails, presenting the peon as online is misleading because no
          // operator action can reach it.
          const lastError =
            r.json && typeof r.json === "object" && "error" in r.json && typeof r.json.error === "string"
              ? r.json.error
              : `status probe failed (${r.status})`;
          return { ...view, online: false, status: null, statusError: r.json, lastError };
        }),
      );
      res.json({ peons: results });
    }),
  );

  // Sessions across the workspace, from the index (paginated, filterable).
  router.get(
    "/workspaces/:wsId/sessions",
    withWorkspace(async (req, res, ctx) => {
      const peonId = typeof req.query.peonId === "string" ? req.query.peonId : undefined;
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const limit = Number.parseInt(String(req.query.limit ?? "50"), 10) || 50;
      const offset = Number.parseInt(String(req.query.offset ?? "0"), 10) || 0;
      const { sessions, total } = await listSessions({ workspaceId: ctx.workspaceId, peonId, status, limit, offset });
      res.json({ sessions, total, limit, offset });
    }),
  );

  const wp = "/workspaces/:wsId/peons/:id";
  router.get(`${wp}/status`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", "/status", { actor: c.actor }), res)));
  // Provider capabilities + the peon's global default feed the session pickers.
  // `agent`, `model`, and `reasoningEffort` already ride
  // the generic body passthrough, so this read is the only new proxy route needed.
  // Peons that predate model selection have no /models route (they answer 404 —
  // or, on some builds, 401 for the unknown path since /status uses the same creds
  // and works). Degrade those to an empty catalog so the client silently hides the
  // picker instead of the browser logging a failed probe on every peon page.
  router.get(`${wp}/models`, withWorkspacePeon(async (_req, res, c) => {
    const r = await callPeon(connOfRecord(c.record), "GET", "/models", { actor: c.actor });
    if (r.status === 404 || r.status === 401) return res.json({ providers: [], defaultModel: null });
    relay(r, res);
  }));
  router.get(`${wp}/sessions`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", "/sessions", { actor: c.actor }), res)));
  router.get(`${wp}/sessions/:sid`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}`, { actor: c.actor }), res)));
  router.get(`${wp}/sessions/:sid/transcript`, withWorkspacePeon(async (req, res, c) => {
    const r = await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}/transcript`, { actor: c.actor });
    const raw = r.json && typeof r.json === "object" ? (r.json as { raw?: unknown }).raw : undefined;
    // Some peon builds fail the whole transcript endpoint when one JSONL row is corrupt.
    // Keep the session page usable; live tail and session metadata still render.
    if (r.status >= 500 && typeof raw === "string" && raw.includes("JSON.parse") && raw.includes("getTranscript")) return res.json({ events: [] });
    relay(r, res);
  }));
  router.post(
    `${wp}/sessions`,
    withWorkspacePeon(async (req, res, c) => {
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
      relay(await callPeon(connOfRecord(c.record), "POST", "/sessions", {
        actor: c.actor,
        body: req.body,
        requestId: typeof requestId === "string" ? requestId : undefined,
      }), res);
    }),
  );
  router.patch(`${wp}/sessions/:sid`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "PATCH", `/sessions/${encodeURIComponent(String(req.params.sid))}`, { actor: c.actor, body: req.body }), res)));
  router.post(`${wp}/sessions/:sid/followup`, withWorkspacePeon(async (req, res, c) => {
    const commandId = req.headers["peon-request-id"];
    if (!validCommandId(commandId)) return res.status(400).json({ error: "Peon-Request-Id must be a non-empty idempotency key of at most 255 characters", code: "BAD_REQUEST" });
    const sid = String(req.params.sid);
    const result = await runIdempotentFollowup(c.record.peonId, sid, commandId, req.body, () =>
      callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(sid)}/followup`, { actor: c.actor, body: req.body, requestId: commandId }),
    );
    relay(result, res);
  }));
  router.post(`${wp}/sessions/:sid/cancel`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(String(req.params.sid))}/cancel`, { actor: c.actor }), res)));
  router.delete(`${wp}/sessions/:sid`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "DELETE", `/sessions/${encodeURIComponent(String(req.params.sid))}`, { actor: c.actor }), res)));
  router.post(`${wp}/control/pause`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", "/control/pause", { actor: c.actor }), res)));
  router.post(`${wp}/control/resume`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", "/control/resume", { actor: c.actor }), res)));
  router.post(`${wp}/control/update`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", "/control/update", { actor: c.actor }), res)));
  router.get(`${wp}/sessions/:sid/stream`, withWorkspacePeon((req, res, c) => proxyStream(connOfRecord(c.record), `/sessions/${encodeURIComponent(String(req.params.sid))}/stream`, res, c.actor)));

  // First-class session artifact previews. These deliberately mirror Peon's
  // session-scoped API instead of reusing the transfer sandbox: preview paths
  // may be absolute and Peon owns all path/session validation.
  router.get(`${wp}/sessions/:sid/file`, withWorkspacePeon(async (req, res, c) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}/file?path=${encodeURIComponent(path)}`, { actor: c.actor }), res);
  }));
  router.get(`${wp}/sessions/:sid/file/raw`, withWorkspacePeon((req, res, c) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    proxyGet(connOfRecord(c.record), `/sessions/${encodeURIComponent(String(req.params.sid))}/file/raw?path=${encodeURIComponent(path)}`, req, res, c.actor);
  }));
  router.get(`${wp}/sessions/:sid/file/stream`, withWorkspacePeon((req, res, c) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    proxyStream(connOfRecord(c.record), `/sessions/${encodeURIComponent(String(req.params.sid))}/file/stream?path=${encodeURIComponent(path)}`, res, c.actor);
  }));
  router.post(`${wp}/sessions/:sid/preview`, withWorkspacePeon(async (req, res, c) => {
    // callPeon maps the signed-in operator to Peon-Actor. The Peon persists and
    // broadcasts the returned normalized preview event.
    relay(await callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(String(req.params.sid))}/preview`, { actor: c.actor, body: req.body }), res);
  }));
  router.post(`${wp}/sessions/:sid/web-preview`, withWorkspacePeon(async (req, res, c) => {
    const htmlPath = typeof req.body?.path === "string" ? req.body.path : "";
    try {
      res.status(201).json(mintWebPreview({
        peonId: c.record.peonId,
        workspaceId: c.record.workspaceId,
        sessionId: String(req.params.sid),
        htmlPath,
        actor: c.actor,
      }));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "invalid HTML preview path", code: "BAD_PREVIEW_PATH" });
    }
  }));

  // Peon detail page — registry view (no fan-out) + proxied projects/settings.
  router.get(wp, withWorkspacePeon(async (_req, res, c) => res.json(toView(c.record))));

  // Edit how the OVERSEER reaches this peon (address + control port). This is
  // overseer-local registry data, not a peon proxy — so it works while the peon is
  // offline/unreachable, which is exactly when you need to fix a bad address. A
  // successful edit warms the session index against the now-reachable peon.
  router.patch(
    wp,
    withWorkspacePeon(async (req, res, c) => {
      const b = req.body ?? {};
      const patch: { address?: string; controlPort?: number } = {};
      if (b.address !== undefined) {
        if (typeof b.address !== "string" || !b.address.trim()) return res.status(400).json({ error: "address must be a non-empty string", code: "BAD_REQUEST" });
        patch.address = b.address.trim();
      }
      if (b.controlPort !== undefined) {
        if (!Number.isInteger(b.controlPort) || b.controlPort < 1 || b.controlPort > 65535) return res.status(400).json({ error: "controlPort must be an integer 1–65535", code: "BAD_REQUEST" });
        patch.controlPort = b.controlPort;
      }
      if (patch.address === undefined && patch.controlPort === undefined) return res.status(400).json({ error: "nothing to update", code: "BAD_REQUEST" });
      const updated = await registry.updateConnection(c.record.peonId, patch);
      if (!updated) return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });
      void reconcilePeon(updated).catch(() => null);
      res.json(toView(updated));
    }),
  );
  // Projects — rollup list + full CRUD/lifecycle proxy. Route order matters: the
  // literal /projects/suggest-dir must precede the /projects/:key param route, and
  // /projects/import must precede POST /projects/:key/* likewise.
  const proj = (key: string) => `/projects/${encodeURIComponent(key)}`;
  router.get(`${wp}/projects`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", "/projects", { actor: c.actor }), res)));
  router.get(`${wp}/projects/suggest-dir`, withWorkspacePeon(async (req, res, c) => {
    const label = typeof req.query.label === "string" ? req.query.label : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/projects/suggest-dir${label ? `?label=${encodeURIComponent(label)}` : ""}`, { actor: c.actor }), res);
  }));
  router.post(`${wp}/projects/import`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", "/projects/import", { actor: c.actor, body: req.body }), res)));
  router.post(`${wp}/projects`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", "/projects", { actor: c.actor, body: req.body }), res)));
  router.get(`${wp}/projects/:key`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", proj(String(req.params.key)), { actor: c.actor }), res)));
  router.patch(`${wp}/projects/:key`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "PATCH", proj(String(req.params.key)), { actor: c.actor, body: req.body }), res)));
  router.delete(`${wp}/projects/:key`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "DELETE", proj(String(req.params.key)), { actor: c.actor }), res)));
  router.get(`${wp}/projects/:key/setup-prompt`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", `${proj(String(req.params.key))}/setup-prompt`, { actor: c.actor }), res)));
  router.post(`${wp}/projects/:key/setup`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", `${proj(String(req.params.key))}/setup`, { actor: c.actor, body: req.body }), res)));
  router.post(`${wp}/projects/:key/verify`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", `${proj(String(req.params.key))}/verify`, { actor: c.actor, body: req.body }), res)));
  // Integrations — catalog reads only (secret-free), the import picker's source.
  router.get(`${wp}/integrations`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", "/integrations", { actor: c.actor }), res)));
  router.get(`${wp}/integrations/:key/projects`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", `/integrations/${encodeURIComponent(String(req.params.key))}/projects`, { actor: c.actor }), res)));
  router.get(`${wp}/settings`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", "/settings", { actor: c.actor }), res)));
  router.patch(`${wp}/settings`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "PATCH", "/settings", { actor: c.actor, body: req.body }), res)));
  router.get(`${wp}/stats`, withWorkspacePeon(async (req, res, c) => {
    const period = typeof req.query.period === "string" ? req.query.period : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/stats${period ? `?period=${encodeURIComponent(period)}` : ""}`, { actor: c.actor }), res);
  }));
  // Keep provider quota probes on separate requests. Some provider CLIs can be
  // slow or unavailable, and neither should hold up the other provider (or the
  // recorded /stats response).
  router.get(`${wp}/quota/:provider`, withWorkspacePeon(async (req, res, c) => {
    const provider = String(req.params.provider);
    if (provider !== "claude-code" && provider !== "codex") {
      return res.status(404).json({ error: "unknown quota provider", code: "UNKNOWN_PROVIDER" });
    }
    const refresh = req.query.refresh === "1" ? "?refresh=1" : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/quota/${provider}${refresh}`, { actor: c.actor }), res);
  }));
  // Capability discovery is provider-scoped for the same reason as quota:
  // either CLI may be slow, so callers must be able to fetch them independently.
  router.get(`${wp}/capabilities/:provider`, withWorkspacePeon(async (req, res, c) => {
    const provider = String(req.params.provider);
    if (provider !== "claude-code" && provider !== "codex") {
      return res.status(404).json({ error: "unknown capabilities provider", code: "UNKNOWN_PROVIDER" });
    }
    const refresh = req.query.refresh === "1" ? "?refresh=1" : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/capabilities/${provider}${refresh}`, { actor: c.actor }), res);
  }));

  // Express's named wildcard does not match an empty path, so expose the root
  // listing explicitly for filesystem pickers before the nested transfer route.
  router.get(`${wp}/files`, withWorkspacePeon((req, res, c) => proxyFileDownload(connOfRecord(c.record), [], req, res, c.actor)));
  router.get(`${wp}/files/{*rest}`, withWorkspacePeon((req, res, c) => proxyFileDownload(connOfRecord(c.record), restSegments(req), req, res, c.actor)));
  router.put(`${wp}/files/{*rest}`, withWorkspacePeon((req, res, c) => proxyFileUpload(connOfRecord(c.record), restSegments(req), req, res, c.actor)));

  // Read-only project file browse — proxied to the peon's per-project files API
  // (sandboxed to the project dir). `?stat=1` ⇒ dir listing / metadata; else content.
  router.get(`${wp}/projects/:key/files/{*rest}`, withWorkspacePeon((req, res, c) => {
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    proxyGet(connOfRecord(c.record), `/projects/${encodeURIComponent(String(req.params.key))}/files/${rest}${qs}`, req, res, c.actor);
  }));
  router.put(`${wp}/projects/:key/files/{*rest}`, withWorkspacePeon((req, res, c) => {
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    proxyUpload(connOfRecord(c.record), `/projects/${encodeURIComponent(String(req.params.key))}/files/${rest}`, req, res, c.actor);
  }));

  return router;
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
