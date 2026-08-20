import express from "express";
import {
  PasswordAuthError,
  registerWithPassword,
  setWebSessionCookie,
  signInWithPassword,
} from "../modules/auth/index.js";
import type { PasswordSignInResult } from "../modules/auth/index.js";
import { limited, passwordAuthOpen, tooManyAttempts } from "./authMethodAccess.js";
import { clientInfo } from "./requestContext.js";

// Email + password, beside the redirect doors. A browser gets the same HttpOnly
// cookie they issue and never sees the token; a native client asks for the
// bearer explicitly, exactly as it does after an app-code exchange.

function answer(req: express.Request, res: express.Response, result: PasswordSignInResult, status: number): express.Response {
  const user = { email: result.user.email, githubLogin: result.user.githubLogin, avatarUrl: result.user.avatarUrl };
  if (req.body?.client === "native") return res.status(status).json({ token: result.token, user, device: result.device });
  setWebSessionCookie(res, result.token, result.device.expiresAt);
  return res.status(status).json({ user, device: result.device });
}

function refuse(res: express.Response, err: unknown, operation: string): express.Response {
  if (err instanceof PasswordAuthError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`auth: ${operation} failed:`, err instanceof Error ? err.message : err);
  return res.status(500).json({ error: "sign-in failed", code: "PASSWORD_AUTH_ERROR" });
}

export function mountPasswordSignIn(router: express.Router): void {
  router.post("/auth/password/register", async (req, res) => {
    if (!passwordAuthOpen(res)) return;
    if (limited(req, "password-register", 5)) return tooManyAttempts(res, "sign-up attempts");
    try {
      const result = await registerWithPassword({ email: req.body?.email, password: req.body?.password, invite: req.body?.invite, client: clientInfo(req) });
      return answer(req, res, result, 201);
    } catch (err) {
      return refuse(res, err, "password registration");
    }
  });

  router.post("/auth/password/login", async (req, res) => {
    if (!passwordAuthOpen(res)) return;
    if (limited(req, "password-login", 10)) return tooManyAttempts(res, "sign-in attempts");
    try {
      const result = await signInWithPassword({ email: req.body?.email, password: req.body?.password, client: clientInfo(req) });
      return answer(req, res, result, 200);
    } catch (err) {
      return refuse(res, err, "password sign-in");
    }
  });
}
