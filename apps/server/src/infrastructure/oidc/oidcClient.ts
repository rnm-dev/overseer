import { createHash, randomBytes } from "node:crypto";
import type { OidcAuthSettings } from "../auth/index.js";
import { OidcError, discoverProvider, type OidcProviderMetadata } from "./oidcDiscovery.js";
import { nonceDigest, verifyIdToken, type OidcIdentity } from "./oidcIdToken.js";

// Driving the authorization code flow: build the URL a person is sent to, then
// turn the code they come back with into a verified identity.
//
// PKCE is always sent. This is a confidential client, so it is not strictly
// required, but a code intercepted between the provider and the browser is
// worthless without the verifier, and a provider that ignores the parameters
// is no worse off for receiving them.

const FETCH_TIMEOUT_MS = 10_000;

export interface OidcAuthorization {
  authorizationUrl: string;
  /** Kept server-side for the length of the attempt and never sent to the client. */
  nonceDigest: string;
  codeVerifier: string;
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export async function buildAuthorizationUrl(params: {
  settings: OidcAuthSettings;
  state: string;
}): Promise<OidcAuthorization> {
  const metadata = await discoverProvider(params.settings.issuer);
  // A provider that lists its challenge methods and omits S256 would reject the
  // request it is about to be sent. Say so here, where it is a configuration
  // fault with a name, rather than at the redirect. A provider that lists
  // nothing still gets S256: silence is not a refusal.
  if (metadata.codeChallengeMethods.length > 0 && !metadata.codeChallengeMethods.includes("S256")) {
    throw new OidcError("PROVIDER_MALFORMED", "the provider does not support the S256 code challenge");
  }
  const nonce = randomBytes(32).toString("base64url");
  const { verifier, challenge } = createPkcePair();
  const authorize = new URL(metadata.authorizationEndpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", params.settings.clientId);
  authorize.searchParams.set("redirect_uri", params.settings.redirectUri);
  authorize.searchParams.set("scope", params.settings.scope);
  authorize.searchParams.set("state", params.state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return { authorizationUrl: authorize.toString(), nonceDigest: nonceDigest(nonce), codeVerifier: verifier };
}

async function exchangeCode(
  metadata: OidcProviderMetadata,
  settings: OidcAuthSettings,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: settings.redirectUri,
    client_id: settings.clientId,
    code_verifier: codeVerifier,
  });
  let response: Response;
  try {
    response = await fetch(metadata.tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        // client_secret_basic: the default when a provider advertises no
        // authentication method, and what id.rnm.dev accepts.
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(settings.clientId)}:${encodeURIComponent(settings.clientSecret)}`).toString("base64")}`,
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OidcError("PROVIDER_UNREACHABLE", `the token endpoint could not be reached: ${err instanceof Error ? err.message : err}`);
  }
  const payload = (await response.json().catch(() => null)) as
    | { id_token?: unknown; error?: unknown; error_description?: unknown }
    | null;
  if (!response.ok || !payload) {
    // A reused or expired code lands here. Surface the provider's own reason,
    // never the request that carried our secret.
    const reason = payload && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new OidcError("BAD_CODE", `the provider refused the authorization code (${reason})`);
  }
  if (typeof payload.id_token !== "string" || !payload.id_token) {
    throw new OidcError("NO_ID_TOKEN", "the provider returned no id token — is the openid scope granted?");
  }
  return payload.id_token;
}

/** Code + this attempt's nonce and verifier → the identity the provider asserts. */
export async function exchangeCodeForIdentity(params: {
  settings: OidcAuthSettings;
  code: string;
  expectedNonceDigest: string;
  codeVerifier: string;
  now?: number;
}): Promise<OidcIdentity> {
  const metadata = await discoverProvider(params.settings.issuer, params.now);
  const idToken = await exchangeCode(metadata, params.settings, params.code, params.codeVerifier);
  return verifyIdToken({
    idToken,
    metadata,
    clientId: params.settings.clientId,
    expectedNonceDigest: params.expectedNonceDigest,
    emailClaim: params.settings.emailClaim,
    workspaceClaim: params.settings.workspaceClaim,
    now: params.now,
  });
}
