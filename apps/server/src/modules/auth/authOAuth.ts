import { createHash, randomBytes } from "node:crypto";
import { query } from "../../infrastructure/db/index.js";
import type { GithubAuthSettings, OidcAuthSettings } from "../../infrastructure/auth/index.js";
import { exchangeCodeForProfile } from "../../infrastructure/github/index.js";
import { OidcError, buildAuthorizationUrl, exchangeCodeForIdentity } from "../../infrastructure/oidc/index.js";
import { acceptInvite, ensureDefaultWorkspace, ensureIssuerWorkspace, joinWorkspaceBySlug } from "../workspaces/index.js";
import { mayCreateAccount } from "./signupPolicy.js";
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
  inviteToken?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO oauth_attempts (state_hash, flow, provider, callback_url, created_at, expires_at, nonce_hash, code_verifier, invite_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      digest(params.state),
      params.flow,
      params.provider,
      params.callback,
      params.now,
      params.now + OAUTH_STATE_TTL_MS,
      params.nonceDigest ?? null,
      params.codeVerifier ?? null,
      params.inviteToken ?? null,
    ],
  );
}

export async function startGithubAuthFlow(params: {
  flow: OAuthFlow;
  callback: string;
  settings: GithubAuthSettings;
  // Carried through the redirect because the account is created at the end of a
  // flow that began before anybody could present anything: on an invite-only
  // instance the permission has to travel with the attempt.
  inviteToken?: string | null;
  now?: number;
}): Promise<OauthStartResult> {
  const state = opaque();
  const now = params.now ?? Date.now();
  await recordAttempt({ state, flow: params.flow, provider: "github", callback: params.callback, now, inviteToken: params.inviteToken });
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
    invite_token: string | null;
  }>(
    `UPDATE oauth_attempts SET completed_at=$2 WHERE state_hash=$1 AND completed_at IS NULL AND expires_at >= $2
     RETURNING flow, provider, callback_url, nonce_hash, code_verifier, invite_token`,
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
    inviteToken: row.invite_token,
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
  const user = await ensureUserFromGithub(profile, await mayCreateAccount(attempt.inviteToken));
  // Spent on the account it admitted, so an invited person lands in the
  // workspace they were invited to rather than a personal one.
  if (attempt.inviteToken) await acceptInvite(attempt.inviteToken, user.id);
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

const toList = (value: string | null): string[] => (value ? [value] : []);

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
  const user = await ensureUserFromOidc(identity);
  // Before `finishSignIn`, which falls back to a personal workspace for anyone
  // with no membership at all: an operator arriving through a company's own
  // directory belongs in that company's workspaces, not alone in one named after
  // their address. The token decides when it can — a directory holding several
  // teams says which — and the configured slug is what a token silent on the
  // subject falls back to.
  // The directory's own workspace comes first and needs nothing to exist: the
  // issuer is proven, so the first operator through makes it and owns it, and
  // everyone after joins. Claimed workspaces are a second layer on top, for a
  // directory that holds more than one team.
  if (settings.provisionWorkspace) {
    await ensureIssuerWorkspace(settings.issuer, settings.label, user.id);
  }
  const claimed = identity.workspaces;
  for (const slug of claimed.length > 0 ? claimed : toList(settings.joinWorkspace)) {
    const joined = await joinWorkspaceBySlug(slug, user.id);
    if (joined === "no-such-workspace") {
      // Named but absent. Reported rather than created: a workspace conjured
      // from a claim would turn a mistyped role into a parallel empty workspace
      // beside the real one, and hand workspace creation to whoever sets the
      // claim.
      console.warn(
        `OIDC sign-in named a workspace that does not exist (${slug}) — signing in without it.`,
      );
    }
  }
  return finishSignIn(attempt, state, user, client, now);
}

/**
 * End a correct password in the same place a redirect flow ends: a one-time app
 * code on an allowlisted deep link.
 *
 * There is no state in the air to consume here — the credential was proved in
 * the same request — so the row is written already completed. It exists only to
 * carry the app code, under the same TTL and the same single-use delete every
 * other door's code lives by.
 *
 * The caller has already matched `callback` against this door's allowlist.
 */
export async function issuePasswordAppCode(
  userId: string,
  callback: string,
  now: number = Date.now(),
): Promise<string> {
  const state = opaque();
  const appCode = opaque();
  await query(
    `INSERT INTO oauth_attempts
       (state_hash, flow, provider, callback_url, created_at, expires_at, completed_at, app_code_hash, user_id, code_expires_at)
     VALUES ($1,'native','password',$2,$3,$4,$3,$5,$6,$7)`,
    [
      digest(state),
      callback,
      now,
      now + OAUTH_STATE_TTL_MS,
      digest(appCode),
      userId,
      now + OAUTH_CODE_TTL_MS,
    ],
  );
  const target = new URL(callback);
  target.searchParams.set("state", state);
  target.searchParams.set("code", appCode);
  return target.toString();
}

/**
 * Which door an outstanding app code came from, without spending it.
 *
 * The exchange needs this before it redeems anything: the door is recorded on
 * the code rather than chosen by the caller, and it is that door's guard which
 * decides whether the code is still redeemable. Looking without consuming is
 * safe — the redemption below is a single atomic delete, so a code that passes
 * this check twice is still only spent once.
 */
export async function nativeAppCodeProvider(
  state: string,
  code: string,
  now: number = Date.now(),
): Promise<OAuthProvider | null> {
  const { rows } = await query<{ provider: OAuthProvider }>(
    `SELECT provider FROM oauth_attempts
     WHERE state_hash=$1 AND app_code_hash=$2 AND code_expires_at >= $3 AND flow='native'`,
    [digest(state), digest(code), now],
  );
  return rows[0]?.provider ?? null;
}

/**
 * Redeem a native app code for a device token.
 *
 * Fenced by provider like the state it grew from: an app code minted at one door
 * is not redeemable as another's, so switching a method off closes every stage
 * of its flow rather than all but the last one.
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
