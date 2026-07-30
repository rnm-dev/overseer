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

test("OVSR-211 cannot claim readiness without every destructive-removal gate", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.task, "OVSR-211");

  const evidence = Object.values(manifest.gates);
  const allGatesHaveEvidence = evidence.every(
    (value) => typeof value === "string" && value.trim().length > 0,
  );

  if (manifest.decision === "ready") {
    assert.equal(allGatesHaveEvidence, true, "ready requires evidence for every gate");
    assert.ok(
      Date.parse(manifest.gates.supportWindowEndsAt) <= Date.parse(manifest.auditedAt),
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

test("blocked retirement keeps named mixed-version compatibility anchors", async () => {
  const manifest = await loadManifest();
  if (manifest.decision !== "blocked") return;

  for (const anchor of manifest.compatibilityAnchors) {
    const source = await readFile(new URL(anchor.path, root), "utf8");
    assert.ok(
      source.includes(anchor.contains),
      `${anchor.path} lost compatibility anchor ${JSON.stringify(anchor.contains)} while OVSR-211 is blocked`,
    );
  }
});
