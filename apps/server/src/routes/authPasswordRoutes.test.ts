import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { config } from "../infrastructure/config/index.js";
import { initDb, query } from "../infrastructure/db/index.js";
import { hashPassword, verifyPassword } from "../modules/auth/index.js";
import { createServer } from "../app/server.js";
import { createInvite, createWorkspace } from "../modules/workspaces/index.js";
import { forgetAttempts } from "./authMethodAccess.js";

// Email + password registration and sign-in. Its own file (and so its own
// process) because the routes' rate limiter is per-process and keyed by IP —
// every request here arrives from 127.0.0.1.

let server: http.Server;
let port: number;
const originalPublicUrl = config.publicUrl;
const originalAuth = config.auth;

before(async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.publicUrl = "https://overseer.example";
  config.auth = { ...config.auth, password: true };
  server = http.createServer(createServer());
  port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
});

after(async () => {
  config.publicUrl = originalPublicUrl;
  config.auth = originalAuth;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface TestResponse {
  status: number;
  setCookie: string[];
  body: Record<string, unknown>;
}

function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<TestResponse> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(encoded ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          setCookie: res.headers["set-cookie"] ?? [],
          body: text && res.headers["content-type"]?.includes("json") ? JSON.parse(text) as Record<string, unknown> : {},
        });
      });
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

// Five registrations and ten sign-ins a minute is real behaviour, but it is not
// what this suite is about: without this, adding a test turns an unrelated
// assertion into 429.
beforeEach(forgetAttempts);

test("a scrypt hash verifies its own password and rejects every other", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.ok(stored.startsWith("scrypt$"));
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("correct horse batterz", stored), false);
  assert.equal(await verifyPassword("correct horse battery", "not-a-hash"), false);
  // Two hashes of one password differ: the salt is per-hash, not global.
  assert.notEqual(stored, await hashPassword("correct horse battery"));
});

test("registration creates a cookie web session and never returns the token", async () => {
  const registered = await request("/api/auth/password/register", "POST", { email: "  Founder@Example.Test ", password: "sufficiently-long" });
  assert.equal(registered.status, 201);
  assert.equal((registered.body.user as { email: string }).email, "founder@example.test");
  assert.equal(registered.body.token, undefined);
  assert.equal(registered.setCookie.length, 1);
  assert.match(registered.setCookie[0], /^__Host-overseer_session=/);
  assert.match(registered.setCookie[0], /HttpOnly/);

  // The password is stored hashed, never in the clear.
  const { rows } = await query<{ password_hash: string | null }>(`SELECT password_hash FROM users WHERE email = $1`, ["founder@example.test"]);
  assert.ok(rows[0]?.password_hash?.startsWith("scrypt$"));
  assert.equal(rows[0]?.password_hash?.includes("sufficiently-long"), false);

  // And the account is usable immediately: a default workspace exists.
  const cookie = registered.setCookie[0].split(";")[0];
  const workspaces = await request("/api/workspaces", "GET", undefined, { cookie });
  assert.equal(workspaces.status, 200);
  assert.equal((workspaces.body.workspaces as unknown[]).length, 1);
});

test("the same email cannot be registered twice", async () => {
  const again = await request("/api/auth/password/register", "POST", { email: "FOUNDER@example.test", password: "another-long-one" });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "EMAIL_TAKEN");
});

test("registration refuses a malformed email or a short password", async () => {
  const badEmail = await request("/api/auth/password/register", "POST", { email: "not-an-email", password: "sufficiently-long" });
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.body.code, "INVALID_EMAIL");

  const shortPassword = await request("/api/auth/password/register", "POST", { email: "short@example.test", password: "abc" });
  assert.equal(shortPassword.status, 400);
  assert.equal(shortPassword.body.code, "WEAK_PASSWORD");

  const { rows } = await query(`SELECT id FROM users WHERE email = $1`, ["short@example.test"]);
  assert.equal(rows.length, 0);
});

test("sign-in accepts the registered password and refuses everything else alike", async () => {
  const ok = await request("/api/auth/password/login", "POST", { email: "founder@EXAMPLE.test", password: "sufficiently-long" });
  assert.equal(ok.status, 200);
  assert.equal((ok.body.user as { email: string }).email, "founder@example.test");
  assert.equal(ok.body.token, undefined);
  assert.equal(ok.setCookie.length, 1);

  const wrongPassword = await request("/api/auth/password/login", "POST", { email: "founder@example.test", password: "sufficiently-wrong" });
  const unknownUser = await request("/api/auth/password/login", "POST", { email: "nobody@example.test", password: "sufficiently-long" });
  for (const refused of [wrongPassword, unknownUser]) {
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "INVALID_CREDENTIALS");
    assert.equal(refused.setCookie.length, 0);
  }
  // The two refusals are indistinguishable — the response cannot be used to
  // learn which emails have accounts.
  assert.deepEqual(wrongPassword.body, unknownUser.body);
});

test("a GitHub-only account has no password and cannot be signed into with one", async () => {
  await query(`INSERT INTO users (id, email, created_at, github_id, github_login) VALUES ($1,$2,$3,$4,$5)`, [
    "github-only-user",
    "oauth@example.test",
    Date.now(),
    "9001",
    "oauth-user",
  ]);
  const refused = await request("/api/auth/password/login", "POST", { email: "oauth@example.test", password: "guessed-password" });
  assert.equal(refused.status, 401);
  assert.equal(refused.body.code, "INVALID_CREDENTIALS");
});

test("the environment switch closes both routes and drops the method from discovery", async () => {
  const advertised = await request("/api/auth/methods");
  assert.equal(advertised.status, 200);
  assert.equal(advertised.body.password, true);

  config.auth = { ...config.auth, password: false };
  try {
    const hidden = await request("/api/auth/methods");
    assert.equal(hidden.body.password, false);
    for (const route of ["/api/auth/password/register", "/api/auth/password/login"]) {
      // A correct password is still refused: the switch is checked before the
      // credential, so a disabled instance never signs anyone in.
      const refused = await request(route, "POST", { email: "founder@example.test", password: "sufficiently-long" });
      assert.equal(refused.status, 503);
      assert.equal(refused.body.code, "PASSWORD_AUTH_DISABLED");
      assert.equal(refused.setCookie.length, 0);
    }
  } finally {
    config.auth = { ...config.auth, password: true };
  }
});

// An instance on a public origin should be able to decide that only invited
// people get accounts, without giving up the password door entirely.
test("invite-only registration refuses an uninvited address", async () => {
  config.auth = { ...config.auth, signup: "invite" };
  try {
    const refused = await request("/api/auth/password/register", "POST", {
      email: "uninvited@example.test",
      password: "correct horse battery",
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "SIGNUP_CLOSED");
    const { rows } = await query(`SELECT 1 FROM users WHERE email = $1`, ["uninvited@example.test"]);
    assert.equal(rows.length, 0);
  } finally {
    config.auth = { ...config.auth, signup: "open" };
  }
});

// The invitation is the capability, and it is spent on the account it admitted:
// the person lands in the workspace they were invited to, not a personal one.
test("an invitation admits exactly one account and puts it in that workspace", async () => {
  const workspace = await createWorkspace("Invited Team", "some-existing-owner");
  const invite = await createInvite(workspace.id, "member", null, "test");
  config.auth = { ...config.auth, signup: "invite" };
  try {
    const created = await request("/api/auth/password/register", "POST", {
      email: "invited@example.test",
      password: "correct horse battery",
      invite: invite.token,
    });
    assert.equal(created.status, 201);
    const rows = await query<{ slug: string; role: string }>(
      `SELECT w.slug, m.role FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         JOIN users u ON u.id = m.user_id
        WHERE u.email = $1`,
      ["invited@example.test"],
    );
    assert.deepEqual(rows.rows, [{ slug: workspace.slug, role: "member" }]);

    // Spent: the same link cannot admit a second account.
    const replay = await request("/api/auth/password/register", "POST", {
      email: "second@example.test",
      password: "correct horse battery",
      invite: invite.token,
    });
    assert.equal(replay.status, 403);
  } finally {
    config.auth = { ...config.auth, signup: "open" };
  }
});

test("a native client asks for the bearer token instead of the cookie", async () => {
  const signedIn = await request("/api/auth/password/login", "POST", {
    email: "founder@example.test",
    password: "sufficiently-long",
    client: "native",
  });
  assert.equal(signedIn.status, 200);
  assert.equal(typeof signedIn.body.token, "string");
  assert.equal(signedIn.setCookie.length, 0);

  const me = await request("/api/auth/me", "GET", undefined, { authorization: `Bearer ${signedIn.body.token as string}` });
  assert.equal(me.status, 200);
  assert.equal((me.body.user as { email: string }).email, "founder@example.test");
});
