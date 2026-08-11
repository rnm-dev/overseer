// The provider's own description of itself, and its signing keys. Both are
// fetched on first use and cached, because they change on the provider's
// timetable and not on ours: an instance that discovers on every sign-in adds a
// round trip and a new way to fail to every attempt.
//
// Only what Overseer actually uses is required to be present. A document
// missing an authorization or token endpoint is not a provider we can drive, and
// saying so at discovery is clearer than a request failing later.

export class OidcError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OidcProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  // Advertised support, used to decide what to send rather than to refuse: a
  // provider that lists nothing still gets our defaults.
  codeChallengeMethods: string[];
}

export interface JsonWebKey {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

const DISCOVERY_TTL_MS = 60 * 60_000;
const JWKS_TTL_MS = 60 * 60_000;
// A signing key that is new to us is a normal event — providers rotate. Refetch
// on an unknown kid, but not more often than this, so an unsigned-by-anyone
// token cannot turn every verification into a request to the provider.
const JWKS_MIN_REFETCH_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

interface CachedDiscovery {
  metadata: OidcProviderMetadata;
  fetchedAt: number;
}

interface CachedKeys {
  keys: JsonWebKey[];
  fetchedAt: number;
}

const discoveryCache = new Map<string, CachedDiscovery>();
const jwksCache = new Map<string, CachedKeys>();

/** Test seam: drop everything remembered about every provider. */
export function resetOidcDiscoveryCache(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

async function fetchJson<T>(url: string, what: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OidcError("PROVIDER_UNREACHABLE", `${what} could not be fetched: ${err instanceof Error ? err.message : err}`);
  }
  if (!response.ok) throw new OidcError("PROVIDER_UNREACHABLE", `${what} returned ${response.status}`);
  try {
    return (await response.json()) as T;
  } catch {
    throw new OidcError("PROVIDER_MALFORMED", `${what} was not JSON`);
  }
}

function requireString(document: Record<string, unknown>, field: string): string {
  const value = document[field];
  if (typeof value !== "string" || !value) {
    throw new OidcError("PROVIDER_MALFORMED", `discovery document has no ${field}`);
  }
  return value;
}

export async function discoverProvider(issuer: string, now = Date.now()): Promise<OidcProviderMetadata> {
  const cached = discoveryCache.get(issuer);
  if (cached && now - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.metadata;

  const document = await fetchJson<Record<string, unknown>>(
    `${issuer}/.well-known/openid-configuration`,
    "the OIDC discovery document",
  );
  const declared = requireString(document, "issuer");
  // A document that names a different issuer than the one we asked is either
  // misconfiguration or someone else's provider answering for it. Either way the
  // `iss` claim we validate against would be meaningless.
  if (declared.replace(/\/+$/, "") !== issuer) {
    throw new OidcError("ISSUER_MISMATCH", `discovery document declares issuer ${declared}, expected ${issuer}`);
  }
  const metadata: OidcProviderMetadata = {
    issuer,
    authorizationEndpoint: requireString(document, "authorization_endpoint"),
    tokenEndpoint: requireString(document, "token_endpoint"),
    jwksUri: requireString(document, "jwks_uri"),
    codeChallengeMethods: Array.isArray(document.code_challenge_methods_supported)
      ? document.code_challenge_methods_supported.filter((value): value is string => typeof value === "string")
      : [],
  };
  discoveryCache.set(issuer, { metadata, fetchedAt: now });
  return metadata;
}

/**
 * The RSA signing key with this `kid`, or the only key present when a provider
 * publishes one and labels nothing. Refetches once for a key we have not seen.
 */
export async function findSigningKey(
  metadata: OidcProviderMetadata,
  kid: string | undefined,
  now = Date.now(),
): Promise<JsonWebKey> {
  const usable = (keys: JsonWebKey[]): JsonWebKey | undefined => {
    const signing = keys.filter((key) => key.kty === "RSA" && (key.use ?? "sig") === "sig");
    if (kid) return signing.find((key) => key.kid === kid);
    return signing.length === 1 ? signing[0] : undefined;
  };

  const cached = jwksCache.get(metadata.jwksUri);
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) {
    const hit = usable(cached.keys);
    if (hit) return hit;
    if (now - cached.fetchedAt < JWKS_MIN_REFETCH_MS) {
      throw new OidcError("UNKNOWN_KEY", `no usable signing key${kid ? ` for kid ${kid}` : ""}`);
    }
  }

  const document = await fetchJson<{ keys?: JsonWebKey[] }>(metadata.jwksUri, "the OIDC signing keys");
  const keys = Array.isArray(document.keys) ? document.keys : [];
  jwksCache.set(metadata.jwksUri, { keys, fetchedAt: now });
  const key = usable(keys);
  if (!key) throw new OidcError("UNKNOWN_KEY", `no usable signing key${kid ? ` for kid ${kid}` : ""}`);
  return key;
}
