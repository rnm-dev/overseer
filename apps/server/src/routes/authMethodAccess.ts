import type express from "express";
import type { AuthMethodId, GithubAuthSettings, OidcAuthSettings } from "../infrastructure/auth/index.js";
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

export function tooManyAttempts(res: express.Response, what: string): express.Response {
  return res.status(429).json({ error: `too many ${what}`, code: "RATE_LIMITED" });
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

export function passwordAuthOpen(res: express.Response): boolean {
  if (config.auth.password) return true;
  methodOff(res, "password");
  return false;
}
