import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { config } from "../infrastructure/config/index.js";
import { initDb, query } from "../infrastructure/db/index.js";
import { resetOidcDiscoveryCache } from "../infrastructure/oidc/index.js";
import { createServer } from "../app/server.js";
import { createWorkspace } from "../modules/workspaces/index.js";
import { forgetAttempts } from "./authMethodAccess.js";

// The whole OIDC door, driven against a provider that exists only here: the
// suite answers discovery, JWKS and the token endpoint, and signs id tokens with
// a key it generates. Everything between the sign-in page and the session cookie
// is the real path.

const ISSUER = "https://id.rnm.test";
const CLIENT_ID = "overseer";
const CLIENT_SECRET = "overseer-secret";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

let server: http.Server;
let port: number;
const originalFetch = globalThis.fetch;
const originalConfig = { publicUrl: config.publicUrl, auth: config.auth };

// What the fake provider will put in the next id token, and what it recorded
// about the request that asked for one.
let issuedNonce: string | null = null;
let lastAuthorizeParams: URLSearchParams | null = null;
let lastTokenRequest: { body: URLSearchParams; authorization: string | null } | null = null;
let claimOverrides: Record<string, unknown> = {};
let challengeMethods: string[] = ["S256"];
let tokenEndpointFailure: { status: number; body: unknown } | null = null;

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function idToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: ISSUER,
    sub: "provider-subject-1",
    aud: CLIENT_ID,
    iat: now,
    exp: now + 300,
    nonce: issuedNonce,
    email: "operator@rnm.test",
    email_verified: true,
    name: "Operator",
    ...claimOverrides,
  };
  const body = `${segment({ alg: "RS256", typ: "JWT", kid: "test-key" })}.${segment(claims)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(body);
  signer.end();
  return `${body}.${signer.sign(privateKey).toString("base64url")}`;
}

before(async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);

  config.publicUrl = "https://overseer.test";
  config.auth = {
    ...config.auth,
    // Both redirect doors open, so the cross-provider test below exercises the
    // fence rather than GitHub being switched off.
    github: {
      clientId: "github-client",
      clientSecret: "github-secret",
      scope: "read:user user:email",
      redirectUri: "https://overseer.test/auth/github/callback",
      nativeCallbacks: ["overseer://oauth/github"],
    },
    oidc: {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: "openid profile email",
      redirectUri: "https://overseer.test/auth/oidc/callback",
      nativeCallbacks: ["overseer://oauth/oidc"],
      label: "id.rnm.test",
      trustEmail: false,
      emailClaim: "email",
      joinWorkspace: null,
      workspaceClaim: null,
      provisionWorkspace: false,
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        code_challenge_methods_supported: challengeMethods,
      });
    }
    if (url === `${ISSUER}/.well-known/jwks.json`) {
      return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" }] });
    }
    if (url === `${ISSUER}/oauth/token`) {
      lastTokenRequest = {
        body: new URLSearchParams(String(init?.body)),
        authorization: new Headers(init?.headers).get("authorization"),
      };
      if (tokenEndpointFailure) {
        return Response.json(tokenEndpointFailure.body, { status: tokenEndpointFailure.status });
      }
      return Response.json({ access_token: "opaque", token_type: "Bearer", id_token: idToken() });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  server = http.createServer(createServer());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  globalThis.fetch = originalFetch;
  Object.assign(config, originalConfig);
  resetOidcDiscoveryCache();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface TestResponse {
  status: number;
  setCookie: string[];
  body: Record<string, unknown>;
}

function request(path: string, method = "GET", body?: unknown): Promise<TestResponse> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: encoded ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) } : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          setCookie: res.headers["set-cookie"] ?? [],
          body: text && res.headers["content-type"]?.includes("json") ? (JSON.parse(text) as Record<string, unknown>) : {},
        });
      });
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

/** Start a flow and act as the provider would: remember the nonce it was sent. */
async function startWeb(): Promise<string> {
  const started = await request("/api/auth/oidc/start", "POST");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const authorize = new URL(started.body.authorizationUrl as string);
  lastAuthorizeParams = authorize.searchParams;
  issuedNonce = authorize.searchParams.get("nonce");
  return started.body.state as string;
}

// Each test starts a flow or two, and the per-address limit is ten starts a
// minute. The limit is real behaviour, but it is not what this suite is about, so
// no test here inherits another's attempts.
beforeEach(forgetAttempts);

test("the sign-in page is told the method exists, and what to call it", async () => {
  const methods = await request("/api/auth/methods");
  assert.equal(methods.body.oidc, true);
  assert.equal(methods.body.oidcLabel, "id.rnm.test");
});

test("a start is built from discovery, with PKCE and a nonce, and secrets stay server-side", async () => {
  const state = await startWeb();
  const params = lastAuthorizeParams!;
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("client_id"), CLIENT_ID);
  assert.equal(params.get("redirect_uri"), "https://overseer.test/auth/oidc/callback");
  assert.equal(params.get("scope"), "openid profile email");
  assert.equal(params.get("state"), state);
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.ok(params.get("code_challenge"));
  assert.ok(params.get("nonce"));
  // Nothing the browser is handed carries the client secret or the verifier.
  const url = params.toString();
  assert.equal(url.includes(CLIENT_SECRET), false);
  assert.equal(url.includes("code_verifier"), false);
});

test("a completed flow verifies the token, creates the account and sets the session cookie", async () => {
  const state = await startWeb();
  const completed = await request("/api/auth/oidc", "POST", { state, code: "provider-code" });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.flow, "web");
  assert.equal((completed.body.user as { email: string }).email, "operator@rnm.test");
  assert.ok(completed.setCookie.some((cookie) => cookie.startsWith("__Host-overseer_session=")));
  assert.equal(completed.setCookie.some((cookie) => cookie.toLowerCase().includes("httponly")), true);

  // The exchange authenticated as the client and returned the PKCE verifier
  // matching the challenge the provider was sent.
  const sent = lastTokenRequest!;
  assert.equal(sent.body.get("grant_type"), "authorization_code");
  assert.equal(sent.body.get("code"), "provider-code");
  assert.ok(sent.body.get("code_verifier"));
  assert.equal(
    sent.authorization,
    `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
  );

  const stored = await query<{ email: string; oidc_issuer: string; oidc_subject: string }>(
    `SELECT email, oidc_issuer, oidc_subject FROM users WHERE email = $1`,
    ["operator@rnm.test"],
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0]!.oidc_issuer, ISSUER);
  assert.equal(stored.rows[0]!.oidc_subject, "provider-subject-1");
});

test("signing in again reuses the same account rather than creating a second", async () => {
  const state = await startWeb();
  const completed = await request("/api/auth/oidc", "POST", { state, code: "provider-code-2" });
  assert.equal(completed.status, 200);
  const stored = await query(`SELECT id FROM users WHERE oidc_subject = $1`, ["provider-subject-1"]);
  assert.equal(stored.rows.length, 1);
});

test("a state is single-use", async () => {
  const state = await startWeb();
  assert.equal((await request("/api/auth/oidc", "POST", { state, code: "one" })).status, 200);
  const replayed = await request("/api/auth/oidc", "POST", { state, code: "one" });
  assert.equal(replayed.status, 400);
  assert.equal(replayed.body.code, "BAD_STATE");
});

test("an OIDC state cannot be redeemed at the GitHub door", async () => {
  const state = await startWeb();
  const crossed = await request("/api/auth/github", "POST", { state, code: "provider-code" });
  assert.equal(crossed.status, 400);
  assert.equal(crossed.body.code, "BAD_STATE");
});

test("an unverified email is refused rather than linked", async () => {
  claimOverrides = { email_verified: false, sub: "unverified-subject", email: "unverified@rnm.test" };
  try {
    const state = await startWeb();
    const refused = await request("/api/auth/oidc", "POST", { state, code: "provider-code" });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "EMAIL_UNVERIFIED");
    const stored = await query(`SELECT id FROM users WHERE email = $1`, ["unverified@rnm.test"]);
    assert.equal(stored.rows.length, 0);
  } finally {
    claimOverrides = {};
  }
});

// Entra ID never sends the claim, and its addresses are the directory's own, so
// an instance pointed at one tenant can vouch for them. The door then signs the
// person in on a token that says nothing about verification — which is why this
// is a switch and not the default.
test("an instance that trusts its issuer signs in an address the token never verified", async () => {
  claimOverrides = { email_verified: undefined, sub: "entra-subject", email: "operator@tenant.test" };
  config.auth.oidc!.trustEmail = true;
  try {
    const state = await startWeb();
    const completed = await request("/api/auth/oidc", "POST", { state, code: "provider-code" });
    assert.equal(completed.status, 200);
    const stored = await query(`SELECT id FROM users WHERE email = $1`, ["operator@tenant.test"]);
    assert.equal(stored.rows.length, 1);
  } finally {
    config.auth.oidc!.trustEmail = false;
    claimOverrides = {};
  }
});

// The mailbox-less tenant, end to end: no `email` anywhere in the token, the
// address taken from the claim the directory does send.
test("an instance can take the address from the claim its provider sends", async () => {
  claimOverrides = {
    email: undefined,
    email_verified: undefined,
    sub: "entra-upn-subject",
    preferred_username: "Operator@tenant.onmicrosoft.test",
  };
  config.auth.oidc!.emailClaim = "preferred_username";
  config.auth.oidc!.trustEmail = true;
  try {
    const state = await startWeb();
    const completed = await request("/api/auth/oidc", "POST", { state, code: "provider-code" });
    assert.equal(completed.status, 200);
    // Stored lowercased, so the same person typing it at another door still meets
    // this account.
    const stored = await query(`SELECT id FROM users WHERE email = $1`, ["operator@tenant.onmicrosoft.test"]);
    assert.equal(stored.rows.length, 1);
  } finally {
    config.auth.oidc!.emailClaim = "email";
    config.auth.oidc!.trustEmail = false;
    claimOverrides = {};
  }
});

// Accounts are found and linked by this value. A claim holding an id rather than
// an address would key them on something no operator could type anywhere else.
test("a claim that does not hold an address is refused, not turned into one", async () => {
  claimOverrides = { email: undefined, sub: "opaque-subject", preferred_username: "not-an-address" };
  config.auth.oidc!.emailClaim = "preferred_username";
  config.auth.oidc!.trustEmail = true;
  try {
    const state = await startWeb();
    const refused = await request("/api/auth/oidc", "POST", { state, code: "provider-code" });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "NO_EMAIL");
  } finally {
    config.auth.oidc!.emailClaim = "email";
    config.auth.oidc!.trustEmail = false;
    claimOverrides = {};
  }
});

// The point of the setting: a company's own directory puts people in the
// company's workspace, instead of each new operator landing alone in one named
// after their address.
test("an operator from the directory joins the configured workspace, not a personal one", async () => {
  const owner = await createWorkspace("Rainmaker", "existing-owner-id");
  claimOverrides = { sub: "joiner-subject", email: "newcomer@rnm.test" };
  config.auth.oidc!.joinWorkspace = owner.slug;
  try {
    const state = await startWeb();
    assert.equal((await request("/api/auth/oidc", "POST", { state, code: "provider-code" })).status, 200);
    const memberships = await query<{ slug: string; role: string; joined_via: string }>(
      `SELECT w.slug, m.role, m.joined_via FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         JOIN users u ON u.id = m.user_id
        WHERE u.oidc_subject = $1`,
      ["joiner-subject"],
    );
    // One membership: the personal-workspace fallback saw one already there.
    assert.deepEqual(memberships.rows, [{ slug: owner.slug, role: "member", joined_via: "sso" }]);
  } finally {
    config.auth.oidc!.joinWorkspace = null;
    claimOverrides = {};
  }
});

// A typo must not be able to lock a directory out of its own instance.
test("a slug naming no workspace still signs the operator in", async () => {
  claimOverrides = { sub: "orphan-subject", email: "orphan@rnm.test" };
  config.auth.oidc!.joinWorkspace = "no-such-workspace-here";
  try {
    const state = await startWeb();
    assert.equal((await request("/api/auth/oidc", "POST", { state, code: "provider-code" })).status, 200);
    const fallback = await query<{ joined_via: string }>(
      `SELECT m.joined_via FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.oidc_subject = $1`,
      ["orphan-subject"],
    );
    assert.deepEqual(fallback.rows, [{ joined_via: "creator" }]);
  } finally {
    config.auth.oidc!.joinWorkspace = null;
    claimOverrides = {};
  }
});

// A directory holding several teams says which one an operator belongs to. The
// value is an app role an administrator assigns, not something its subject can
// set — that is the whole basis on which it is believed.
test("the directory can name the workspace, and several of them", async () => {
  const alpha = await createWorkspace("Alpha", "owner-alpha");
  const beta = await createWorkspace("Beta", "owner-beta");
  claimOverrides = { sub: "multi-team-subject", email: "multi@rnm.test", roles: [alpha.slug, beta.slug] };
  config.auth.oidc!.workspaceClaim = "roles";
  try {
    const state = await startWeb();
    assert.equal((await request("/api/auth/oidc", "POST", { state, code: "provider-code" })).status, 200);
    const rows = await query<{ slug: string; role: string; joined_via: string }>(
      `SELECT w.slug, m.role, m.joined_via FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         JOIN users u ON u.id = m.user_id
        WHERE u.oidc_subject = $1 ORDER BY w.slug`,
      ["multi-team-subject"],
    );
    assert.deepEqual(rows.rows, [
      { slug: alpha.slug, role: "member", joined_via: "sso" },
      { slug: beta.slug, role: "member", joined_via: "sso" },
    ]);
  } finally {
    config.auth.oidc!.workspaceClaim = null;
    claimOverrides = {};
  }
});

// The claim decides when it can; the configured slug is for tokens silent on
// the subject, not a second workspace to add on top.
test("the configured slug is a fallback, not an addition", async () => {
  const fallback = await createWorkspace("Fallback", "owner-fallback");
  const named = await createWorkspace("Named", "owner-named");
  claimOverrides = { sub: "claim-wins-subject", email: "claimwins@rnm.test", roles: named.slug };
  config.auth.oidc!.workspaceClaim = "roles";
  config.auth.oidc!.joinWorkspace = fallback.slug;
  try {
    const state = await startWeb();
    assert.equal((await request("/api/auth/oidc", "POST", { state, code: "provider-code" })).status, 200);
    const rows = await query<{ slug: string }>(
      `SELECT w.slug FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         JOIN users u ON u.id = m.user_id
        WHERE u.oidc_subject = $1`,
      ["claim-wins-subject"],
    );
    assert.deepEqual(rows.rows, [{ slug: named.slug }]);
  } finally {
    config.auth.oidc!.workspaceClaim = null;
    config.auth.oidc!.joinWorkspace = null;
    claimOverrides = {};
  }
});

// A slug nobody created is a typo in a role, not an instruction to invent a
// workspace beside the real one.
test("a claimed workspace that does not exist is not created", async () => {
  claimOverrides = { sub: "ghost-workspace-subject", email: "ghost@rnm.test", roles: ["nowhere-at-all"] };
  config.auth.oidc!.workspaceClaim = "roles";
  try {
    const state = await startWeb();
    assert.equal((await request("/api/auth/oidc", "POST", { state, code: "provider-code" })).status, 200);
    assert.equal((await query(`SELECT 1 FROM workspaces WHERE slug = $1`, ["nowhere-at-all"])).rows.length, 0);
    const rows = await query<{ joined_via: string }>(
      `SELECT m.joined_via FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.oidc_subject = $1`,
      ["ghost-workspace-subject"],
    );
    // Nothing joined, so the personal workspace still happened.
    assert.deepEqual(rows.rows, [{ joined_via: "creator" }]);
  } finally {
    config.auth.oidc!.workspaceClaim = null;
    claimOverrides = {};
  }
});

// A fresh instance has nothing to point a slug at. The directory is the one
// thing already proven, so the first operator through makes its workspace.
test("the first operator from a directory creates its workspace and owns it", async () => {
  claimOverrides = { sub: "founder-subject", email: "founder@rnm.test" };
  config.auth.oidc!.provisionWorkspace = true;
  try {
    const state = await startWeb();
    assert.equal((await request("/api/auth/oidc", "POST", { state, code: "provider-code" })).status, 200);
    const rows = await query<{ name: string; sso_issuer: string; role: string; joined_via: string }>(
      `SELECT w.name, w.sso_issuer, m.role, m.joined_via FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         JOIN users u ON u.id = m.user_id
        WHERE u.oidc_subject = $1`,
      ["founder-subject"],
    );
    // Named after the directory, not after the person, and owned by the person.
    assert.deepEqual(rows.rows, [{ name: "id.rnm.test", sso_issuer: ISSUER, role: "owner", joined_via: "sso" }]);
  } finally {
    config.auth.oidc!.provisionWorkspace = false;
    claimOverrides = {};
  }
});

// Everyone after the first joins what is already there — as a member, and
// without a second workspace appearing beside it.
test("the next operator joins the same workspace as a member", async () => {
  config.auth.oidc!.provisionWorkspace = true;
  try {
    claimOverrides = { sub: "first-subject", email: "first@rnm.test" };
    assert.equal((await request("/api/auth/oidc", "POST", { state: await startWeb(), code: "c1" })).status, 200);
    claimOverrides = { sub: "second-subject", email: "second@rnm.test" };
    assert.equal((await request("/api/auth/oidc", "POST", { state: await startWeb(), code: "c2" })).status, 200);

    const workspaces = await query(`SELECT id FROM workspaces WHERE sso_issuer = $1`, [ISSUER]);
    assert.equal(workspaces.rows.length, 1);
    const roles = await query<{ role: string }>(
      `SELECT m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE u.oidc_subject = $1`,
      ["second-subject"],
    );
    assert.deepEqual(roles.rows, [{ role: "member" }]);
  } finally {
    config.auth.oidc!.provisionWorkspace = false;
    claimOverrides = {};
  }
});

test("a token minted for another attempt does not complete this one", async () => {
  const state = await startWeb();
  issuedNonce = "a-nonce-from-somewhere-else";
  const refused = await request("/api/auth/oidc", "POST", { state, code: "provider-code" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "BAD_ID_TOKEN");
});

test("a provider that refuses the code is reported as a bad code, not a server fault", async () => {
  tokenEndpointFailure = { status: 400, body: { error: "invalid_grant" } };
  try {
    const state = await startWeb();
    const refused = await request("/api/auth/oidc", "POST", { state, code: "already-used" });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "BAD_CODE");
    assert.equal(String(refused.body.error).includes(CLIENT_SECRET), false);
  } finally {
    tokenEndpointFailure = null;
  }
});

test("a native start must name an allowlisted deep link", async () => {
  const refused = await request("/api/auth/oidc/native/start", "POST", { callback: "evil://steal" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "INVALID_CALLBACK");
  const accepted = await request("/api/auth/oidc/native/start", "POST", { callback: "overseer://oauth/oidc" });
  assert.equal(accepted.status, 200);
});

test("with the method switched off every OIDC route is closed", async () => {
  const configured = config.auth;
  config.auth = { ...configured, oidc: null };
  try {
    for (const path of ["/api/auth/oidc/start", "/api/auth/oidc/native/start", "/api/auth/oidc", "/api/auth/oidc/native/exchange"]) {
      const closed = await request(path, "POST", { code: "x", state: "y" });
      assert.equal(closed.status, 503, path);
      assert.equal(closed.body.code, "OIDC_DISABLED", path);
    }
    const methods = await request("/api/auth/methods");
    assert.equal(methods.body.oidc, false);
    assert.equal(methods.body.oidcLabel, null);
  } finally {
    config.auth = configured;
  }
});

test("a native flow's app code is redeemable only at its own door", async () => {
  const started = await request("/api/auth/oidc/native/start", "POST", { callback: "overseer://oauth/oidc" });
  assert.equal(started.status, 200);
  issuedNonce = new URL(started.body.authorizationUrl as string).searchParams.get("nonce");
  const state = started.body.state as string;

  const completed = await request("/api/auth/oidc", "POST", { state, code: "native-provider-code" });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const appCode = new URL(completed.body.redirectUrl as string).searchParams.get("code");
  assert.ok(appCode);

  // The GitHub door is open on this instance, and still cannot spend it.
  const crossed = await request("/api/auth/github/native/exchange", "POST", { state, code: appCode });
  assert.equal(crossed.status, 400);
  assert.equal(crossed.body.code, "BAD_APP_CODE");

  const redeemed = await request("/api/auth/oidc/native/exchange", "POST", { state, code: appCode });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  assert.equal(typeof redeemed.body.token, "string");
});

test("a provider that cannot do S256 is refused at the start, not at the redirect", async () => {
  challengeMethods = ["plain"];
  resetOidcDiscoveryCache();
  try {
    const refused = await request("/api/auth/oidc/start", "POST");
    assert.equal(refused.status, 502);
    assert.equal(refused.body.code, "PROVIDER_MALFORMED");
  } finally {
    challengeMethods = ["S256"];
    resetOidcDiscoveryCache();
  }
});
