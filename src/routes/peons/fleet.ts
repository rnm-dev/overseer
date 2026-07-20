import express from "express";
import { config } from "../../config.js";
import { registry, toView, type PeonRecord } from "../../registry.js";
import { callPeon, connOfRecord, normalizePeonUrl, PROTOCOL } from "../../peonClient.js";
import { listSessions } from "../../sessionIndex.js";
import { bindPeon, mintCredential, revokeCredential, revokeCredentialForPeon } from "../../credentials.js";
import { ownerOnly, withWorkspace } from "../helpers.js";
import { canAccessPeon } from "../../access.js";

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

  // Recruit a peon: the overseer reaches out over the tailnet and pairs it. The
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

  router.get("/workspaces/:wsId/peons", withWorkspace(async (_req, res, ctx) => {
    const records = await registry.list(ctx.workspaceId);
    const visible = ctx.role === "owner" ? records : (await Promise.all(records.map(async (record) => await canAccessPeon(ctx.workspaceId, ctx.userId, ctx.role, record.peonId) ? record : null))).filter((record): record is PeonRecord => !!record);
    res.json({ peons: visible.map(toView) });
  }));
  router.delete(
    "/workspaces/:wsId/peons/:id",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
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
      const mine = req.query.mine === "true" || req.query.mine === "1";
      const limit = Number.parseInt(String(req.query.limit ?? "50"), 10) || 50;
      const offset = Number.parseInt(String(req.query.offset ?? "0"), 10) || 0;
      const { sessions, total } = await listSessions({
        workspaceId: ctx.workspaceId,
        peonId,
        status,
        authors: mine ? [req.user!.email, req.user!.githubLogin ?? ""] : undefined,
        perPeonLimit: peonId ? undefined : 50,
        limit,
        offset,
        access: ctx.role === "member" ? { userId: ctx.userId } : undefined,
      });
      res.json({ sessions, total, limit, offset });
    }),
  );
}
