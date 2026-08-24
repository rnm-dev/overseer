import type express from "express";
import type { AuthMethodId, GithubAuthSettings, OidcAuthSettings, PasswordAuthSettings } from "../infrastructure/auth/index.js";
import { isAuthMethodEnabled } from "../infrastructure/auth/index.js";
import { config } from "../infrastructure/config/index.js";
import { clientInfo } from "./requestContext.js";

// May this request reach a sign-in route at all — is the method configured, and
// has this address had enough attempts for one minute? Both questions are
// transport admission rather than domain rules, and both are answered the same
// way for every door, so they live together and above the routes themselves.

const attempts = new Map<string, number[]>();

/** True when this address has exceeded `maximum` attempts at `operation` this minute. */
export function limited(req: express.Request, operation: string, maximum: number): boolean {
  const key = `${operation}:${clientInfo(req).ip ?? "unknown"}`;
  const cutoff = Date.now() - 60_000;
  const recent = (attempts.get(key) ?? []).filter((at) => at > cutoff);
  recent.push(Date.now());
  attempts.set(key, recent);
  return recent.length > maximum;
}

/**
 * Forget every recorded attempt.
 *
 * For suites that drive a whole door test by test: the bucket is per address and
 * a test process is one address, so without this a suite grows until one more
 * sign-in test turns an unrelated assertion into `429`. A test that means to
 * exercise the limit still can — it just no longer inherits everyone else's
 * attempts.
 */
export function forgetAttempts(): void {
  attempts.clear();
}

export function tooManyAttempts(res: express.Response, what: string): express.Response {
  return res.status(429).json({ error: `too many ${what}`, code: "RATE_LIMITED" });
}

/**
 * The deep link a native client asked to be sent back to, if this door allows
 * it. Matched exactly against the method's own allowlist — never parsed for a
 * scheme it might resemble — so a request cannot name its own destination.
 */
export function allowedNativeCallback(allowed: string[], value: unknown): string | null {
  if (typeof value !== "string" || !allowed.includes(value)) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

export function invalidCallback(res: express.Response): express.Response {
  return res.status(400).json({ error: "callback is not allowed", code: "INVALID_CALLBACK" });
}

// A door this instance does not have answers the same way wherever it is
// knocked on: 503 with that method's stable code, before the body is read, so a
// correct password or a valid OAuth code on a disabled instance signs nobody in.
const DISABLED: Record<AuthMethodId, { code: string; error: string }> = {
  github: { code: "GITHUB_DISABLED", error: "GitHub sign-in is not configured" },
  password: { code: "PASSWORD_AUTH_DISABLED", error: "email and password sign-in is not enabled" },
  oidc: { code: "OIDC_DISABLED", error: "OIDC sign-in is not configured" },
};

export function methodOff(res: express.Response, method: AuthMethodId): express.Response {
  return res.status(503).json(DISABLED[method]);
}

// Each method's settings, or a refusal already written. Every route reads them
// through its guard rather than re-deciding "configured" from the parts — there
// is one such decision, and it was made in infrastructure/auth.

export function githubApp(res: express.Response): GithubAuthSettings | null {
  const github = config.auth.github;
  if (!github) {
    methodOff(res, "github");
    return null;
  }
  return github;
}

export function oidcProvider(res: express.Response): OidcAuthSettings | null {
  const oidc = config.auth.oidc;
  if (!oidc) {
    methodOff(res, "oidc");
    return null;
  }
  return oidc;
}

export function passwordAuthOpen(res: express.Response): PasswordAuthSettings | null {
  const password = config.auth.password;
  if (!password) {
    methodOff(res, "password");
    return null;
  }
  return password;
}

/**
 * Is the door an already-minted app code came from still open?
 *
 * The native exchange is not a per-provider operation: an app code stands for a
 * sign-in that already happened, and which door produced it is recorded on the
 * code rather than chosen by the caller. But the invariant that switching a
 * method off closes flows already in the air still has to hold, so the door is
 * resolved from the code and *its* guard is the one enforced.
 */
export function methodStillOpen(res: express.Response, method: AuthMethodId): boolean {
  if (isAuthMethodEnabled(config.auth, method)) return true;
  methodOff(res, method);
  return false;
}
