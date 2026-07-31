import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadFixture } from "../src/index.js";
import { loadClaimSecurityVectors, runClaimConformance } from "../src/claimLifecycle.js";

const root = path.resolve(import.meta.dirname, "../../..");
const peonVectors = path.join(root, "apps/peon/protocol/peon-claim-v1/security-vectors.json");
const overseerVectors = path.join(root, "apps/server/protocol/peon-claim-v1/security-vectors.json");

test("peon-claim-v1 golden, mixed-version and fault cells are covered", () => {
  const fixture = loadFixture("peon-claim-lifecycle-v1.json");
  const peon = runClaimConformance(fixture, loadClaimSecurityVectors(peonVectors));
  const overseer = runClaimConformance(fixture, loadClaimSecurityVectors(overseerVectors));
  assert.equal(peon.passed, true, peon.errors.join("\n"));
  assert.deepEqual(overseer, peon);
  assert.equal(peon.goldenCases, 59);
  assert.equal(peon.mixedVersion.every((cell) => cell.passed), true);
  assert.ok(peon.faultCoverage.includes("restart-during-ack-cancel-reconciliation"));
});

test("claim start is an irreversible downgrade boundary", () => {
  const fixture = loadFixture("peon-claim-lifecycle-v1.json");
  const report = runClaimConformance(fixture, loadClaimSecurityVectors(peonVectors));
  const failures = report.mixedVersion.filter((cell) => cell.claimStarted && cell.failure);
  assert.deepEqual(failures.map((cell) => cell.failure), ["timeout", "5xx", "429", "tls"]);
  assert.ok(failures.every((cell) => cell.actualRoute === "peon-claim-v1"));
});

test("operational enrollment checks stay explicit and cannot report green", () => {
  const fixture = loadFixture("peon-claim-lifecycle-v1.json");
  const report = runClaimConformance(fixture, loadClaimSecurityVectors(peonVectors));
  assert.deepEqual(report.operationalChecks.map((check) => check.id), ["real-machine-nat-tls", "mixed-fleet-soak", "legacy-removal"]);
  assert.ok(report.operationalChecks.every((check) => check.blocked && !check.passed));
});
