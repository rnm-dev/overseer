import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SERVER_VERSION } from "./serverVersion.js";

// The release process bumps package.json. This is the guard that stops the
// literal in version.ts from being forgotten there and shipping a build that
// misreports itself on /healthz — the one place a self-hosting operator can
// look.
test("the served version matches the package manifest", () => {
  const manifest = path.resolve(fileURLToPath(import.meta.url), "../../../package.json");
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
  assert.equal(SERVER_VERSION, version);
});
