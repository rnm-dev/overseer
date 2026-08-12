import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { resolveAuthConfig } from "../infrastructure/auth/authConfig.js";
import { config } from "../infrastructure/config/index.js";
import { initDb } from "../infrastructure/db/index.js";
import { createServer } from "../app/server.js";

let server: http.Server;
let port: number;
const originalFetch = globalThis.fetch;
const originalConfig = {
  publicUrl: config.publicUrl,
  auth: config.auth,
};

before(async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);

  config.publicUrl = "https://overseer.example";
  config.auth = resolveAuthConfig({
    OVERSEER_GITHUB_CLIENT_ID: "github-client",
    OVERSEER_GITHUB_CLIENT_SECRET: "github-secret",
    OVERSEER_GITHUB_NATIVE_CALLBACKS: "overseer-dev://oauth/github,overseer://oauth/github",
  }, config.publicUrl);

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body)) as { code: string; redirect_uri: string };
      assert.equal(body.redirect_uri, config.auth.github?.redirectUri);
      return Response.json({ access_token: `token-${body.code}` });
    }
    if (url === "https://api.github.com/user") {
      const token = new Headers(init?.headers).get("authorization")?.replace("Bearer token-", "") ?? "unknown";
      const native = token === "native-github-code";
      return Response.json({
        id: native ? 202 : 101,
        login: native ? "native-user" : "web-user",
        email: native ? "native@example.test" : "web@example.test",
        name: null,
        avatar_url: null,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  server = http.createServer(createServer());
  port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
});

after(async () => {
  globalThis.fetch = originalFetch;
  Object.assign(config, originalConfig);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface TestResponse {
  status: number;
  location?: string;
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
          location: res.headers.location,
          setCookie: res.headers["set-cookie"] ?? [],
          body: text && res.headers["content-type"]?.includes("json") ? JSON.parse(text) as Record<string, unknown> : {},
        });
      });
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

function started(response: TestResponse): { state: string; authorizationUrl: URL } {
  assert.equal(response.status, 200);
  const state = response.body.state;
  const authorizationUrl = response.body.authorizationUrl;
  assert.equal(typeof state, "string");
  assert.equal(typeof authorizationUrl, "string");
  const authorize = new URL(authorizationUrl as string);
  assert.equal(authorize.searchParams.get("redirect_uri"), config.auth.github?.redirectUri);
  assert.equal(authorize.searchParams.get("state"), state);
  return { state: state as string, authorizationUrl: authorize };
}

test("web OAuth uses the shared frontend callback and completes through the API", async () => {
  const { state } = started(await request("/api/auth/github/start", "POST"));
  const exchanged = await request("/api/auth/github", "POST", { state, code: "web-github-code" });
  assert.equal(exchanged.status, 200);
  assert.equal(exchanged.body.flow, "web");
  assert.equal((exchanged.body.user as { githubLogin: string }).githubLogin, "web-user");
  assert.equal(exchanged.body.token, undefined);
  assert.equal(exchanged.setCookie.length, 1);
  assert.match(exchanged.setCookie[0], /^__Host-overseer_session=[^;]+;/);
  assert.match(exchanged.setCookie[0], /;\s*Path=\//i);
  assert.match(exchanged.setCookie[0], /;\s*HttpOnly/i);
  assert.match(exchanged.setCookie[0], /;\s*Secure/i);
  assert.match(exchanged.setCookie[0], /;\s*SameSite=Lax/i);

  const cookie = exchanged.setCookie[0].split(";", 1)[0];
  const rawToken = cookie.slice(cookie.indexOf("=") + 1);
  const me = await request("/api/auth/me", "GET", undefined, { cookie });
  assert.equal(me.status, 200);
  assert.equal((me.body.user as { githubLogin: string }).githubLogin, "web-user");

  const rejectedMutation = await request("/api/auth/ws-ticket", "POST", undefined, { cookie });
  assert.equal(rejectedMutation.status, 403);
  assert.equal(rejectedMutation.body.code, "CSRF_ORIGIN");
  const cookieMutation = await request("/api/auth/ws-ticket", "POST", undefined, { cookie, origin: config.publicUrl });
  assert.equal(cookieMutation.status, 201);

  const bearerMutation = await request("/api/auth/ws-ticket", "POST", undefined, { authorization: `Bearer ${rawToken}` });
  assert.equal(bearerMutation.status, 201);
  const migrated = await request("/api/auth/web-session", "POST", undefined, {
    authorization: `Bearer ${rawToken}`,
    origin: config.publicUrl,
  });
  assert.equal(migrated.status, 200);
  assert.match(migrated.setCookie[0], /^__Host-overseer_session=/);

  const replay = await request("/api/auth/github", "POST", { state, code: "web-github-code" });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, "BAD_STATE");

  const loggedOut = await request("/api/auth/logout", "POST", undefined, { cookie, origin: config.publicUrl });
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.setCookie[0], /^__Host-overseer_session=;/);
  assert.equal((await request("/api/auth/me", "GET", undefined, { cookie })).status, 401);
});

test("native OAuth uses the same frontend callback before opening the app scheme", async () => {
  const { state } = started(await request("/api/auth/github/native/start", "POST", { callback: "overseer-dev://oauth/github" }));
  const completed = await request("/api/auth/github", "POST", { state, code: "native-github-code" });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.flow, "native");

  const app = new URL(completed.body.redirectUrl as string);
  assert.equal(`${app.protocol}//${app.host}${app.pathname}`, "overseer-dev://oauth/github");
  assert.equal(app.searchParams.get("state"), state);
  const appCode = app.searchParams.get("code");
  assert.ok(appCode);
  assert.notEqual(appCode, "native-github-code");

  const exchanged = await request("/api/auth/github/native/exchange", "POST", { state, code: appCode });
  assert.equal(exchanged.status, 200);
  assert.equal((exchanged.body.user as { githubLogin: string }).githubLogin, "native-user");
  assert.equal(typeof exchanged.body.token, "string");
});

test("disabled and half-configured GitHub stay out of discovery and public SPA config", async () => {
  const configured = config.auth;
  try {
    for (const env of [
      { OVERSEER_GITHUB_CLIENT_ID: "client-only" },
      { OVERSEER_GITHUB_CLIENT_SECRET: "secret-only" },
      {},
    ]) {
      config.auth = resolveAuthConfig(env, config.publicUrl);

      const methods = await request("/api/auth/methods");
      assert.equal(methods.status, 200);
      assert.equal(methods.body.github, false);

      const publicConfig = await request("/api/auth/github/config");
      assert.equal(publicConfig.status, 200);
      assert.deepEqual(publicConfig.body, { clientId: "", scope: "", redirectUri: "" });

      for (const route of ["/api/auth/github/start", "/api/auth/github/native/start"]) {
        const refused = await request(route, "POST", { callback: "overseer://oauth/github" });
        assert.equal(refused.status, 503);
        assert.equal(refused.body.code, "GITHUB_DISABLED");
      }
    }
  } finally {
    config.auth = configured;
  }
});
