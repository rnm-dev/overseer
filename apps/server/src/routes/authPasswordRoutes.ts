import express from "express";
import {
  PasswordAuthError,
  authenticateWithPassword,
  createAccountWithPassword,
  issuePasswordAppCode,
  registerWithPassword,
  setWebSessionCookie,
  signInWithPassword,
} from "../modules/auth/index.js";
import type { PasswordSignInResult, UserRecord } from "../modules/auth/index.js";
import { allowedNativeCallback, invalidCallback, limited, passwordAuthOpen, tooManyAttempts } from "./authMethodAccess.js";
import { clientInfo } from "./requestContext.js";

// Email + password, beside the redirect doors. A browser gets the same HttpOnly
// cookie they issue and never sees the token; a native client asks for the
// bearer explicitly, exactly as it does after an app-code exchange.
//
// A third caller is the app's webview. It opened this page at
// /login?callback=<deep link> precisely because it cannot use a cookie: the
// session belongs to the browser, and the app needs a bearer of its own. So a
// correct password there ends where GitHub and OIDC end — a one-time app code on
// the deep link — rather than rendering the dashboard inside a sign-in sheet
// with no way out. `callback` is what asks for that ending; without it these
// routes are exactly what they were.

/** How this request wants its session back. */
type Ending =
  | { kind: "cookie" }
  | { kind: "bearer" }
  | { kind: "native"; callback: string };

/**
 * Read the ending, or write the refusal.
 *
 * The callback is judged before any credential is, so a build pointed at an
 * instance that does not allow its deep link is told so without a password being
 * hashed — and a misconfigured build gets the same answer whether or not the
 * address it sent exists.
 */
function endingFor(req: express.Request, res: express.Response, allowed: string[]): Ending | null {
  const requested = req.body?.callback;
  if (requested === undefined || requested === null || requested === "") {
    return req.body?.client === "native" ? { kind: "bearer" } : { kind: "cookie" };
  }
  const callback = allowedNativeCallback(allowed, requested);
  if (!callback) {
    invalidCallback(res);
    return null;
  }
  return { kind: "native", callback };
}

function answer(res: express.Response, ending: Ending, result: PasswordSignInResult, status: number): express.Response {
  const user = { email: result.user.email, githubLogin: result.user.githubLogin, avatarUrl: result.user.avatarUrl };
  if (ending.kind === "bearer") return res.status(status).json({ token: result.token, user, device: result.device });
  setWebSessionCookie(res, result.token, result.device.expiresAt);
  return res.status(status).json({ user, device: result.device });
}

/**
 * One correct credential, ended the way this request asked for.
 *
 * The native ending proves the credential and stops there: no cookie, because
 * the browser holding it is the app's sign-in sheet and is about to close, and
 * no device either — that is issued when the app spends the code, to the client
 * that will actually hold it.
 */
async function completeSignIn(
  res: express.Response,
  ending: Ending,
  prove: () => Promise<UserRecord>,
  issue: () => Promise<PasswordSignInResult>,
  status: number,
): Promise<express.Response> {
  if (ending.kind === "native") {
    const user = await prove();
    return res.status(status).json({ flow: "native", redirectUrl: await issuePasswordAppCode(user.id, ending.callback) });
  }
  return answer(res, ending, await issue(), status);
}

function refuse(res: express.Response, err: unknown, operation: string): express.Response {
  if (err instanceof PasswordAuthError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`auth: ${operation} failed:`, err instanceof Error ? err.message : err);
  return res.status(500).json({ error: "sign-in failed", code: "PASSWORD_AUTH_ERROR" });
}

export function mountPasswordSignIn(router: express.Router): void {
  router.post("/auth/password/register", async (req, res) => {
    const settings = passwordAuthOpen(res);
    if (!settings) return;
    if (limited(req, "password-register", 5)) return tooManyAttempts(res, "sign-up attempts");
    const ending = endingFor(req, res, settings.nativeCallbacks);
    if (!ending) return;
    const input = { email: req.body?.email, password: req.body?.password, invite: req.body?.invite };
    try {
      return await completeSignIn(
        res,
        ending,
        () => createAccountWithPassword(input),
        () => registerWithPassword({ ...input, client: clientInfo(req) }),
        201,
      );
    } catch (err) {
      return refuse(res, err, "password registration");
    }
  });

  router.post("/auth/password/login", async (req, res) => {
    const settings = passwordAuthOpen(res);
    if (!settings) return;
    if (limited(req, "password-login", 10)) return tooManyAttempts(res, "sign-in attempts");
    const ending = endingFor(req, res, settings.nativeCallbacks);
    if (!ending) return;
    const input = { email: req.body?.email, password: req.body?.password };
    try {
      return await completeSignIn(
        res,
        ending,
        () => authenticateWithPassword(input),
        () => signInWithPassword({ ...input, client: clientInfo(req) }),
        200,
      );
    } catch (err) {
      return refuse(res, err, "password sign-in");
    }
  });
}
