import { createHash, randomBytes } from "node:crypto";
import { query } from "../../infrastructure/db/index.js";
import type { GithubAuthSettings, OidcAuthSettings } from "../../infrastructure/auth/index.js";
import { exchangeCodeForProfile } from "../../infrastructure/github/index.js";
import { OidcError, buildAuthorizationUrl, exchangeCodeForIdentity } from "../../infrastructure/oidc/index.js";
import { ensureDefaultWorkspace, joinWorkspaceBySlug } from "../workspaces/index.js";
import { ensureUserFromGithub, ensureUserFromOidc, getUserById } from "./authUsers.js";
import { issueDevice } from "./authDevices.js";
import type {
  ClientInfo,
  NativeExchangeResult,
  OauthAttempt,
  OAuthFlow,
  OAuthProvider,
  OauthStartResult,
  OAuthSignInCompletion,
  UserRecord,
} from "./authTypes.js";

const OAUTH_STATE_TTL_MS = 5 * 60_000;
const OAUTH_CODE_TTL_MS = 3 * 60_000;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function opaque(): string {
  return randomBytes(32).toString("base64url");
}

// One attempt row per sign-in, whichever provider it belongs to. The provider
// is stored rather than inferred from the route that redeems it, so a state
// minted at one door cannot be presented at the other.
async function recordAttempt(params: {
  state: string;
  flow: OAuthFlow;
  provider: OAuthProvider;
  callback: string;
  now: number;
  nonceDigest?: string;
  codeVerifier?: string;
}): Promise<void> {
  await query(
    `INSERT INTO oauth_attempts (state_hash, flow, provider, callback_url, created_at, expires_at, nonce_hash, code_verifier)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      digest(params.state),
      params.flow,
      params.provider,
      params.callback,
      params.now,
      params.now + OAUTH_STATE_TTL_MS,
      params.nonceDigest ?? null,
      params.codeVerifier ?? null,
    ],
  );
}

export async function startGithubAuthFlow(params: {
  flow: OAuthFlow;
  callback: string;
  settings: GithubAuthSettings;
  now?: number;
}): Promise<OauthStartResult> {
  const state = opaque();
  const now = params.now ?? Date.now();
  await recordAttempt({ state, flow: params.flow, provider: "github", callback: params.callback, now });
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", params.settings.clientId);
  authorize.searchParams.set("scope", params.settings.scope);
  authorize.searchParams.set("redirect_uri", params.settings.redirectUri);
  authorize.searchParams.set("state", state);
  return { authorizationUrl: authorize.toString(), state };
}

export async function consumeOauthAttempt(state: string, now: number = Date.now()): Promise<OauthAttempt | null> {
  const claimed = await query<{
    flow: OAuthFlow;
    provider: OAuthProvider;
    callback_url: string;
    nonce_hash: string | null;
    code_verifier: string | null;
  }>(
    `UPDATE oauth_attempts SET completed_at=$2 WHERE state_hash=$1 AND completed_at IS NULL AND expires_at >= $2
     RETURNING flow, provider, callback_url, nonce_hash, code_verifier`,
    [digest(state), now],
  );
  const row = claimed.rows[0];
  if (!row) return null;
  return {
    flow: row.flow,
    provider: row.provider,
    callbackUrl: row.callback_url,
    nonceDigest: row.nonce_hash,
    codeVerifier: row.code_verifier,
  };
}

// Everything after "we know who this is", shared by every provider: the account
// gets its workspace, then either the browser gets a device token or the native
// client gets a one-time app code to exchange for one.
async function finishSignIn(
  attempt: OauthAttempt,
  state: string,
  user: UserRecord,
  client: ClientInfo,
  now: number,
): Promise<OAuthSignInCompletion> {
  await ensureDefaultWorkspace(user.id, user.email);
  if (attempt.flow === "native") {
    const appCode = opaque();
    await query(
      `UPDATE oauth_attempts SET app_code_hash=$2, user_id=$3, code_expires_at=$4 WHERE state_hash=$1`,
      [digest(state), digest(appCode), user.id, now + OAUTH_CODE_TTL_MS],
    );
    const target = new URL(attempt.callbackUrl);
    target.searchParams.set("state", state);
    target.searchParams.set("code", appCode);
    return { flow: "native", redirectUrl: target.toString() };
  }
  if (attempt.flow !== "web") throw new Error(`invalid OAuth flow: ${attempt.flow}`);
  await query(`DELETE FROM oauth_attempts WHERE state_hash=$1`, [digest(state)]);
  const { token, device } = await issueDevice(user.id, client.userAgent?.slice(0, 80) ?? null, client);
  return { flow: "web", token, user, device };
}

export async function completeGithubSignIn(
  attempt: OauthAttempt,
  state: string,
  code: string,
  settings: GithubAuthSettings,
  client: ClientInfo,
  now = Date.now(),
): Promise<OAuthSignInCompletion> {
  const profile = await exchangeCodeForProfile(settings, code);
  const user = await ensureUserFromGithub(profile);
  return finishSignIn(attempt, state, user, client, now);
}

export async function startOidcAuthFlow(params: {
  flow: OAuthFlow;
  callback: string;
  settings: OidcAuthSettings;
  now?: number;
}): Promise<OauthStartResult> {
  const state = opaque();
  const now = params.now ?? Date.now();
  // The provider is asked for the authorization URL before anything is stored:
  // an unreachable or misdescribed provider fails the start, rather than leaving
  // an attempt row nobody will ever redeem.
  const authorization = await buildAuthorizationUrl({ settings: params.settings, state });
  await recordAttempt({
    state,
    flow: params.flow,
    provider: "oidc",
    callback: params.callback,
    now,
    nonceDigest: authorization.nonceDigest,
    codeVerifier: authorization.codeVerifier,
  });
  return { authorizationUrl: authorization.authorizationUrl, state };
}

export async function completeOidcSignIn(
  attempt: OauthAttempt,
  state: string,
  code: string,
  settings: OidcAuthSettings,
  client: ClientInfo,
  now = Date.now(),
): Promise<OAuthSignInCompletion> {
  // An attempt with no nonce or verifier predates this flow or was written by
  // another door; either way it cannot be verified, so it is not completed.
  if (!attempt.nonceDigest || !attempt.codeVerifier) {
    throw new OidcError("BAD_STATE", "this sign-in attempt carries no OIDC binding");
  }
  const identity = await exchangeCodeForIdentity({
    settings,
    code,
    expectedNonceDigest: attempt.nonceDigest,
    codeVerifier: attempt.codeVerifier,
    now,
  });
  if (identity.issuer !== settings.issuer) {
    throw new OidcError("BAD_ID_TOKEN", "the identity was issued by another provider");
  }
  // An instance may vouch for its issuer's addresses when the issuer itself says
  // nothing — a directory whose addresses nobody can self-assert, but whose id
  // tokens omit `email_verified`. It is applied here, at the door, rather than in
  // `verifyIdToken`: token verification should keep reporting what the token
  // actually said, so the trust is visible as a deployment decision and not as a
  // claim the provider never made.
  const user = await ensureUserFromOidc(
    settings.trustEmail ? { ...identity, emailVerified: true } : identity,
  );
  // Before `finishSignIn`, which falls back to a personal workspace for anyone
  // with no membership at all: an operator arriving through a company's own
  // directory belongs in that company's workspace, not alone in one named after
  // their address.
  if (settings.joinWorkspace) {
    const joined = await joinWorkspaceBySlug(settings.joinWorkspace, user.id);
    if (joined === "no-such-workspace") {
      console.warn(
        `OVERSEER_OIDC_JOIN_WORKSPACE names no workspace (${settings.joinWorkspace}) — signing in without it.`,
      );
    }
  }
  return finishSignIn(attempt, state, user, client, now);
}

/**
 * Redeem a native app code for a device token.
 *
 * Fenced by provider like the state it grew from: an app code minted at one door
 * is not redeemable at the other's exchange, so switching a method off closes
 * every stage of its flow rather than all but the last one.
 */
export async function exchangeNativeAppCode(
  state: string,
  code: string,
  provider: OAuthProvider,
  client: ClientInfo,
): Promise<NativeExchangeResult | null> {
  const consumed = await query<{ user_id: string }>(
    `DELETE FROM oauth_attempts
     WHERE state_hash=$1 AND app_code_hash=$2 AND code_expires_at >= $3 AND flow='native' AND provider=$4
     RETURNING user_id`,
    [digest(state), digest(code), Date.now(), provider],
  );
  const userId = consumed.rows[0]?.user_id;
  if (!userId) return null;
  const user = await getUserById(userId);
  if (!user) return null;
  const { token, device } = await issueDevice(user.id, client.userAgent?.slice(0, 80) ?? null, client);
  return { token, user, device };
}
