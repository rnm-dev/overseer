import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api, migrateLegacyWebSession } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("web API requests use same-origin cookie credentials without a bearer header", async () => {
  const calls: { input: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return Response.json({ ok: true });
  };

  await api("/auth/me");

  assert.equal(calls[0]?.input, "/api/auth/me");
  assert.equal(calls[0]?.init?.credentials, "same-origin");
  assert.equal(new Headers(calls[0]?.init?.headers).has("authorization"), false);
});

test("legacy web-session migration sends the old token once as a bearer", async () => {
  const calls: { input: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return Response.json({ ok: true });
  };

  await migrateLegacyWebSession("device.secret");

  assert.equal(calls[0]?.input, "/api/auth/web-session");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.credentials, "same-origin");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer device.secret");
});
