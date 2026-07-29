import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { runArchitectureImportCheck } from "./check-architecture-imports.mjs";

function fixtureRoot(name) {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "architecture-imports", name);
}

test("architecture guard accepts clean feature-boundary imports", async () => {
  const violations = runArchitectureImportCheck({ rootDir: fixtureRoot("valid") });
  assert.equal(violations.length, 0);
});

test("architecture guard flags boundary and shim violations", async () => {
  const violations = runArchitectureImportCheck({ rootDir: fixtureRoot("invalid") });
  const reasons = violations.map((item) => item.reason);

  assert.ok(violations.length >= 3);
  assert.ok(
    reasons.some((reason) => reason.includes("production import into projects must use projects/index")),
  );
  assert.ok(
    reasons.some((reason) => reason.includes("production imports from feature 'sessions' into 'files' must use files/index")),
  );
  assert.ok(reasons.some((reason) => reason.includes("forbidden compatibility shim")));
  assert.ok(
    reasons.some((reason) => reason.includes("feature modules cannot depend on transport internals")),
  );
  assert.ok(
    reasons.some((reason) => reason.includes("production imports from feature 'sessions' into 'agents' must use agents/index")),
  );
  assert.ok(reasons.some((reason) => reason.includes("generic bucket 'utils'")));
  assert.ok(reasons.some((reason) => reason.includes("generic bucket 'manager'")));
  assert.ok(reasons.some((reason) => reason.includes("generic bucket 'helper")));
});
