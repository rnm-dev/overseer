import express from "express";
import { config } from "../config.js";
import { ensureUserFromGithub, getUserById, issueDevice, listDevices, revokeDevice } from "../auth.js";
import { exchangeCodeForProfile, GithubAuthError } from "../github.js";
import { ensureDefaultWorkspace, getInvitePreview } from "../workspaces.js";
import { clientInfo } from "./helpers.js";
import { createHash, randomBytes } from "node:crypto";
import { query } from "../db.js";

const NATIVE_STATE_TTL_MS = 5 * 60_000;
const NATIVE_CODE_TTL_MS = 3 * 60_000;
const rateBuckets = new Map<string, number[]>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");

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
// client gets a token. The SPA builds GitHub's authorize URL from this config,
// GitHub redirects the browser back to the SPA's /auth/github/callback, and the
// SPA posts the code here.
export function publicAuthRouter(): express.Router {
  const router = express.Router();

  router.get("/auth/github/config", (_req, res) => {
    res.json({ clientId: config.githubClientId, scope: config.githubScope, redirectUri: config.githubRedirectUri });
  });

  router.post("/auth/github", async (req, res) => {
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

  router.post("/auth/github/native/start", async (req, res) => {
    if (limited(req, "native-start", 10)) return res.status(429).json({ error: "too many sign-in attempts", code: "RATE_LIMITED" });
    if (!config.githubClientId || !config.githubClientSecret) return res.status(503).json({ error: "GitHub sign-in is not configured", code: "GITHUB_DISABLED" });
    const callback = nativeCallback(req.body?.callback);
    if (!callback) return res.status(400).json({ error: "callback is not allowed", code: "INVALID_CALLBACK" });
    const state = opaque();
    const now = Date.now();
    await query(`INSERT INTO native_oauth_attempts (state_hash, callback_url, created_at, expires_at) VALUES ($1,$2,$3,$4)`, [digest(state), callback, now, now + NATIVE_STATE_TTL_MS]);
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", config.githubClientId);
    authorize.searchParams.set("scope", config.githubScope);
    authorize.searchParams.set("redirect_uri", config.githubNativeRedirectUri);
    authorize.searchParams.set("state", state);
    res.json({ authorizationUrl: authorize.toString(), state });
  });

  router.get("/auth/github/native/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const now = Date.now();
    const claimed = await query<{ callback_url: string }>(
      `UPDATE native_oauth_attempts SET completed_at=$2 WHERE state_hash=$1 AND completed_at IS NULL AND expires_at >= $2 RETURNING callback_url`,
      [digest(state), now],
    );
    const attempt = claimed.rows[0];
    if (!attempt) return res.status(400).json({ error: "invalid, expired, or already used state", code: "BAD_STATE" });
    const target = new URL(attempt.callback_url);
    target.searchParams.set("state", state);
    if (!code) {
      target.searchParams.set("error", typeof req.query.error === "string" ? req.query.error : "github_denied");
      return res.redirect(302, target.toString());
    }
    try {
      const profile = await exchangeCodeForProfile(code, config.githubNativeRedirectUri);
      const user = await ensureUserFromGithub(profile);
      await ensureDefaultWorkspace(user.id, user.email);
      const appCode = opaque();
      await query(`UPDATE native_oauth_attempts SET app_code_hash=$2, user_id=$3, code_expires_at=$4 WHERE state_hash=$1`, [digest(state), digest(appCode), user.id, Date.now() + NATIVE_CODE_TTL_MS]);
      target.searchParams.set("code", appCode);
      return res.redirect(302, target.toString());
    } catch (err) {
      target.searchParams.set("error", err instanceof GithubAuthError ? err.code : "GITHUB_ERROR");
      return res.redirect(302, target.toString());
    }
  });

  router.post("/auth/github/native/exchange", async (req, res) => {
    if (limited(req, "native-exchange", 20)) return res.status(429).json({ error: "too many exchange attempts", code: "RATE_LIMITED" });
    const state = typeof req.body?.state === "string" ? req.body.state : "";
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    if (!state || !code) return res.status(400).json({ error: "code and state are required", code: "BAD_REQUEST" });
    const consumed = await query<{ user_id: string }>(
      `DELETE FROM native_oauth_attempts WHERE state_hash=$1 AND app_code_hash=$2 AND code_expires_at >= $3 RETURNING user_id`,
      [digest(state), digest(code), Date.now()],
    );
    const userId = consumed.rows[0]?.user_id;
    if (!userId) return res.status(400).json({ error: "invalid, expired, or already used app code", code: "BAD_APP_CODE" });
    const user = await getUserById(userId);
    if (!user) return res.status(400).json({ error: "login user no longer exists", code: "BAD_APP_CODE" });
    const client = clientInfo(req);
    const { token, device } = await issueDevice(user.id, client.userAgent?.slice(0, 80) ?? null, client);
    res.json({ token, user: { email: user.email, githubLogin: user.githubLogin, avatarUrl: user.avatarUrl }, device });
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
    res.json({ user: { email: req.user!.email }, deviceId: req.user!.deviceId });
  });

  router.get("/auth/devices", async (req, res) => {
    res.json({ devices: await listDevices(req.user!.userId) });
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
