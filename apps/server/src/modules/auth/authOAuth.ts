import { createHash, randomBytes } from "node:crypto";
import { query } from "../../infrastructure/db/index.js";
import { exchangeCodeForProfile } from "../../infrastructure/github/index.js";
import { ensureDefaultWorkspace } from "../workspaces/index.js";
import { ensureUserFromGithub, getUserById } from "./authUsers.js";
import { issueDevice } from "./authDevices.js";
import type {
  ClientInfo,
  NativeExchangeResult,
  OauthAttempt,
  OAuthFlow,
  OauthStartResult,
  OAuthSignInCompletion,
} from "./authTypes.js";

const OAUTH_STATE_TTL_MS = 5 * 60_000;
const OAUTH_CODE_TTL_MS = 3 * 60_000;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function opaque(): string {
  return randomBytes(32).toString("base64url");
}

export async function startGithubAuthFlow(params: {
  flow: OAuthFlow;
  callback: string;
  githubClientId: string;
  githubScope: string;
  githubRedirectUri: string;
  now?: number;
}): Promise<OauthStartResult> {
  const state = opaque();
  const now = params.now ?? Date.now();
  await query(
    `INSERT INTO oauth_attempts (state_hash, flow, callback_url, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [digest(state), params.flow, params.callback, now, now + OAUTH_STATE_TTL_MS],
  );
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", params.githubClientId);
  authorize.searchParams.set("scope", params.githubScope);
  authorize.searchParams.set("redirect_uri", params.githubRedirectUri);
  authorize.searchParams.set("state", state);
  return { authorizationUrl: authorize.toString(), state };
}

export async function consumeOauthAttempt(state: string, now: number = Date.now()): Promise<OauthAttempt | null> {
  const claimed = await query<{ flow: OAuthFlow; callback_url: string }>(
    `UPDATE oauth_attempts SET completed_at=$2 WHERE state_hash=$1 AND completed_at IS NULL AND expires_at >= $2 RETURNING flow, callback_url`,
    [digest(state), now],
  );
  const row = claimed.rows[0];
  return row ? { flow: row.flow, callbackUrl: row.callback_url } : null;
}

export async function completeGithubSignIn(
  attempt: OauthAttempt,
  state: string,
  code: string,
  githubRedirectUri: string,
  client: ClientInfo,
  now = Date.now(),
): Promise<OAuthSignInCompletion> {
  const profile = await exchangeCodeForProfile(code, githubRedirectUri);
  const user = await ensureUserFromGithub(profile);
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

export async function exchangeNativeAppCode(
  state: string,
  code: string,
  client: ClientInfo,
): Promise<NativeExchangeResult | null> {
  const consumed = await query<{ user_id: string }>(
    `DELETE FROM oauth_attempts WHERE state_hash=$1 AND app_code_hash=$2 AND code_expires_at >= $3 AND flow='native' RETURNING user_id`,
    [digest(state), digest(code), Date.now()],
  );
  const userId = consumed.rows[0]?.user_id;
  if (!userId) return null;
  const user = await getUserById(userId);
  if (!user) return null;
  const { token, device } = await issueDevice(user.id, client.userAgent?.slice(0, 80) ?? null, client);
  return { token, user, device };
}
