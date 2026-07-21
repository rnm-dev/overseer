import express from "express";
import { config } from "../config.js";
import { completeGithubSignIn, consumeOauthAttempt, exchangeNativeAppCode, issueWebSocketTicket, listDevices, revokeDevice, startGithubAuthFlow } from "../modules/auth/index.js";
import { GithubAuthError } from "../github.js";
import { getInvitePreview } from "../workspaces.js";
import { clientInfo } from "./helpers.js";

const rateBuckets = new Map<string, number[]>();

function limited(req: express.Request, operation: string, maximum: number): boolean {
  const key = `${operation}:${clientInfo(req).ip ?? "unknown"}`;
  const cutoff = Date.now() - 60_000;
  const recent = (rateBuckets.get(key) ?? []).filter((at) => at > cutoff);
  recent.push(Date.now());
  rateBuckets.set(key, recent);
  return recent.length > maximum;
}

function nativeCallback(value: unknown): string | null {
  if (typeof value !== "string" || !config.githubNativeCallbacks.includes(value)) return null;
  try { return new URL(value).toString(); } catch { return null; }
}

// PUBLIC auth endpoints — mounted on /api BEFORE operatorAuth: they're how a
// client gets a token. Web and native starts persist an opaque state value and
// send GitHub to the same frontend callback. The SPA submits code + state here;
// the API looks up the flow and either logs in the web client or returns the
// allowlisted native deep link.
export function publicAuthRouter(): express.Router {
  const router = express.Router();

  router.get("/auth/github/config", (_req, res) => {
    res.json({ clientId: config.githubClientId, scope: config.githubScope, redirectUri: config.githubRedirectUri });
  });

  router.post("/auth/github/start", async (req, res) => {
    if (limited(req, "web-start", 10)) return res.status(429).json({ error: "too many sign-in attempts", code: "RATE_LIMITED" });
    if (!config.githubClientId || !config.githubClientSecret) return res.status(503).json({ error: "GitHub sign-in is not configured", code: "GITHUB_DISABLED" });
    res.json(await startGithubAuthFlow({
      flow: "web",
      callback: `${config.publicUrl}/auth/github/callback`,
      githubClientId: config.githubClientId,
      githubScope: config.githubScope,
      githubRedirectUri: config.githubRedirectUri,
    }));
  });

  router.post("/auth/github/native/start", async (req, res) => {
    if (limited(req, "native-start", 10)) return res.status(429).json({ error: "too many sign-in attempts", code: "RATE_LIMITED" });
    if (!config.githubClientId || !config.githubClientSecret) return res.status(503).json({ error: "GitHub sign-in is not configured", code: "GITHUB_DISABLED" });
    const callback = nativeCallback(req.body?.callback);
    if (!callback) return res.status(400).json({ error: "callback is not allowed", code: "INVALID_CALLBACK" });
    res.json(await startGithubAuthFlow({
      flow: "native",
      callback,
      githubClientId: config.githubClientId,
      githubScope: config.githubScope,
      githubRedirectUri: config.githubRedirectUri,
    }));
  });

  router.post("/auth/github", async (req, res) => {
    const state = typeof req.body?.state === "string" ? req.body.state : "";
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    const githubError = typeof req.body?.error === "string" ? req.body.error : "";
    if (!state || (!code && !githubError)) return res.status(400).json({ error: "state and a code or error are required", code: "BAD_REQUEST" });
    const attempt = await consumeOauthAttempt(state);
    if (!attempt) return res.status(400).json({ error: "invalid, expired, or already used state", code: "BAD_STATE" });
    const nativeRedirect = (error: string, appCode?: string): express.Response => {
      const target = new URL(attempt.callbackUrl);
      target.searchParams.set("state", state);
      if (appCode) target.searchParams.set("code", appCode);
      else target.searchParams.set("error", error);
      return res.json({ flow: "native", redirectUrl: target.toString() });
    };

    if (!code) {
      if (attempt.flow === "native") return nativeRedirect(githubError || "github_denied");
      return res.status(400).json({ error: "GitHub sign-in was denied", code: "GITHUB_DENIED" });
    }
    if (attempt.flow !== "web" && attempt.flow !== "native") return res.status(400).json({ error: "invalid OAuth flow", code: "BAD_STATE" });
    try {
      const result = await completeGithubSignIn(attempt, state, code, config.githubRedirectUri, clientInfo(req));
      if (result.flow === "native") return res.json({ flow: "native", redirectUrl: result.redirectUrl });
      return res.json({
        flow: "web",
        token: result.token,
        user: { email: result.user.email, githubLogin: result.user.githubLogin, avatarUrl: result.user.avatarUrl },
        device: result.device,
      });
    } catch (err) {
      if (attempt.flow === "native") return nativeRedirect(err instanceof GithubAuthError ? err.code : "GITHUB_ERROR");
      const error = err instanceof GithubAuthError ? err.code : "GITHUB_ERROR";
      if (err instanceof GithubAuthError) return res.status(400).json({ error: err.message, code: err.code });
      console.error("auth: github sign-in failed:", err instanceof Error ? err.message : err);
      return res.status(502).json({ error: "GitHub sign-in failed", code: error });
    }
  });

  router.post("/auth/github/native/exchange", async (req, res) => {
    if (limited(req, "native-exchange", 20)) return res.status(429).json({ error: "too many exchange attempts", code: "RATE_LIMITED" });
    const state = typeof req.body?.state === "string" ? req.body.state : "";
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    if (!state || !code) return res.status(400).json({ error: "code and state are required", code: "BAD_REQUEST" });
    const redeemed = await exchangeNativeAppCode(state, code, clientInfo(req));
    if (!redeemed) return res.status(400).json({ error: "invalid, expired, or already used app code", code: "BAD_APP_CODE" });
    return res.json({
      token: redeemed.token,
      user: { email: redeemed.user.email, githubLogin: redeemed.user.githubLogin, avatarUrl: redeemed.user.avatarUrl },
      device: redeemed.device,
    });
  });

  // Public preview for a /join link — the join page shows which workspace the
  // invite is for before sign-in. No auth: the token itself is the capability.
  router.get("/invites/:token", async (req, res) => {
    const preview = await getInvitePreview(String(req.params.token));
    if (!preview) return res.status(404).json({ error: "invalid or expired invite", code: "INVALID_INVITE" });
    res.json({ workspaceName: preview.workspaceName, role: preview.role });
  });

  return router;
}

// AUTHENTICATED account endpoints — mounted on /api AFTER operatorAuth.
export function accountRouter(): express.Router {
  const router = express.Router();

  router.get("/auth/me", (req, res) => {
    res.json({
      user: {
        email: req.user!.email,
        githubLogin: req.user!.githubLogin,
        avatarUrl: req.user!.avatarUrl,
      },
      deviceId: req.user!.deviceId,
    });
  });

  router.get("/auth/devices", async (req, res) => {
    res.json({ devices: await listDevices(req.user!.userId) });
  });

  router.post("/auth/ws-ticket", async (req, res) => {
    res.status(201).json(await issueWebSocketTicket(req.user!));
  });

  // Revoke any of my own devices (a lost phone → revoke just that one).
  router.delete("/auth/devices/:id", async (req, res) => {
    const ok = await revokeDevice(req.user!.userId, String(req.params.id));
    if (!ok) return res.status(404).json({ error: "unknown device", code: "UNKNOWN_DEVICE" });
    res.json({ ok: true });
  });

  // Logout = revoke the current device.
  router.post("/auth/logout", async (req, res) => {
    await revokeDevice(req.user!.userId, req.user!.deviceId);
    res.json({ ok: true });
  });

  return router;
}
