import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const manifestUrl = new URL(
  "packages/protocol-conformance/fixtures/legacy-callback-retirement-gate-v1.json",
  root,
);

async function loadManifest() {
  return JSON.parse(await readFile(manifestUrl, "utf8"));
}

function isEvidence(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseIsoDate(value, label) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/, `${label} must be an ISO calendar date`);
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  assert.ok(Number.isFinite(timestamp), `${label} must be a valid date`);
  assert.equal(
    new Date(timestamp).toISOString().slice(0, 10),
    value,
    `${label} must be a real calendar date`,
  );
  return timestamp;
}

test("OVSR-211 cannot claim readiness without every destructive-removal gate", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.task, "OVSR-211");

  const evidence = Object.values(manifest.gates);
  const allGatesHaveEvidence = evidence.every(isEvidence);

  if (manifest.decision === "ready") {
    assert.equal(allGatesHaveEvidence, true, "ready requires evidence for every gate");
    const auditedAt = parseIsoDate(manifest.auditedAt, "auditedAt");
    const publishedAt = parseIsoDate(
      manifest.gates.supportWindowPublishedAt,
      "supportWindowPublishedAt",
    );
    const endsAt = parseIsoDate(manifest.gates.supportWindowEndsAt, "supportWindowEndsAt");
    assert.ok(
      publishedAt <= endsAt,
      "the support window cannot end before it is published",
    );
    assert.ok(
      endsAt <= auditedAt,
      "the published mixed-version support window must have ended",
    );
  } else {
    assert.equal(manifest.decision, "blocked");
    assert.equal(
      allGatesHaveEvidence,
      false,
      "a fully evidenced gate must be reviewed and deliberately promoted to ready",
    );
  }
});

test("blocked retirement keeps compatibility and local-control anchors", async () => {
  const manifest = await loadManifest();
  if (manifest.decision !== "blocked") return;

  for (const group of ["compatibilityAnchors", "localControlAnchors"]) {
    assert.ok(manifest[group].length > 0, `${group} must not be empty`);
    for (const anchor of manifest[group]) {
      const source = await readFile(new URL(anchor.path, root), "utf8");
      assert.ok(
        source.includes(anchor.contains),
        `${anchor.path} lost ${group} anchor ${JSON.stringify(anchor.contains)} while OVSR-211 is blocked`,
      );
    }
  }
});
