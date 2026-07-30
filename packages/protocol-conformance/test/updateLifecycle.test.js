import assert from "node:assert/strict";
import test from "node:test";
import {
  executeGoldenFrames,
  loadFixture,
  UpdateLifecycleHarness,
  validateUpdateFrame,
} from "../src/index.js";

const fixture = loadFixture("update-lifecycle-v1.json");
const command = fixture.frames[0].frame;
const release = fixture.approvedRelease;
const adapters = Object.fromEntries(
  ["command", "accepted", "status", "result"].map((kind) => [
    `update.${kind}`,
    (frame, errors) => validateUpdateFrame(frame, errors, kind),
  ]),
);

test("update.apply golden frames match released reverse-command and attestation seams", () => {
  const report = executeGoldenFrames(fixture, { adapters });
  assert.equal(report.failed, 0, report.cases.filter((entry) => !entry.passed).map((entry) => entry.errors).join("\n"));
  assert.deepEqual(fixture.blockedCells, [
    "approved release revision/SHA TOCTOU binding",
    "replacement runtime SHA attestation",
  ]);
});

test("durable admission, restart attestation and ACK loss converge to one install", () => {
  const harness = new UpdateLifecycleHarness();
  const accepted = harness.admit(command, release);
  assert.equal(accepted.replayed, false);
  assert.equal(harness.status(command.commandId).state, "running");
  assert.equal(harness.install(command.commandId, release), null);
  assert.equal(harness.attest(command.commandId, {
    pid: 4242, version: release.version, revision: release.revision,
  }), null, "the initiating process cannot attest files it just replaced");
  assert.equal(harness.status(command.commandId).state, "running");

  const cursor = harness.attest(command.commandId, {
    pid: 4243, version: release.version, revision: release.revision,
  });
  assert.equal(harness.deliverResult(cursor, "duplicate", "drop"), true);
  harness.reconnect("overseer");
  assert.equal(harness.reconcile(command.commandId).state, "terminal");
  assert.equal(harness.deliverResult(cursor, "duplicate"), true);
  assert.equal(harness.state(command.commandId).effects, 1);
  assert.equal(harness.state(command.commandId).audits, 1);
  assert.equal(harness.state(command.commandId).acknowledgedCursor, 1);

  const replayed = harness.admit(command, release);
  assert.equal(replayed.replayed, true);
  assert.equal(harness.status(command.commandId).state, "terminal");
  assert.equal(harness.install(command.commandId, release), null);
  assert.equal(harness.installerLaunches.size, 1, "duplicate command never launches a second installer");
});

test("release changes, integrity failures, stale generations and corrupt receipts fail closed", () => {
  const changed = new UpdateLifecycleHarness();
  changed.admit(command, release);
  const changedCursor = changed.install(command.commandId, { ...release, version: "0.11.4" });
  assert.equal(changed.peon.ledger.get(command.commandId).result.code, "RELEASE_CHANGED");
  assert.equal(changed.deliverResult(changedCursor), true);
  assert.equal(changed.installerLaunches.size, 0);

  const integrity = new UpdateLifecycleHarness();
  const integrityCommand = { ...command, commandId: "118f4f0c-9f30-7a61-bf1a-66d2582bdb4a" };
  integrity.admit(integrityCommand, release);
  const integrityCursor = integrity.install(integrityCommand.commandId, release, {
    downloadedSha256: "f".repeat(64),
  });
  assert.equal(integrity.peon.ledger.get(integrityCommand.commandId).result.code, "ARCHIVE_INTEGRITY_FAILED");
  assert.equal(integrity.deliverResult(integrityCursor), true);

  const stale = new UpdateLifecycleHarness();
  const staleCommand = { ...command, commandId: "218f4f0c-9f30-7a61-bf1a-66d2582bdb4a" };
  const staleAccepted = stale.submit(staleCommand);
  stale.transport.send(staleAccepted, { fault: "hold" });
  stale.reconnect("overseer");
  for (const envelope of stale.transport.releaseHeld()) assert.equal(stale.transport.accepts(envelope), false);
  assert.equal(stale.state(staleCommand.commandId).overseer, "created");

  const corrupt = new UpdateLifecycleHarness();
  const corruptCommand = { ...command, commandId: "318f4f0c-9f30-7a61-bf1a-66d2582bdb4a" };
  corrupt.admit(corruptCommand, release);
  corrupt.corruptReceipt(corruptCommand.commandId);
  corrupt.recoverReceipts();
  assert.equal(corrupt.receipts.has(corruptCommand.commandId), false);
  assert.equal(corrupt.attest(corruptCommand.commandId, {
    pid: 4243, version: release.version, revision: release.revision,
  }), null);
});

test("stable rollback, restart and attestation failures remain bounded safe results", () => {
  const codes = [
    "INSTALL_FAILED_ROLLED_BACK", "INSTALL_FAILED_ROLLBACK_FAILED",
    "RESTART_FAILED_ROLLED_BACK", "RESTART_FAILED_ROLLBACK_FAILED",
    "RESTART_TIMEOUT", "RESTART_TIMEOUT_ROLLED_BACK",
    "RESTART_TIMEOUT_ROLLBACK_FAILED",
  ];
  const prefixes = ["4", "5", "6", "7", "8", "9", "a"];
  for (const [index, code] of codes.entries()) {
    const harness = new UpdateLifecycleHarness();
    const commandId = `${prefixes[index]}18f4f0c-9f30-7a61-bf1a-66d2582bdb4a`;
    const current = { ...command, commandId };
    harness.admit(current, release);
    const cursor = harness.install(commandId, release, { code });
    assert.equal(harness.peon.ledger.get(commandId).result.code, code);
    assert.equal(harness.deliverResult(cursor), true);
  }

  const mismatch = new UpdateLifecycleHarness();
  const mismatchCommand = { ...command, commandId: "b18f4f0c-9f30-7a61-bf1a-66d2582bdb4a" };
  mismatch.admit(mismatchCommand, release);
  mismatch.install(mismatchCommand.commandId, release);
  const cursor = mismatch.attest(mismatchCommand.commandId, {
    pid: 4243, version: "0.11.4", revision: release.revision,
  });
  assert.equal(mismatch.peon.ledger.get(mismatchCommand.commandId).result.code, "ATTESTATION_MISMATCH");
  assert.equal(mismatch.deliverResult(cursor), true);
});
