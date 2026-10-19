import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadInitialAuth } from "./auth";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("an unreachable auth backend does not become signed out", async () => {
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  assert.deepEqual(await loadInitialAuth(), { kind: "unavailable" });
});

test("a server failure while checking the cookie is unavailable", async () => {
  globalThis.fetch = async () => Response.json({ code: "UNAVAILABLE" }, { status: 503 });
  assert.deepEqual(await loadInitialAuth(), { kind: "unavailable" });
});

test("only an explicit unauthorized response becomes signed out", async () => {
  globalThis.fetch = async () => Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  assert.deepEqual(await loadInitialAuth(), { kind: "unauthenticated" });
});

test("a signed-in cookie yields the user", async () => {
  const user = { email: "operator@example.com" };
  globalThis.fetch = async () => Response.json({ user });
  assert.deepEqual(await loadInitialAuth(), { kind: "authenticated", user });
});

