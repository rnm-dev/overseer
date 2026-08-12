import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuthConfig } from "./authConfig.js";

const PUBLIC_URL = "https://overseer.example";

test("GitHub resolves only when both credentials are configured", () => {
  for (const env of [
    { OVERSEER_GITHUB_CLIENT_ID: "client-only" },
    { OVERSEER_GITHUB_CLIENT_SECRET: "secret-only" },
    {},
  ]) {
    const auth = resolveAuthConfig(env, PUBLIC_URL);
    assert.equal(auth.github, null);
    assert.equal(auth.warnings.some((warning) => warning.includes("GitHub sign-in is disabled")), true);
  }
});

test("configured GitHub resolves the complete settings used by every caller", () => {
  const auth = resolveAuthConfig({
    OVERSEER_GITHUB_CLIENT_ID: " client ",
    OVERSEER_GITHUB_CLIENT_SECRET: " secret ",
    OVERSEER_GITHUB_NATIVE_CALLBACKS: "overseer-dev://oauth/github, overseer://oauth/github",
  }, PUBLIC_URL);

  assert.deepEqual(auth.github, {
    clientId: "client",
    clientSecret: "secret",
    scope: "read:user user:email",
    redirectUri: "https://overseer.example/auth/github/callback",
    nativeCallbacks: ["overseer-dev://oauth/github", "overseer://oauth/github"],
  });
});

test("password availability follows its one explicit environment switch", () => {
  assert.equal(resolveAuthConfig({ OVERSEER_PASSWORD_AUTH: "1" }, PUBLIC_URL).password, true);
  assert.equal(resolveAuthConfig({}, PUBLIC_URL).password, false);
  assert.equal(resolveAuthConfig({ OVERSEER_PASSWORD_AUTH: "true" }, PUBLIC_URL).password, false);
});
