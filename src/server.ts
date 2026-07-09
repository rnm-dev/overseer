import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { config } from "./config.js";
import { registry, toView, type PeonLoad, type PeonRecord } from "./registry.js";
import { callPeon, connOfRecord, normalizePeonUrl, proxyStream, proxyGet, proxyFileDownload, proxyFileUpload } from "./peonClient.js";
import { listSessions, reconcilePeon, ingestEvents } from "./sessionIndex.js";
import { appendEvent, broadcast } from "./eventLog.js";
import { bindPeon, mintCredential, resolveCredential, revokeCredential, revokeCredentialForPeon } from "./credentials.js";
import {
  acceptInvite,
  createInvite,
  createWorkspace,
  ensureDefaultWorkspace,
  getInvitePreview,
  listInvites,
  listMembers,
  listWorkspacesForUser,
  membership,
  removeMember,
  revokeInvite,
  type Role,
} from "./workspaces.js";
import {
  type AuthContext,
  ensureUserFromGithub,
  issueDevice,
  listDevices,
  revokeDevice,
  verifyDeviceToken,
} from "./auth.js";
import { exchangeCodeForProfile, GithubAuthError } from "./github.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthContext; // set by operatorAuth
      peonCred?: { id: string; workspaceId: string }; // set by credentialAuth
    }
  }
}

// The overseer's two-sided HTTP surface:
//
//   /agent/v1/peons/*   NORTH-BOUND — called by peons (peonRegistrar.ts). Auth:
//                       the peon's per-peon recruitment credential.
//   /api/*              SOUTH-FACING for operators — the dashboard/mobile control
//                       surface. Auth: a device token. Peon routes are scoped to a
//                       workspace and proxy through to that peon.

function bearer(req: express.Request): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

// Observed source address of a register call = the peon's tailnet IP. Strip the
// IPv4-mapped-IPv6 prefix Node reports for v4 clients so we store a clean
// dotted-quad. This is what makes NAT irrelevant — we never trust a peon's
// self-claimed address, only where its connection actually came from.
function sourceAddress(req: express.Request): string {
  const raw = req.socket.remoteAddress ?? "";
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

// Best-effort client fingerprint recorded on a freshly issued device — honours
// X-Forwarded-For since the app reaches us through nginx/Cloudflare.
function clientInfo(req: express.Request): { ip: string | null; userAgent: string | null } {
  const fwd = req.headers["x-forwarded-for"];
  const ip = (typeof fwd === "string" ? fwd.split(",")[0]?.trim() : null) || sourceAddress(req) || null;
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  return { ip, userAgent: ua };
}

export function createServer(): express.Express {
  const app = express();
  app.use(express.json());

  // API liveness (the SPA is served from "/" in prod; in dev nginx routes "/"
  // to the Vite server, so this stays reachable at /healthz either way).
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // ---- north-bound: peon registration + heartbeat -------------------------
  // Auth is the peon's own recruitment credential (credentials.ts); it also tells
  // us which workspace the peon belongs to.
  const credentialAuth: express.RequestHandler = (req, res, next) => {
    void (async () => {
      const cred = await resolveCredential(bearer(req));
      if (!cred) return res.status(401).json({ error: "invalid or revoked peon credential", code: "UNAUTHENTICATED" });
      req.peonCred = { id: cred.id, workspaceId: cred.workspaceId };
      next();
    })().catch(next);
  };

  app.post("/agent/v1/peons/register", credentialAuth, async (req, res) => {
    const b = req.body ?? {};
    const cred = req.peonCred!;
    if (typeof b.peonId !== "string" || !b.peonId.trim()) return res.status(400).json({ error: "peonId is required", code: "BAD_REQUEST" });
    if (typeof b.controlPort !== "number") return res.status(400).json({ error: "controlPort (number) is required", code: "BAD_REQUEST" });
    const peonId = b.peonId.trim();
    const record = await registry.register({
      peonId,
      credentialId: cred.id,
      workspaceId: cred.workspaceId,
      name: typeof b.name === "string" ? b.name : peonId,
      hostname: typeof b.hostname === "string" ? b.hostname : null,
      address: sourceAddress(req),
      controlPort: b.controlPort,
      protocol: typeof b.protocol === "number" ? b.protocol : null,
      capabilities: Array.isArray(b.capabilities) ? b.capabilities.filter((c: unknown) => typeof c === "string") : [],
      token: bearer(req),
      load: extractLoad(b),
    });
    await bindPeon(cred.id, peonId);
    // Warm the index for this peon without blocking the response.
    void reconcilePeon(record).catch(() => null);
    // Durable peon event — a topology change worth replaying on resume.
    void appendEvent({ workspaceId: record.workspaceId, peonId, kind: "peon", payload: toView(record) }).catch(() => null);
    res.status(201).json(toView(record));
  });

  app.post("/agent/v1/peons/:id/heartbeat", credentialAuth, async (req, res) => {
    const record = await registry.heartbeat(String(req.params.id), req.peonCred!.id, extractLoad(req.body ?? {}));
    // 404 tells the peon we lost it, so it re-registers.
    if (!record) return res.status(404).json({ error: "unknown peon — re-register", code: "UNKNOWN_PEON" });
    // Liveness only — broadcast (no DB row); clients re-derive it from the snapshot.
    broadcast({ workspaceId: record.workspaceId, peonId: record.peonId, kind: "peon", payload: toView(record) });
    res.json(toView(record));
  });

  // Session event push — keeps the index live (peonEventPusher.ts).
  app.post("/agent/v1/peons/:id/events", credentialAuth, async (req, res) => {
    const peonId = String(req.params.id);
    const body = req.body ?? {};
    if (typeof body.epoch !== "string" || !Array.isArray(body.events)) {
      return res.status(400).json({ error: "epoch (string) and events (array) are required", code: "BAD_REQUEST" });
    }
    // Must be a known peon owned by this credential; unknown ⇒ 404 so it re-registers.
    const rec = await registry.get(peonId);
    if (!rec || rec.credentialId !== req.peonCred!.id) return res.status(404).json({ error: "unknown peon — re-register", code: "UNKNOWN_PEON" });
    const events = (body.events as unknown[]).filter(
      (e): e is { seq: number; session: { id: string } } =>
        !!e && typeof (e as { seq?: unknown }).seq === "number" && !!(e as { session?: unknown }).session,
    );
    const result = await ingestEvents(rec.workspaceId, peonId, body.epoch, events);
    res.json({ ok: true, ...result });
  });

  // ---- south-facing: operator + mobile API --------------------------------
  const api = express.Router();

  // The mobile app calls /api/* cross-origin. Auth is a bearer token (never a
  // cookie), so a wildcard origin is safe — there are no ambient credentials to
  // leak. The web dashboard is served same-origin and ignores this.
  api.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Actor,X-Api-Key,Peon-Content-Sha256,Range");
    res.setHeader("Access-Control-Expose-Headers", "Peon-Content-Sha256,Content-Range,Accept-Ranges");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // ---- public auth endpoints (GitHub OAuth) — no operator auth -------------
  // These sit BEFORE operatorAuth: they're how a client gets a token. The SPA
  // builds GitHub's authorize URL from this config, GitHub redirects the browser
  // back to the SPA's /auth/github/callback, and the SPA posts the code here.
  api.get("/auth/github/config", (_req, res) => {
    res.json({ clientId: config.githubClientId, scope: config.githubScope, redirectUri: config.githubRedirectUri });
  });

  api.post("/auth/github", async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    if (!code) return res.status(400).json({ error: "code is required", code: "BAD_REQUEST" });
    if (!config.githubClientId || !config.githubClientSecret) {
      return res.status(503).json({ error: "GitHub sign-in is not configured", code: "GITHUB_DISABLED" });
    }
    try {
      const profile = await exchangeCodeForProfile(code);
      const user = await ensureUserFromGithub(profile);
      // Open sign-up: everyone gets a personal workspace so the app is never empty.
      await ensureDefaultWorkspace(user.id, user.email);
      const client = clientInfo(req);
      const { token, device } = await issueDevice(user.id, client.userAgent?.slice(0, 80) ?? null, client);
      res.json({ token, user: { email: user.email, githubLogin: user.githubLogin, avatarUrl: user.avatarUrl }, device });
    } catch (err) {
      if (err instanceof GithubAuthError) return res.status(400).json({ error: err.message, code: err.code });
      console.error("auth: github sign-in failed:", err instanceof Error ? err.message : err);
      res.status(502).json({ error: "GitHub sign-in failed", code: "GITHUB_ERROR" });
    }
  });

  // Public preview for a /join link — the join page shows which workspace the
  // invite is for before sign-in. No auth: the token itself is the capability.
  api.get("/invites/:token", async (req, res) => {
    const preview = await getInvitePreview(String(req.params.token));
    if (!preview) return res.status(404).json({ error: "invalid or expired invite", code: "INVALID_INVITE" });
    res.json({ workspaceName: preview.workspaceName, role: preview.role });
  });

  // ---- the operator auth guard --------------------------------------------
  const operatorAuth: express.RequestHandler = (req, res, next) => {
    void (async () => {
      const auth = await verifyDeviceToken(bearer(req));
      if (!auth) return res.status(401).json({ error: "authentication required", code: "UNAUTHENTICATED" });
      req.user = auth;
      next();
    })().catch(next);
  };

  api.use(operatorAuth);

  // ---- authenticated auth/account endpoints --------------------------------
  api.get("/auth/me", (req, res) => {
    res.json({ user: { email: req.user!.email }, deviceId: req.user!.deviceId });
  });

  api.get("/auth/devices", async (req, res) => {
    res.json({ devices: await listDevices(req.user!.userId) });
  });

  // Revoke any of my own devices (a lost phone → revoke just that one).
  api.delete("/auth/devices/:id", async (req, res) => {
    const ok = await revokeDevice(req.user!.userId, String(req.params.id));
    if (!ok) return res.status(404).json({ error: "unknown device", code: "UNKNOWN_DEVICE" });
    res.json({ ok: true });
  });

  // Logout = revoke the current device.
  api.post("/auth/logout", async (req, res) => {
    await revokeDevice(req.user!.userId, req.user!.deviceId);
    res.json({ ok: true });
  });

  // ---- workspaces (multi-tenant ACL) --------------------------------------
  // Routes under /workspaces/:wsId require membership — the ACL gate.
  const userOf = (req: express.Request): AuthContext => req.user!;

  api.get("/workspaces", async (req, res) => {
    res.json({ workspaces: await listWorkspacesForUser(userOf(req).userId) });
  });

  api.post("/workspaces", async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "name is required", code: "BAD_REQUEST" });
    res.status(201).json({ workspace: await createWorkspace(name, userOf(req).userId) });
  });

  // Membership gate for a specific workspace — attaches the caller's role.
  const withWorkspace =
    (handler: (req: express.Request, res: express.Response, ctx: { workspaceId: string; userId: string; role: Role }) => unknown): express.RequestHandler =>
    async (req, res) => {
      const user = userOf(req);
      const workspaceId = String(req.params.wsId);
      const role = await membership(workspaceId, user.userId);
      if (!role) return res.status(404).json({ error: "unknown workspace", code: "UNKNOWN_WORKSPACE" });
      return handler(req, res, { workspaceId, userId: user.userId, role });
    };
  const ownerOnly = (res: express.Response, role: Role): boolean => {
    if (role !== "owner") {
      res.status(403).json({ error: "owner only", code: "FORBIDDEN" });
      return false;
    }
    return true;
  };

  // Members
  api.get("/workspaces/:wsId/members", withWorkspace(async (_req, res, ctx) => res.json({ members: await listMembers(ctx.workspaceId) })));
  api.delete(
    "/workspaces/:wsId/members/:userId",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
      const ok = await removeMember(ctx.workspaceId, String(req.params.userId));
      if (!ok) return res.status(404).json({ error: "not a member", code: "UNKNOWN_MEMBER" });
      res.json({ ok: true });
    }),
  );

  // Invite links — owner-only (they carry a join capability). People join by
  // opening the link, which posts to /invites/:token/accept below.
  api.get(
    "/workspaces/:wsId/invites",
    withWorkspace(async (_req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
      res.json({ invites: await listInvites(ctx.workspaceId) });
    }),
  );
  api.post(
    "/workspaces/:wsId/invites",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
      const role: Role = req.body?.role === "owner" ? "owner" : "member";
      res.status(201).json({ invite: await createInvite(ctx.workspaceId, role, ctx.userId) });
    }),
  );
  api.delete(
    "/workspaces/:wsId/invites/:id",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
      const ok = await revokeInvite(ctx.workspaceId, String(req.params.id));
      if (!ok) return res.status(404).json({ error: "unknown invite", code: "UNKNOWN_INVITE" });
      res.json({ ok: true });
    }),
  );

  // Accept an invite (authenticated) — the /join page posts here after sign-in.
  api.post("/invites/:token/accept", async (req, res) => {
    const result = await acceptInvite(String(req.params.token), userOf(req).userId);
    if (!result.ok) return res.status(404).json({ error: "invalid or expired invite", code: "INVALID_INVITE" });
    res.json({ workspace: result.workspace, alreadyMember: result.alreadyMember });
  });

  // ---- peons in a workspace (registry-backed, scoped by membership) --------
  const relay = (result: { status: number; json: unknown }, res: express.Response) => res.status(result.status).json(result.json);

  // Dry-run connectivity check before recruiting: reach the peon's /status with
  // the pasted pairing secret and read back its identity. Mints nothing, stores
  // nothing — purely to let the operator confirm the address + secret are right.
  api.post(
    "/workspaces/:wsId/peons/connect",
    withWorkspace(async (req, res) => {
      const address = typeof req.body?.address === "string" ? req.body.address.trim() : "";
      const secret = typeof req.body?.secret === "string" ? req.body.secret.trim() : "";
      if (!address || !secret) return res.status(400).json({ error: "peon address and pairing secret are required", code: "BAD_REQUEST" });
      const baseUrl = normalizePeonUrl(address);
      if (!baseUrl) return res.status(400).json({ error: "that doesn't look like a peon address", code: "BAD_URL" });

      const r = await callPeon({ baseUrl, token: secret }, "GET", "/status", { timeoutMs: 8000 });
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
  // workspace-scoped credential and pushes it to the peon's /agent/v1/enroll, which
  // makes the peon phone home. Nothing is ever pasted onto the peon by hand.
  api.post(
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
              ? "reached the peon, but it doesn't support enrollment yet (no POST /agent/v1/enroll)"
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

  api.get("/workspaces/:wsId/peons", withWorkspace(async (_req, res, ctx) => res.json({ peons: (await registry.list(ctx.workspaceId)).map(toView) })));
  api.delete(
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
  api.get(
    "/workspaces/:wsId/status",
    withWorkspace(async (_req, res, ctx) => {
      const peons = await registry.list(ctx.workspaceId);
      const results = await Promise.all(
        peons.map(async (record) => {
          const view = toView(record);
          if (!view.online) return { ...view, status: null, statusError: "offline" };
          const r = await callPeon(connOfRecord(record), "GET", "/status");
          return r.ok ? { ...view, status: r.json, statusError: null } : { ...view, status: null, statusError: r.json };
        }),
      );
      res.json({ peons: results });
    }),
  );

  // Sessions across the workspace, from the index (paginated, filterable).
  api.get(
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

  // Proxy to one peon in the workspace — membership + ownership enforced first.
  const withWorkspacePeon =
    (handler: (req: express.Request, res: express.Response, ctx: { record: PeonRecord; actor: string | null }) => unknown): express.RequestHandler =>
    withWorkspace(async (req, res, ctx) => {
      const record = await registry.get(String(req.params.id));
      if (!record || record.workspaceId !== ctx.workspaceId) return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });
      return handler(req, res, { record, actor: req.user?.email ?? null });
    });

  const wp = "/workspaces/:wsId/peons/:id";
  api.get(`${wp}/status`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", "/status"), res)));
  // Model catalog + the peon's global default — feeds the per-peon model pickers.
  // `model` on create/followup and `aiDefaultModel` on PATCH /settings already ride
  // the generic body passthrough, so this read is the only new proxy route needed.
  // Peons that predate model selection have no /models route (they answer 404 —
  // or, on some builds, 401 for the unknown path since /status uses the same creds
  // and works). Degrade those to an empty catalog so the client silently hides the
  // picker instead of the browser logging a failed probe on every peon page.
  api.get(`${wp}/models`, withWorkspacePeon(async (_req, res, c) => {
    const r = await callPeon(connOfRecord(c.record), "GET", "/models");
    if (r.status === 404 || r.status === 401) return res.json({ providers: [], defaultModel: null });
    relay(r, res);
  }));
  api.get(`${wp}/sessions`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", "/sessions"), res)));
  api.get(`${wp}/sessions/:sid`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}`), res)));
  api.get(`${wp}/sessions/:sid/transcript`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}/transcript`), res)));
  api.post(
    `${wp}/sessions`,
    withWorkspacePeon(async (req, res, c) => {
      // Control plane owns admission (PROTOCOL: "control plane owns admission"). A
      // peon can be online yet have a broken/unauthenticated Claude CLI — it would
      // accept the session and then fail every run. Refuse to route new work there.
      // Older peons that don't report agentAuth (or report "unknown") pass through:
      // we only block on a definitively bad CLI so un-upgraded peons keep working.
      const blocked = await agentAuthBlocked(c.record);
      if (blocked) {
        return res.status(409).json({
          error: blocked === "unauthenticated" ? "this peon's Claude CLI is not signed in — sessions would fail" : "this peon's Claude CLI is broken — sessions would fail",
          code: "AGENT_UNAVAILABLE",
          authState: blocked,
        });
      }
      relay(await callPeon(connOfRecord(c.record), "POST", "/sessions", { actor: c.actor, body: req.body }), res);
    }),
  );
  api.patch(`${wp}/sessions/:sid`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "PATCH", `/sessions/${encodeURIComponent(String(req.params.sid))}`, { actor: c.actor, body: req.body }), res)));
  api.post(`${wp}/sessions/:sid/followup`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(String(req.params.sid))}/followup`, { actor: c.actor, body: req.body }), res)));
  api.post(`${wp}/sessions/:sid/cancel`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(String(req.params.sid))}/cancel`), res)));
  api.delete(`${wp}/sessions/:sid`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "DELETE", `/sessions/${encodeURIComponent(String(req.params.sid))}`, { actor: c.actor }), res)));
  api.post(`${wp}/control/pause`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", "/control/pause"), res)));
  api.post(`${wp}/control/resume`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", "/control/resume"), res)));
  api.get(`${wp}/sessions/:sid/stream`, withWorkspacePeon((req, res, c) => proxyStream(connOfRecord(c.record), `/sessions/${encodeURIComponent(String(req.params.sid))}/stream`, res)));

  // Peon detail page — registry view (no fan-out) + proxied projects/settings.
  api.get(wp, withWorkspacePeon(async (_req, res, c) => res.json(toView(c.record))));

  // Edit how the OVERSEER reaches this peon (address + control port). This is
  // overseer-local registry data, not a peon proxy — so it works while the peon is
  // offline/unreachable, which is exactly when you need to fix a bad address. A
  // successful edit warms the session index against the now-reachable peon.
  api.patch(
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
  api.get(`${wp}/projects`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", "/projects"), res)));
  api.get(`${wp}/projects/suggest-dir`, withWorkspacePeon(async (req, res, c) => {
    const label = typeof req.query.label === "string" ? req.query.label : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/projects/suggest-dir${label ? `?label=${encodeURIComponent(label)}` : ""}`), res);
  }));
  api.post(`${wp}/projects/import`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", "/projects/import", { actor: c.actor, body: req.body }), res)));
  api.post(`${wp}/projects`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", "/projects", { actor: c.actor, body: req.body }), res)));
  api.get(`${wp}/projects/:key`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", proj(String(req.params.key))), res)));
  api.patch(`${wp}/projects/:key`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "PATCH", proj(String(req.params.key)), { actor: c.actor, body: req.body }), res)));
  api.delete(`${wp}/projects/:key`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "DELETE", proj(String(req.params.key)), { actor: c.actor }), res)));
  api.post(`${wp}/projects/:key/setup`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", `${proj(String(req.params.key))}/setup`, { actor: c.actor, body: req.body }), res)));
  api.post(`${wp}/projects/:key/verify`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "POST", `${proj(String(req.params.key))}/verify`, { actor: c.actor }), res)));
  // Integrations — catalog reads only (secret-free), the import picker's source.
  api.get(`${wp}/integrations`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", "/integrations"), res)));
  api.get(`${wp}/integrations/:key/projects`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", `/integrations/${encodeURIComponent(String(req.params.key))}/projects`), res)));
  api.get(`${wp}/settings`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", "/settings"), res)));
  api.patch(`${wp}/settings`, withWorkspacePeon(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "PATCH", "/settings", { body: req.body }), res)));
  api.get(`${wp}/stats`, withWorkspacePeon(async (req, res, c) => {
    const period = typeof req.query.period === "string" ? req.query.period : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/stats${period ? `?period=${encodeURIComponent(period)}` : ""}`), res);
  }));

  const restSegments = (req: express.Request): string[] => (req.params.rest as unknown as string[] | undefined) ?? [];
  api.get(`${wp}/files/{*rest}`, withWorkspacePeon((req, res, c) => proxyFileDownload(connOfRecord(c.record), restSegments(req), req, res)));
  api.put(`${wp}/files/{*rest}`, withWorkspacePeon((req, res, c) => proxyFileUpload(connOfRecord(c.record), restSegments(req), req, res)));

  // Read-only project file browse — proxied to the peon's per-project files API
  // (sandboxed to the project dir). `?stat=1` ⇒ dir listing / metadata; else content.
  api.get(`${wp}/projects/:key/files/{*rest}`, withWorkspacePeon((req, res, c) => {
    const rest = restSegments(req).map(encodeURIComponent).join("/");
    const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    proxyGet(connOfRecord(c.record), `/projects/${encodeURIComponent(String(req.params.key))}/files/${rest}${qs}`, req, res);
  }));

  app.use("/api", api);

  // Production single-container build: serve the compiled React dashboard and
  // fall back to index.html for client-side routes. Inert in dev — there's no
  // web/dist (Vite serves the frontend), and nginx routes "/" to Vite anyway.
  const webDist = path.resolve("web/dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/agent")) return next();
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  return app;
}

// Ask a peon's /status whether its Claude CLI is usable. Returns the offending
// authState ("broken" | "unauthenticated") when new work must NOT be routed there,
// or null when it's fine to proceed — including when we can't tell (peon
// unreachable, no agentAuth field on an older peon, or authState "unknown").
async function agentAuthBlocked(record: PeonRecord): Promise<"broken" | "unauthenticated" | null> {
  const r = await callPeon(connOfRecord(record), "GET", "/status");
  if (!r.ok || !r.json || typeof r.json !== "object") return null;
  const auth = (r.json as { agentAuth?: unknown }).agentAuth;
  const state = auth && typeof auth === "object" ? (auth as { authState?: unknown }).authState : undefined;
  return state === "broken" || state === "unauthenticated" ? state : null;
}

function extractLoad(b: Record<string, unknown>): PeonLoad | null {
  if (typeof b.activeSessions !== "number" || typeof b.paused !== "boolean") return null;
  return { activeSessions: b.activeSessions, paused: b.paused, uptimeSec: typeof b.uptimeSec === "number" ? b.uptimeSec : 0 };
}
