import express from "express";
import { describeAuthMethods } from "../infrastructure/auth/index.js";
import { config } from "../infrastructure/config/index.js";
import {
  clearWebSessionCookie,
  issueWebSocketTicket,
  listDevices,
  requestHasTrustedOrigin,
  revokeDevice,
  setWebSessionCookie,
  verifyDeviceToken,
} from "../modules/auth/index.js";
import { getInvitePreview } from "../modules/workspaces/index.js";
import { mountNativeExchange } from "./authNativeExchange.js";
import { mountPasswordSignIn } from "./authPasswordRoutes.js";
import { mountRedirectSignIn } from "./authRedirectSignIn.js";
import { bearer } from "./requestContext.js";

// PUBLIC auth endpoints — mounted on /api BEFORE operatorAuth: they're how a
// client gets a token. This file composes the doors rather than implementing
// them: the redirect providers live in authRedirectSignIn, email + password in
// authPasswordRoutes, and which of them are open at all in authMethodAccess.
export function publicAuthRouter(): express.Router {
  const router = express.Router();

  // Which doors this instance actually has. The sign-in page renders from this
  // rather than guessing, so switching a method off in the environment removes
  // the form as well as the route behind it.
  router.get("/auth/methods", (_req, res) => {
    res.json(describeAuthMethods(config.auth));
  });

  mountRedirectSignIn(router);
  mountPasswordSignIn(router);
  // Shared by every door: the app code a native sign-in ends with, whichever
  // one minted it.
  mountNativeExchange(router);

  // One-release bridge for existing web sessions. The legacy dashboard proves
  // possession of its localStorage device token once, receives an HttpOnly
  // cookie, then deletes the JavaScript-readable copy.
  router.post("/auth/web-session", async (req, res) => {
    if (!requestHasTrustedOrigin(req)) return res.status(403).json({ error: "trusted request origin required", code: "CSRF_ORIGIN" });
    const token = bearer(req);
    const auth = token ? await verifyDeviceToken(token) : null;
    if (!auth) return res.status(401).json({ error: "authentication required", code: "UNAUTHENTICATED" });
    setWebSessionCookie(res, token);
    res.json({ ok: true });
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
    clearWebSessionCookie(res);
    res.json({ ok: true });
  });

  return router;
}
