import assert from "node:assert/strict";
import test from "node:test";
import { authMethodAvailability, describeAuthMethods, isAuthMethodEnabled, resolveAuthConfig } from "./authConfig.js";

const PUBLIC_URL = "https://overseer.example";

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values;

test("a fully configured GitHub app is the only thing that turns GitHub on", () => {
  const auth = resolveAuthConfig(
    env({ OVERSEER_GITHUB_CLIENT_ID: "id", OVERSEER_GITHUB_CLIENT_SECRET: "secret" }),
    PUBLIC_URL,
  );
  assert.deepEqual(auth.github, {
    clientId: "id",
    clientSecret: "secret",
    scope: "read:user user:email",
    redirectUri: "https://overseer.example/auth/github/callback",
    nativeCallbacks: ["overseer://oauth/github"],
  });
  assert.deepEqual(authMethodAvailability(auth), { github: true, password: false, oidc: false });
  assert.deepEqual(auth.warnings, []);
});

test("half a GitHub app is no GitHub app, and says which half is missing", () => {
  for (const [missing, values] of [
    ["SECRET", { OVERSEER_GITHUB_CLIENT_ID: "id" }],
    ["ID", { OVERSEER_GITHUB_CLIENT_SECRET: "secret" }],
  ] as const) {
    const auth = resolveAuthConfig(env(values), PUBLIC_URL);
    assert.equal(auth.github, null);
    assert.equal(isAuthMethodEnabled(auth, "github"), false);
    assert.equal(
      auth.warnings.some((warning) => warning.includes(`OVERSEER_GITHUB_CLIENT_${missing} is empty`)),
      true,
      `expected a warning naming the missing ${missing}`,
    );
  }
});

test("an instance with no method configured warns that nobody can log in", () => {
  const auth = resolveAuthConfig(env({}), PUBLIC_URL);
  assert.deepEqual(authMethodAvailability(auth), { github: false, password: false, oidc: false });
  assert.equal(auth.warnings.length, 1);
  assert.match(auth.warnings[0]!, /nobody can log in/);
});

test("password auth is on for exactly OVERSEER_PASSWORD_AUTH=1", () => {
  for (const value of ["1"]) {
    assert.equal(resolveAuthConfig(env({ OVERSEER_PASSWORD_AUTH: value }), PUBLIC_URL).password, true);
  }
  for (const value of ["", "0", "true", "yes", "on"]) {
    assert.equal(resolveAuthConfig(env({ OVERSEER_PASSWORD_AUTH: value }), PUBLIC_URL).password, false, value);
  }
});

test("password auth alone is a complete instance — no warning", () => {
  const auth = resolveAuthConfig(env({ OVERSEER_PASSWORD_AUTH: "1" }), PUBLIC_URL);
  assert.deepEqual(authMethodAvailability(auth), { github: false, password: true, oidc: false });
  assert.deepEqual(auth.warnings, []);
});

test("overrides are read, trimmed and split; blanks fall back to the defaults", () => {
  const auth = resolveAuthConfig(
    env({
      OVERSEER_GITHUB_CLIENT_ID: " id ",
      OVERSEER_GITHUB_CLIENT_SECRET: " secret ",
      OVERSEER_GITHUB_SCOPE: "  ",
      OVERSEER_GITHUB_REDIRECT_URI: "https://elsewhere.example/cb",
      OVERSEER_GITHUB_NATIVE_CALLBACKS: "overseer-dev://oauth/github, overseer://oauth/github ,",
      OVERSEER_DEVICE_TOKEN_TTL_MS: "60000",
    }),
    PUBLIC_URL,
  );
  assert.equal(auth.github?.clientId, "id");
  assert.equal(auth.github?.clientSecret, "secret");
  assert.equal(auth.github?.scope, "read:user user:email");
  assert.equal(auth.github?.redirectUri, "https://elsewhere.example/cb");
  assert.deepEqual(auth.github?.nativeCallbacks, ["overseer-dev://oauth/github", "overseer://oauth/github"]);
  assert.equal(auth.deviceTokenTtlMs, 60_000);
});

test("an unusable device token lifetime keeps the default rather than expiring every token at once", () => {
  const ninetyDays = 90 * 24 * 60 * 60_000;
  for (const value of ["nonsense", "0", "-1", ""]) {
    assert.equal(resolveAuthConfig(env({ OVERSEER_DEVICE_TOKEN_TTL_MS: value }), PUBLIC_URL).deviceTokenTtlMs, ninetyDays, value);
  }
});

const OIDC = {
  OVERSEER_OIDC_ISSUER: "https://id.rnm.dev",
  OVERSEER_OIDC_CLIENT_ID: "overseer",
  OVERSEER_OIDC_CLIENT_SECRET: "secret",
};

test("a configured OIDC provider is discovered from the issuer alone", () => {
  const auth = resolveAuthConfig(env(OIDC), PUBLIC_URL);
  assert.deepEqual(auth.oidc, {
    issuer: "https://id.rnm.dev",
    clientId: "overseer",
    clientSecret: "secret",
    scope: "openid profile email",
    redirectUri: "https://overseer.example/auth/oidc/callback",
    nativeCallbacks: ["overseer://oauth/oidc"],
    label: "id.rnm.dev",
    joinWorkspace: null,
    workspaceClaim: null,
    provisionWorkspace: false,
  });
  assert.deepEqual(authMethodAvailability(auth), { github: false, password: false, oidc: true });
  assert.deepEqual(auth.warnings, []);
});

test("the issuer is normalised, and must be https", () => {
  assert.equal(resolveAuthConfig(env({ ...OIDC, OVERSEER_OIDC_ISSUER: "https://id.rnm.dev/" }), PUBLIC_URL).oidc?.issuer, "https://id.rnm.dev");
  assert.equal(
    resolveAuthConfig(env({ ...OIDC, OVERSEER_OIDC_ISSUER: "https://id.rnm.dev/tenant/a/" }), PUBLIC_URL).oidc?.issuer,
    "https://id.rnm.dev/tenant/a",
  );
  for (const bad of ["http://id.rnm.dev", "id.rnm.dev"]) {
    const auth = resolveAuthConfig(env({ ...OIDC, OVERSEER_OIDC_ISSUER: bad }), PUBLIC_URL);
    assert.equal(auth.oidc, null, bad);
    assert.equal(auth.warnings.some((warning) => warning.includes("OVERSEER_OIDC_ISSUER")), true, bad);
  }
});

test("a partly configured provider is refused and names every missing part", () => {
  const auth = resolveAuthConfig(env({ OVERSEER_OIDC_ISSUER: "https://id.rnm.dev" }), PUBLIC_URL);
  assert.equal(auth.oidc, null);
  assert.match(auth.warnings[0]!, /OVERSEER_OIDC_CLIENT_ID \/ OVERSEER_OIDC_CLIENT_SECRET are empty/);
});

test("openid is always requested, whatever scope an operator sets", () => {
  assert.equal(resolveAuthConfig(env({ ...OIDC, OVERSEER_OIDC_SCOPE: "profile email" }), PUBLIC_URL).oidc?.scope, "openid profile email");
  assert.equal(resolveAuthConfig(env({ ...OIDC, OVERSEER_OIDC_SCOPE: "openid workspace" }), PUBLIC_URL).oidc?.scope, "openid workspace");
});

test("the button label falls back to the issuer host and is otherwise the operator's", () => {
  assert.equal(resolveAuthConfig(env(OIDC), PUBLIC_URL).oidc?.label, "id.rnm.dev");
  assert.equal(resolveAuthConfig(env({ ...OIDC, OVERSEER_OIDC_LABEL: "RNM ID" }), PUBLIC_URL).oidc?.label, "RNM ID");
});

test("the door can name the workspace its operators join", () => {
  assert.equal(resolveAuthConfig(env(OIDC), PUBLIC_URL).oidc?.joinWorkspace, null);
  assert.equal(
    resolveAuthConfig(env({ ...OIDC, OVERSEER_OIDC_JOIN_WORKSPACE: "rainmaker" }), PUBLIC_URL).oidc?.joinWorkspace,
    "rainmaker",
  );
});

test("the workspace claim is read only when an instance names one", () => {
  assert.equal(resolveAuthConfig(env(OIDC), PUBLIC_URL).oidc?.workspaceClaim, null);
  assert.equal(
    resolveAuthConfig(env({ ...OIDC, OVERSEER_OIDC_WORKSPACE_CLAIM: "roles" }), PUBLIC_URL).oidc?.workspaceClaim,
    "roles",
  );
});

test("a directory gets its own workspace only when asked", () => {
  assert.equal(resolveAuthConfig(env(OIDC), PUBLIC_URL).oidc?.provisionWorkspace, false);
  assert.equal(
    resolveAuthConfig(env({ ...OIDC, OVERSEER_OIDC_PROVISION_WORKSPACE: "1" }), PUBLIC_URL).oidc?.provisionWorkspace,
    true,
  );
});

test("an instance takes uninvited accounts only when it says so", () => {
  assert.equal(resolveAuthConfig(env({}), PUBLIC_URL).openSignup, false);
  // Anything but "1" leaves it closed: a half-meant value must not be the one
  // that opens registration to the internet.
  assert.equal(resolveAuthConfig(env({ OVERSEER_OPEN_SIGNUP: "true" }), PUBLIC_URL).openSignup, false);
  assert.equal(resolveAuthConfig(env({ OVERSEER_OPEN_SIGNUP: "1" }), PUBLIC_URL).openSignup, true);
});

test("the sign-in page is told whether it may offer registration", () => {
  const open = resolveAuthConfig(env({ OVERSEER_PASSWORD_AUTH: "1", OVERSEER_OPEN_SIGNUP: "1" }), PUBLIC_URL);
  assert.equal(describeAuthMethods(open).openSignup, true);
  assert.equal(describeAuthMethods(resolveAuthConfig(env({ OVERSEER_PASSWORD_AUTH: "1" }), PUBLIC_URL)).openSignup, false);
});

test("OIDC alone is a complete instance", () => {
  assert.deepEqual(resolveAuthConfig(env(OIDC), PUBLIC_URL).warnings, []);
});
