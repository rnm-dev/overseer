import express from "express";
import type { GithubAuthSettings, OidcAuthSettings } from "../infrastructure/auth/index.js";
import { config } from "../infrastructure/config/index.js";
import { GithubAuthError } from "../infrastructure/github/index.js";
import { OidcError } from "../infrastructure/oidc/index.js";
import {
  AccountLinkError,
  completeGithubSignIn,
  completeOidcSignIn,
  consumeOauthAttempt,
  exchangeNativeAppCode,
  setWebSessionCookie,
  startGithubAuthFlow,
  startOidcAuthFlow,
} from "../modules/auth/index.js";
import type { ClientInfo, OAuthProvider, OauthAttempt, OauthStartResult, OAuthSignInCompletion } from "../modules/auth/index.js";
import { githubApp, limited, oidcProvider, tooManyAttempts } from "./authMethodAccess.js";
import { clientInfo } from "./requestContext.js";

// The two redirect doors — GitHub and OIDC — are one shape: start a flow, send
// the person away, take back a code against a single-use state, and end holding
// an account. Everything that differs between them is named once in a
// descriptor below; the routes themselves are written once, here.
//
// This is not deduplication for its own sake. Two hand-written copies of a
// sign-in flow drift, and the half that drifts is usually the error path — the
// one nobody exercises until it matters.

/** What every redirect provider's settings must carry for these routes to work. */
interface RedirectSettings {
  nativeCallbacks: string[];
}

interface RedirectProvider<Settings extends RedirectSettings> {
  provider: OAuthProvider;
  /** The settings, or null with the refusal already written. */
  settings: (res: express.Response) => Settings | null;
  /** Where this provider returns a browser: a page in the SPA. */
  webCallback: () => string;
  /** The provider refused, or the person declined, before we saw a code. */
  denied: { code: string; error: string; nativeError: string };
  start: (params: {
    flow: "web" | "native";
    callback: string;
    settings: Settings;
    // An invitation presented at the start, kept with the attempt so an
    // invite-only instance can still admit an invited person through a flow
    // that creates their account only at the end. OIDC ignores it: its issuer
    // is the invitation.
    inviteToken?: string | null;
  }) => Promise<OauthStartResult>;
  complete: (
    attempt: OauthAttempt,
    state: string,
    code: string,
    settings: Settings,
    client: ClientInfo,
  ) => Promise<OAuthSignInCompletion>;
  /** This provider's own failures → a status and a stable code. */
  refuse: (res: express.Response, err: unknown) => express.Response;
  /** The code a native client receives through its deep link. */
  failureCode: (err: unknown) => string;
}

const GITHUB: RedirectProvider<GithubAuthSettings> = {
  provider: "github",
  settings: githubApp,
  webCallback: () => `${config.publicUrl}/auth/github/callback`,
  denied: { code: "GITHUB_DENIED", error: "GitHub sign-in was denied", nativeError: "github_denied" },
  start: startGithubAuthFlow,
  complete: completeGithubSignIn,
  refuse: (res, err) => {
    if (err instanceof GithubAuthError) return res.status(400).json({ error: err.message, code: err.code });
    console.error("auth: github sign-in failed:", err instanceof Error ? err.message : err);
    return res.status(502).json({ error: "GitHub sign-in failed", code: "GITHUB_ERROR" });
  },
  failureCode: (err) => (err instanceof GithubAuthError ? err.code : "GITHUB_ERROR"),
};

// Unreachable, or describing itself in a way we will not act on, is the
// provider's fault and reads as a bad gateway. Everything else — a spent code, a
// token that does not verify — is this request's fault and reads as a bad
// request. Neither message carries the exchange that held our client secret.
const OIDC_UPSTREAM = new Set(["PROVIDER_UNREACHABLE", "PROVIDER_MALFORMED", "ISSUER_MISMATCH"]);

const OIDC: RedirectProvider<OidcAuthSettings> = {
  provider: "oidc",
  settings: oidcProvider,
  webCallback: () => `${config.publicUrl}/auth/oidc/callback`,
  denied: { code: "OIDC_DENIED", error: "sign-in was denied", nativeError: "oidc_denied" },
  start: startOidcAuthFlow,
  complete: completeOidcSignIn,
  refuse: (res, err) => {
    if (err instanceof OidcError) {
      return res.status(OIDC_UPSTREAM.has(err.code) ? 502 : 400).json({ error: err.message, code: err.code });
    }
    console.error("auth: oidc sign-in failed:", err instanceof Error ? err.message : err);
    return res.status(502).json({ error: "OIDC sign-in failed", code: "OIDC_ERROR" });
  },
  failureCode: (err) => (err instanceof OidcError ? err.code : "OIDC_ERROR"),
};

function allowedNativeCallback(allowed: string[], value: unknown): string | null {
  if (typeof value !== "string" || !allowed.includes(value)) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function webSignIn(res: express.Response, result: Extract<OAuthSignInCompletion, { flow: "web" }>): express.Response {
  setWebSessionCookie(res, result.token, result.device.expiresAt);
  return res.json({
    flow: "web",
    user: { email: result.user.email, githubLogin: result.user.githubLogin, avatarUrl: result.user.avatarUrl },
    device: result.device,
  });
}

// A proved identity that may still not have this account — an unverified
// address, an address already linked elsewhere. The same rules for every door,
// so they are answered before the provider-specific mapping.
function refuseSignIn<S extends RedirectSettings>(provider: RedirectProvider<S>, res: express.Response, err: unknown): express.Response {
  if (err instanceof AccountLinkError) return res.status(400).json({ error: err.message, code: err.code });
  return provider.refuse(res, err);
}

function signInFailureCode<S extends RedirectSettings>(provider: RedirectProvider<S>, err: unknown): string {
  return err instanceof AccountLinkError ? err.code : provider.failureCode(err);
}

function mountRedirectProvider<S extends RedirectSettings>(router: express.Router, provider: RedirectProvider<S>): void {
  const { provider: name } = provider;

  router.post(`/auth/${name}/start`, async (req, res) => {
    if (limited(req, `${name}-start`, 10)) return tooManyAttempts(res, "sign-in attempts");
    const settings = provider.settings(res);
    if (!settings) return;
    try {
      res.json(await provider.start({ flow: "web", callback: provider.webCallback(), settings, inviteToken: text(req.body?.invite) || null }));
    } catch (err) {
      refuseSignIn(provider, res, err);
    }
  });

  router.post(`/auth/${name}/native/start`, async (req, res) => {
    if (limited(req, `${name}-native-start`, 10)) return tooManyAttempts(res, "sign-in attempts");
    const settings = provider.settings(res);
    if (!settings) return;
    const callback = allowedNativeCallback(settings.nativeCallbacks, req.body?.callback);
    if (!callback) return res.status(400).json({ error: "callback is not allowed", code: "INVALID_CALLBACK" });
    try {
      res.json(await provider.start({ flow: "native", callback, settings, inviteToken: text(req.body?.invite) || null }));
    } catch (err) {
      refuseSignIn(provider, res, err);
    }
  });

  // Completion. Turning the method off closes it for flows already in the air,
  // not just for new ones: an outstanding state stops being redeemable.
  router.post(`/auth/${name}`, async (req, res) => {
    const settings = provider.settings(res);
    if (!settings) return;
    const state = text(req.body?.state);
    const code = text(req.body?.code);
    const providerError = text(req.body?.error);
    if (!state || (!code && !providerError)) {
      return res.status(400).json({ error: "state and a code or error are required", code: "BAD_REQUEST" });
    }
    const attempt = await consumeOauthAttempt(state);
    // A state minted at another door is not this door's to redeem, even though
    // both live in one table.
    if (!attempt || attempt.provider !== name) {
      return res.status(400).json({ error: "invalid, expired, or already used state", code: "BAD_STATE" });
    }

    // A native client is waiting on a deep link, not on a status code: every
    // outcome reaches it through the redirect it already expects.
    const nativeRedirect = (error: string): express.Response => {
      const target = new URL(attempt.callbackUrl);
      target.searchParams.set("state", state);
      target.searchParams.set("error", error);
      return res.json({ flow: "native", redirectUrl: target.toString() });
    };

    if (!code) {
      if (attempt.flow === "native") return nativeRedirect(providerError || provider.denied.nativeError);
      return res.status(400).json({ error: provider.denied.error, code: provider.denied.code });
    }
    try {
      const result = await provider.complete(attempt, state, code, settings, clientInfo(req));
      if (result.flow === "native") return res.json({ flow: "native", redirectUrl: result.redirectUrl });
      return webSignIn(res, result);
    } catch (err) {
      if (attempt.flow === "native") return nativeRedirect(signInFailureCode(provider, err));
      return refuseSignIn(provider, res, err);
    }
  });

  // The app code a native flow ended with, redeemed for the device token it
  // stands for. Fenced by provider in the same way its state was.
  router.post(`/auth/${name}/native/exchange`, async (req, res) => {
    if (!provider.settings(res)) return;
    if (limited(req, "native-exchange", 20)) return tooManyAttempts(res, "exchange attempts");
    const state = text(req.body?.state);
    const code = text(req.body?.code);
    if (!state || !code) return res.status(400).json({ error: "code and state are required", code: "BAD_REQUEST" });
    const redeemed = await exchangeNativeAppCode(state, code, name, clientInfo(req));
    if (!redeemed) return res.status(400).json({ error: "invalid, expired, or already used app code", code: "BAD_APP_CODE" });
    return res.json({
      token: redeemed.token,
      user: { email: redeemed.user.email, githubLogin: redeemed.user.githubLogin, avatarUrl: redeemed.user.avatarUrl },
      device: redeemed.device,
    });
  });
}

/** Mount every redirect sign-in door on the public auth router. */
export function mountRedirectSignIn(router: express.Router): void {
  mountRedirectProvider(router, GITHUB);
  mountRedirectProvider(router, OIDC);
}
