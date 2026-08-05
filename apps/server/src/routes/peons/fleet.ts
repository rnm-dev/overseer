import express from "express";
import { config } from "../../infrastructure/config/index.js";
import { registry, toView, type PeonRecord } from "../../registry.js";
import { callPeon, connOfRecord, normalizePeonUrl, PROTOCOL } from "../../infrastructure/peonHttp/index.js";
import { clampRecentSessionsLimit, getSessionCatalogStates, listOperatorRecentSessions, listSessions } from "../../sessionIndex.js";
import { bindPeon, deRecruitPeon, mintCredential, revokeCredential } from "../../credentials.js";
import { ownerOnly, withWorkspace } from "../helpers.js";
import { canAccessPeon, listMemberAccess } from "../../access.js";
import { sessionAttentionStates } from "../../modules/sessions/index.js";

function enrollmentFallback(status: number, code: string): string {
  if (code === "DNS_FAILURE") return "the Peon domain could not be resolved";
  if (code === "CONNECTION_REFUSED") return "Overseer resolved the address but the Peon refused the connection";
  if (code === "CONNECTION_TIMEOUT") return "Overseer resolved the address but timed out connecting to the Peon";
  if (code === "TLS_FAILURE") return "TLS/certificate problem while connecting to the Peon";
  if (status === 401) return "the pairing phrase was rejected or already consumed — arm a new phrase on the Peon and retry";
  if (status === 429) return "too many pairing credentials were rejected — wait briefly before retrying";
  if (status === 404) return "reached the Peon, but it does not support POST /api/v1/enroll";
  return "the Peon refused enrollment";
}
export function registerFleetRoutes(router: express.Router): void {
  // Dry-run connectivity check before recruiting: reach the peon's /status with
  // the pasted pairing secret and read back its identity. Mints nothing, stores
  // nothing — purely to let the operator confirm the address + secret are right.
  router.post(
    "/workspaces/:wsId/peons/connect",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
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

  // Recruit a Peon: Overseer reaches its advertised Tailscale endpoint and pairs it. The
  // operator gives the peon's address + its pairing secret; the overseer mints a
  // workspace-scoped credential and pushes it to the peon's /api/v1/enroll, which
  // makes the peon phone home. Nothing is ever pasted onto the peon by hand.
  router.post(
    "/workspaces/:wsId/peons/recruit",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
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
        const upstream = r.json && typeof r.json === "object" ? r.json as Record<string, unknown> : {};
        const requestId = r.requestId
          ?? (typeof upstream.requestId === "string" ? upstream.requestId : undefined)
          ?? (typeof upstream.correlationId === "string" ? upstream.correlationId : undefined);
        const code = typeof upstream.code === "string" ? upstream.code : r.status === 404 ? "ENROLL_UNSUPPORTED" : "ENROLL_FAILED";
        let error = typeof upstream.error === "string" ? upstream.error : enrollmentFallback(r.status, code);
        if (code === "PROTOCOL_MISMATCH") {
          const peonProtocol = typeof upstream.protocol === "number" ? upstream.protocol : typeof upstream.peonProtocol === "number" ? upstream.peonProtocol : "unknown";
          error = `${error} (Peon protocol ${peonProtocol}; Overseer protocol ${PROTOCOL})`;
        }
        return res.status(r.status).json({ status: r.status, code, error, ...(requestId ? { requestId } : {}) });
      }
      const peonId = r.json && typeof r.json === "object" ? (r.json as { peonId?: unknown }).peonId : undefined;
      let registered = false;
      if (typeof peonId === "string" && peonId.trim()) {
        const id = peonId.trim();
        if (!(await bindPeon(credential.id, id))) {
          await revokeCredential(ctx.workspaceId, credential.id);
          return res.status(409).json({ error: "the minted credential was bound to a different Peon", code: "PEON_ID_MISMATCH" });
        }
        const record = await registry.confirmPairing({ peonId: id, credentialId: credential.id, workspaceId: ctx.workspaceId, token, publicUrl: baseUrl, name: label });
        registered = record.lastSeen > 0;
      }
      res.status(201).json({ credential, enrolled: true, peonId: typeof peonId === "string" ? peonId : null, registered, state: registered ? "paired" : "paired_waiting_registration" });
    }),
  );

  router.get("/workspaces/:wsId/peons", withWorkspace(async (req, res, ctx) => {
    const records = await registry.list(ctx.workspaceId);
    const visible = ctx.role === "owner" ? records : (await Promise.all(records.map(async (record) => await canAccessPeon(ctx.workspaceId, ctx.userId, ctx.role, record.peonId) ? record : null))).filter((record): record is PeonRecord => !!record);
    // Opt-in projection: without it the response shape and cost are unchanged.
    if (req.query.includeRecentSessions !== "mine") return res.json({ peons: visible.map(toView) });
    const recent = await listOperatorRecentSessions({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      peonIds: visible.map((record) => record.peonId),
      limit: clampRecentSessionsLimit(req.query.recentSessionsLimit),
      access: ctx.role === "member" ? { userId: ctx.userId } : undefined,
    });
    res.json({ peons: visible.map((record) => ({ ...toView(record), recentSessions: recent.get(record.peonId) ?? [] })) });
  }));
  router.delete(
    "/workspaces/:wsId/peons/:id",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
      const id = String(req.params.id);
      const record = await registry.get(id);
      if (!record || record.workspaceId !== ctx.workspaceId) return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });
      if (!(await deRecruitPeon(ctx.workspaceId, id))) {
        return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });
      }
      res.json({ ok: true });
    }),
  );

  // Aggregate live status across the workspace's peons (fan-out, scoped).
  router.get(
    "/workspaces/:wsId/status",
    withWorkspace(async (_req, res, ctx) => {
      const allPeons = await registry.list(ctx.workspaceId);
      const peons = ctx.role === "owner" ? allPeons : (await Promise.all(allPeons.map(async (record) => await canAccessPeon(ctx.workspaceId, ctx.userId, ctx.role, record.peonId) ? record : null))).filter((record): record is PeonRecord => !!record);
      const results = await Promise.all(
        peons.map(async (record) => {
          const view = toView(record);
          if (!view.online) return { ...view, status: null, statusError: "offline", lastError: "offline" };
          // Keep this below the dashboard's 5s polling interval so an unreachable
          // peon cannot leave an old online result visible behind stacked requests.
          const r = await callPeon(connOfRecord(record), "GET", "/status", { timeoutMs: 4_000 });
          if (r.ok) return { ...view, status: r.json, statusError: null, lastError: null };

          // Connection presence remains authoritative. A direct Fleet HTTP status
          // probe may fail for a connected Peon behind NAT; expose that as missing
          // detail without flipping it offline.
          const lastError =
            r.json && typeof r.json === "object" && "error" in r.json && typeof r.json.error === "string"
              ? r.json.error
              : `status probe failed (${r.status})`;
          return { ...view, status: null, statusError: r.json, lastError };
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
      // A project page asks for its own sessions rather than filtering whatever
      // page the sidebar happens to hold.
      const projectKey = typeof req.query.projectKey === "string" && req.query.projectKey ? req.query.projectKey : undefined;
      const mine = req.query.mine === "true" || req.query.mine === "1";
      const limit = Number.parseInt(String(req.query.limit ?? "50"), 10) || 50;
      const offset = Number.parseInt(String(req.query.offset ?? "0"), 10) || 0;
      const requestedPerProjectLimit = typeof req.query.perProjectLimit === "string"
        ? Number.parseInt(req.query.perProjectLimit, 10)
        : Number.NaN;
      const perProjectLimit = peonId && Number.isFinite(requestedPerProjectLimit)
        ? Math.min(99, Math.max(1, requestedPerProjectLimit))
        : undefined;
      const { sessions, total } = await listSessions({
        workspaceId: ctx.workspaceId,
        peonId,
        projectKey,
        status,
        authors: mine ? [req.user!.email, req.user!.githubLogin ?? ""] : undefined,
        perPeonLimit: peonId || projectKey ? undefined : 50,
        perProjectLimit,
        limit,
        offset,
        access: ctx.role === "member" ? { userId: ctx.userId } : undefined,
      });
      let catalogs = await getSessionCatalogStates(ctx.workspaceId, peonId);
      if (ctx.role === "member") {
        const allowed = new Set((await listMemberAccess(ctx.workspaceId, ctx.userId)).peonIds);
        catalogs = catalogs.filter((catalog) => allowed.has(catalog.peonId));
      }
      const catalogByPeon = new Map(catalogs.map((catalog) => [catalog.peonId, catalog]));
      const attention = await sessionAttentionStates(ctx.workspaceId, ctx.userId);
      const visibleSessions = sessions.map((session) => {
        const catalog = catalogByPeon.get(session.peonId);
        const attentionState = attention.get(`${session.peonId}\0${session.sessionId}`);
        const attentionUnread = attentionState?.unread ?? false;
        const attentionUpdatedAt = attentionState?.updatedAt ?? 0;
        return catalog ? {
          ...session,
          attentionUnread,
          attentionUpdatedAt,
          catalogState: catalog.state,
          catalogStale: catalog.stale,
          catalogUpdatedAt: catalog.updatedAt,
        } : { ...session, attentionUnread, attentionUpdatedAt };
      });
      res.json({ sessions: visibleSessions, total, limit, offset, catalogs });
    }),
  );
}
