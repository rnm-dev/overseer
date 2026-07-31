import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchLatestNpmRelease,
  parseNpmPackageRelease,
  PEON_NPM_LATEST_URL,
  peonNpmSpec,
} from "../../shared/npmRegistry.js";

test("npm package metadata requires a semver version", () => {
  assert.deepEqual(parseNpmPackageRelease({ version: "1.2.3" }), { version: "1.2.3" });
  assert.throws(() => parseNpmPackageRelease({ version: "latest" }), /invalid package version/);
  assert.throws(() => parseNpmPackageRelease(null), /invalid package metadata/);
});

test("latest release is read from the public npm registry", async () => {
  let requested = "";
  let accept = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    requested = String(input);
    accept = new Headers(init?.headers).get("Accept") ?? "";
    return new Response(JSON.stringify({ version: "0.11.3" }), { status: 200 });
  };
  assert.deepEqual(await fetchLatestNpmRelease(fetchImpl), { version: "0.11.3" });
  assert.equal(requested, PEON_NPM_LATEST_URL);
  assert.equal(accept, "application/json");
});

test("registry errors are bounded and exact package specs are validated", async () => {
  const unavailable: typeof fetch = async () => new Response(null, { status: 503, statusText: "Unavailable" });
  await assert.rejects(fetchLatestNpmRelease(unavailable), /503 Unavailable/);
  assert.equal(peonNpmSpec("0.11.3"), "@rnm-dev/peon@0.11.3");
  assert.throws(() => peonNpmSpec("latest"), /invalid Peon npm version/);
});
