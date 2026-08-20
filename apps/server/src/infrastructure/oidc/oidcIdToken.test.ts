import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, test } from "node:test";
import { resetOidcDiscoveryCache, type OidcProviderMetadata } from "./oidcDiscovery.js";
import { nonceDigest, verifyIdToken } from "./oidcIdToken.js";

// A provider we control end to end: its keys are generated here, so a token this
// suite signs is exactly as convincing as a real one, and one it does not sign
// must not be.

const ISSUER = "https://id.example";
const CLIENT_ID = "overseer-test";
const NONCE = "nonce-value";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwk(key: KeyObject, kid: string) {
  return { ...key.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
}

const METADATA: OidcProviderMetadata = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  jwksUri: `${ISSUER}/jwks`,
  codeChallengeMethods: ["S256"],
};

const originalFetch = globalThis.fetch;

function serveKeys(keys: unknown[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), METADATA.jwksUri);
    return Response.json({ keys });
  }) as typeof fetch;
}

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(
  claims: Record<string, unknown>,
  options: { key?: KeyObject; header?: Record<string, unknown> } = {},
): string {
  const header = { alg: "RS256", typ: "JWT", kid: "key-1", ...options.header };
  const body = `${segment(header)}.${segment(claims)}`;
  if (header.alg === "none") return `${body}.`;
  const signer = createSign("RSA-SHA256");
  signer.update(body);
  signer.end();
  return `${body}.${signer.sign(options.key ?? privateKey).toString("base64url")}`;
}

const NOW = 1_800_000_000_000;

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: "user-42",
    aud: CLIENT_ID,
    exp: NOW / 1000 + 300,
    iat: NOW / 1000,
    nonce: NONCE,
    email: "Operator@Example.test",
    email_verified: true,
    name: "Operator",
    picture: "https://id.example/avatar.png",
    ...overrides,
  };
}

function verify(idToken: string, options: { now?: number } = {}) {
  return verifyIdToken({
    idToken,
    metadata: METADATA,
    clientId: CLIENT_ID,
    expectedNonceDigest: nonceDigest(NONCE),
    now: options.now ?? NOW,
  });
}

async function refused(idToken: string, expected: string, now = NOW): Promise<void> {
  await assert.rejects(() => verify(idToken, { now }), (err: Error & { code?: string }) => {
    assert.equal(err.code, expected, `${err.message} (expected ${expected})`);
    return true;
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetOidcDiscoveryCache();
});

test("a well-formed token yields the identity, with the address normalised", async () => {
  serveKeys([jwk(publicKey, "key-1")]);
  const identity = await verify(sign(claims()));
  assert.deepEqual(identity, {
    issuer: ISSUER,
    subject: "user-42",
    email: "operator@example.test",
    emailVerified: true,
    name: "Operator",
    avatarUrl: "https://id.example/avatar.png",
    // No workspace claim was named, so the token asserts no workspaces —
    // whatever else it happens to carry.
    workspaces: [],
  });
});

test("a token signed by another key is refused", async () => {
  serveKeys([jwk(publicKey, "key-1")]);
  await refused(sign(claims(), { key: other.privateKey }), "BAD_ID_TOKEN");
});

test("a tampered payload is refused even though the signature is genuine", async () => {
  serveKeys([jwk(publicKey, "key-1")]);
  const [header, , signature] = sign(claims()).split(".") as [string, string, string];
  await refused(`${header}.${segment(claims({ sub: "someone-else" }))}.${signature}`, "BAD_ID_TOKEN");
});

test("alg is an allowlist of one: none and HS256 never reach a key", async () => {
  serveKeys([jwk(publicKey, "key-1")]);
  await refused(sign(claims(), { header: { alg: "none" } }), "BAD_ID_TOKEN");
  await refused(sign(claims(), { header: { alg: "HS256" } }), "BAD_ID_TOKEN");
});

test("the issuer, the audience and this attempt's nonce must all match", async () => {
  serveKeys([jwk(publicKey, "key-1")]);
  await refused(sign(claims({ iss: "https://id.evil" })), "BAD_ID_TOKEN");
  await refused(sign(claims({ aud: "another-client" })), "BAD_ID_TOKEN");
  await refused(sign(claims({ nonce: "someone-else's-nonce" })), "BAD_ID_TOKEN");
  await refused(sign(claims({ nonce: undefined })), "BAD_ID_TOKEN");
});

test("a multi-audience token must name this client as the authorized party", async () => {
  serveKeys([jwk(publicKey, "key-1")]);
  await refused(sign(claims({ aud: [CLIENT_ID, "other"] })), "BAD_ID_TOKEN");
  const identity = await verify(sign(claims({ aud: [CLIENT_ID, "other"], azp: CLIENT_ID })));
  assert.equal(identity.subject, "user-42");
});

test("expired, future-dated and merely stale tokens are all refused", async () => {
  serveKeys([jwk(publicKey, "key-1")]);
  await refused(sign(claims({ exp: NOW / 1000 - 120 })), "BAD_ID_TOKEN");
  await refused(sign(claims({ iat: NOW / 1000 + 600 })), "BAD_ID_TOKEN");
  // Inside its own expiry, but too old to start a session with.
  await refused(sign(claims({ iat: NOW / 1000 - 3600, exp: NOW / 1000 + 3600 })), "BAD_ID_TOKEN");
});

test("clock skew of under a minute is tolerated at both ends", async () => {
  serveKeys([jwk(publicKey, "key-1")]);
  const justExpired = sign(claims({ exp: NOW / 1000 - 30 }));
  assert.equal((await verify(justExpired)).subject, "user-42");
  const justIssued = sign(claims({ iat: NOW / 1000 + 30 }));
  assert.equal((await verify(justIssued)).subject, "user-42");
});

// Saying nothing and saying no are different statements, and only one of them is
// a refusal. Entra ID never sends the claim at all, and an instance that named
// its issuer has already decided whose directory this is.
test("an absent verification claim is trusted, an explicit denial is not", async () => {
  serveKeys([jwk(publicKey, "key-1")]);
  assert.equal((await verify(sign(claims({ email_verified: false })))).emailVerified, false);
  assert.equal((await verify(sign(claims({ email_verified: undefined })))).emailVerified, true);
  await refused(sign(claims({ email: undefined })), "NO_EMAIL");
});

// `email_verified` describes `email`. Reading the address from somewhere else
// makes it a statement about a value nobody looked at, so it is not consulted.
// `email` first, then the claims a directory uses when an account has no
// mailbox. Nobody configures this — the chain is what makes naming the issuer
// the whole of the configuration.
test("the address falls back through preferred_username and upn", async () => {
  serveKeys([jwk(publicKey, "key-1")]);
  const viaUsername = await verify(sign(claims({ email: undefined, preferred_username: "Someone@Example.test" })));
  assert.equal(viaUsername.email, "someone@example.test");
  const viaUpn = await verify(sign(claims({ email: undefined, upn: "other@example.test" })));
  assert.equal(viaUpn.email, "other@example.test");
  // A display name in preferred_username is skipped rather than coerced.
  const skipped = await verify(sign(claims({ email: undefined, preferred_username: "Some One", upn: "one@example.test" })));
  assert.equal(skipped.email, "one@example.test");
});

// `email_verified` speaks about `email` and nothing else, so an address that
// came from elsewhere is not refused over it.
test("a fallback address ignores the verification claim entirely", async () => {
  serveKeys([jwk(publicKey, "key-1")]);
  const identity = await verify(sign(claims({ email: undefined, email_verified: false, preferred_username: "someone@example.test" })));
  assert.equal(identity.emailVerified, true);
});

test("a token whose key is unknown does not verify, however often it is offered", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return Response.json({ keys: [jwk(publicKey, "key-1")] });
  }) as typeof fetch;
  await refused(sign(claims(), { header: { kid: "rotated-away" } }), "UNKNOWN_KEY");
  await refused(sign(claims(), { header: { kid: "rotated-away" } }), "UNKNOWN_KEY");
  // One refetch for a key we had not seen; the second attempt is answered from
  // cache rather than turning a forged token into traffic at the provider.
  assert.equal(fetches, 1);
});

test("a rotated key is picked up on the next unknown kid", async () => {
  serveKeys([jwk(other.publicKey, "key-2")]);
  const identity = await verify(sign(claims(), { key: other.privateKey, header: { kid: "key-2" } }));
  assert.equal(identity.subject, "user-42");
  assert.notEqual(
    createHash("sha256").update(String(jwk(publicKey, "key-1").n)).digest("hex"),
    createHash("sha256").update(String(jwk(other.publicKey, "key-2").n)).digest("hex"),
  );
});

test("garbage is rejected before any network call", async () => {
  globalThis.fetch = (async () => {
    throw new Error("no network call should be made");
  }) as typeof fetch;
  await refused("not-a-jwt", "BAD_ID_TOKEN");
  await refused("a.b", "BAD_ID_TOKEN");
});
