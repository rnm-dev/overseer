import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../shared/api";
import { loadInitialAuth } from "./auth";

const user = { email: "operator@example.com" };

test("an unavailable auth backend does not become signed out", async () => {
  let cleared = false;
  const result = await loadInitialAuth({
    legacyToken: () => "stored-token",
    migrateLegacySession: async () => {
      throw new TypeError("fetch failed");
    },
    clearLegacyToken: () => { cleared = true; },
    loadUser: async () => ({ user }),
  });

  assert.deepEqual(result, { kind: "unavailable" });
  assert.equal(cleared, false);
});

test("a server failure while checking the cookie is unavailable", async () => {
  const result = await loadInitialAuth({
    legacyToken: () => null,
    migrateLegacySession: async () => {},
    clearLegacyToken: () => {},
    loadUser: async () => {
      throw new ApiError(503, "UNAVAILABLE", "maintenance");
    },
  });

  assert.deepEqual(result, { kind: "unavailable" });
});

test("only an explicit unauthorized response becomes signed out", async () => {
  const result = await loadInitialAuth({
    legacyToken: () => null,
    migrateLegacySession: async () => {},
    clearLegacyToken: () => {},
    loadUser: async () => {
      throw new ApiError(401, "UNAUTHENTICATED", "authentication required");
    },
  });

  assert.deepEqual(result, { kind: "unauthenticated" });
});
