import assert from "node:assert/strict";
import test from "node:test";
import { loadFixture } from "../src/index.js";

const model = loadFixture("transcript-acceptance-v1.json");

test("transcript acceptance catalog names every convergence boundary", () => {
  assert.equal(model.version, "transcript-convergence-acceptance-v1");
  assert.deepEqual(model.authority, {
    history: "fleet-http",
    liveTail: "transcript-sync-v1",
    canonicalStore: "peon",
  });
  const ids = new Set(model.invariants.map(({ id }) => id));
  for (const id of [
    "TCA-AUTHORITY", "TCA-APPEND-VISIBILITY", "TCA-ACK-BOUNDARY",
    "TCA-REPLAY-IDENTITY", "TCA-SNAPSHOT-BARRIER", "TCA-EPOCH",
    "TCA-GENERATION", "TCA-ACL-REVOCATION", "TCA-BOUNDED-RETENTION",
    "TCA-SESSION-ISOLATION", "TCA-CLIENT-ROWS",
  ]) assert.ok(ids.has(id), `missing invariant ${id}`);
  for (const invariant of model.invariants) {
    assert.match(invariant.status, /^(covered|planned)$/);
    if (invariant.status === "covered") assert.ok(invariant.coverage.length > 0, `${invariant.id} has no executable coverage`);
  }
});

test("recovery SLOs are objective and diagnostics are payload-free", () => {
  assert.deepEqual(model.slos.map(({ id }) => id), [
    "TCS-HEALTHY", "TCS-RECONNECT", "TCS-OVERSEER-RESTART",
    "TCS-PROJECTION-REBUILD", "TCS-LONG-OFFLINE",
  ]);
  for (const slo of model.slos) {
    assert.ok(slo.start && slo.stop);
    assert.ok(Number.isInteger(slo.targetMs) && slo.targetMs > 0);
    assert.ok(Number.isInteger(slo.percentile) && slo.percentile > 0 && slo.percentile <= 100);
  }
  const sensitive = /(prompt|transcript|payload|credential|path|attachment|body|content)/i;
  for (const dimension of model.diagnostics.allowedDimensions) assert.doesNotMatch(dimension, sensitive);
  assert.equal(new Set(model.diagnostics.allowedDimensions).size, model.diagnostics.allowedDimensions.length);
  assert.ok(model.diagnostics.forbiddenDimensions.every((dimension) => sensitive.test(dimension)));
});

test("mixed-version acceptance includes canonical, legacy and unsupported cells", () => {
  assert.deepEqual(new Set(model.mixedVersions.map(({ id }) => id)), new Set([
    "MVC-CANONICAL", "MVC-LEGACY-PEON", "MVC-LEGACY-CLIENT", "MVC-UNSUPPORTED-SERVER",
  ]));
  assert.equal(new Set(model.mixedVersions.map(({ id }) => id)).size, model.mixedVersions.length);
});
