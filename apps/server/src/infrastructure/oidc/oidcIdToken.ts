import { createHash, createPublicKey, createVerify, timingSafeEqual } from "node:crypto";
import { OidcError, findSigningKey, type JsonWebKey, type OidcProviderMetadata } from "./oidcDiscovery.js";

// Local verification of the provider's id token. The token is the whole basis
// for believing who signed in, so it is checked here rather than trusted
// because it arrived over TLS from the token endpoint: signature against the
// discovered JWKS, then issuer, audience, freshness and the nonce we minted.
//
// RS256 only. It is what id.rnm.dev signs with, it is the one algorithm every
// OIDC provider must support, and an allowlist of one is how `alg: "none"` and
// the HMAC-with-the-public-key confusion stop being possible at all.
//
// Verification is node:crypto over the published JWK rather than a JWT
// dependency, the same call the codebase already makes for scrypt.

const CLOCK_SKEW_MS = 60_000;
// A token older than this is not fresh enough to start a session, whatever its
// own expiry says.
const MAX_AGE_MS = 10 * 60_000;

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

interface IdTokenClaims {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  picture?: unknown;
}

function decodeSegment(segment: string, what: string): Record<string, unknown> {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new OidcError("BAD_ID_TOKEN", `the id token ${what} is not valid JSON`);
  }
}

function verifySignature(key: JsonWebKey, signingInput: string, signature: Buffer): void {
  if (key.kty !== "RSA" || !key.n || !key.e) {
    throw new OidcError("UNKNOWN_KEY", "the signing key is not an RSA public key");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
  } catch {
    throw new OidcError("UNKNOWN_KEY", "the signing key could not be read");
  }
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();
  if (!verifier.verify(publicKey, signature)) {
    throw new OidcError("BAD_ID_TOKEN", "the id token signature does not verify");
  }
}

function seconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OidcError("BAD_ID_TOKEN", `the id token has no usable ${field}`);
  }
  return value * 1000;
}

function audienceAccepts(aud: unknown, clientId: string): boolean {
  if (typeof aud === "string") return aud === clientId;
  return Array.isArray(aud) && aud.some((value) => value === clientId);
}

export function nonceDigest(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

function nonceMatches(claimed: unknown, expectedDigest: string): boolean {
  if (typeof claimed !== "string") return false;
  const a = Buffer.from(nonceDigest(claimed));
  const b = Buffer.from(expectedDigest);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify an id token and return the identity it asserts.
 *
 * The nonce is what makes a token captured from another attempt useless here,
 * so it is required, not optional. Only its digest is passed — and stored — so
 * the binding survives a look at the attempts table.
 */
export async function verifyIdToken(params: {
  idToken: string;
  metadata: OidcProviderMetadata;
  clientId: string;
  expectedNonceDigest: string;
  now?: number;
}): Promise<OidcIdentity> {
  const now = params.now ?? Date.now();
  const parts = params.idToken.split(".");
  if (parts.length !== 3) throw new OidcError("BAD_ID_TOKEN", "the id token is not a signed JWT");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const header = decodeSegment(encodedHeader, "header");
  if (header.alg !== "RS256") {
    throw new OidcError("BAD_ID_TOKEN", `the id token is signed with ${String(header.alg)}, expected RS256`);
  }
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const key = await findSigningKey(params.metadata, kid, now);
  verifySignature(key, `${encodedHeader}.${encodedPayload}`, Buffer.from(encodedSignature, "base64url"));

  const claims = decodeSegment(encodedPayload, "payload") as IdTokenClaims;
  if (claims.iss !== params.metadata.issuer) {
    throw new OidcError("BAD_ID_TOKEN", `the id token was issued by ${String(claims.iss)}, expected ${params.metadata.issuer}`);
  }
  if (!audienceAccepts(claims.aud, params.clientId)) {
    throw new OidcError("BAD_ID_TOKEN", "the id token was issued for another client");
  }
  // With more than one audience the party the token is *for* must say so.
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== params.clientId) {
    throw new OidcError("BAD_ID_TOKEN", "the id token has several audiences and is not authorized for this client");
  }
  if (seconds(claims.exp, "exp") + CLOCK_SKEW_MS <= now) {
    throw new OidcError("BAD_ID_TOKEN", "the id token has expired");
  }
  const issuedAt = seconds(claims.iat, "iat");
  if (issuedAt - CLOCK_SKEW_MS > now) throw new OidcError("BAD_ID_TOKEN", "the id token is issued in the future");
  if (now - issuedAt > MAX_AGE_MS + CLOCK_SKEW_MS) throw new OidcError("BAD_ID_TOKEN", "the id token is too old to start a session");
  if (!nonceMatches(claims.nonce, params.expectedNonceDigest)) {
    throw new OidcError("BAD_ID_TOKEN", "the id token does not carry this attempt's nonce");
  }

  const subject = typeof claims.sub === "string" ? claims.sub : "";
  if (!subject) throw new OidcError("BAD_ID_TOKEN", "the id token has no subject");
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email) throw new OidcError("NO_EMAIL", "the provider returned no email address");

  return {
    issuer: params.metadata.issuer,
    subject,
    email,
    // A provider that omits the claim has not told us the address is verified,
    // and this is the claim account linking depends on — absent means false.
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : null,
    avatarUrl: typeof claims.picture === "string" && claims.picture.trim() ? claims.picture.trim() : null,
  };
}
