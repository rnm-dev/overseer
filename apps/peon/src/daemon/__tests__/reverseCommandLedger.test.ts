import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReverseCommandLedger } from "../overseer/socket/reverseCommandLedger.js";

function tempLedger(options: Record<string, unknown> = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-command-ledger-"));
  const fileBase = path.join(directory, "ledger");
  const ledger = new ReverseCommandLedger({ fileBase, ...options });
  return { directory, fileBase, ledger };
}

const admission = {
  commandId: "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
  requestHash: "a".repeat(64),
  operation: "session.cancel",
  peonId: "f4de920f-e33e-4cf5-97d0-3a75e9266090",
  sessionId: "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5",
  actorUserId: "b169219d-45f6-4f42-b78f-3fb931dac7ee",
  authority: "authority-a",
  admittedGeneration: 1,
};

test("durably admits and deduplicates commands across restart", () => {
  const target = tempLedger();
  try {
    assert.equal(target.ledger.admit(admission).kind, "accepted");
    const restarted = new ReverseCommandLedger({ fileBase: target.fileBase });
    assert.equal(restarted.admit(admission).kind, "replayed");
    assert.equal(restarted.admit({ ...admission, requestHash: "b".repeat(64) }).kind, "reused");
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

test("running recovery records a terminal failure without executing again", () => {
  const target = tempLedger();
  try {
    target.ledger.admit(admission);
    target.ledger.markRunning(admission.commandId, admission.authority, admission.admittedGeneration);
    const restarted = new ReverseCommandLedger({ fileBase: target.fileBase });
    const recovered = restarted.recoverInterrupted((record) => ({
      type: "command_result", commandId: record.commandId, status: "failed", code: "INTERNAL",
    }));
    assert.equal(recovered.length, 1);
    assert.equal(restarted.get(admission.commandId)?.state, "terminal");
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

test("compacts only acknowledged old terminal commands and retains tombstones", () => {
  let now = 1_000;
  const target = tempLedger({ now: () => now, retentionMs: 100, tombstoneRetentionMs: 100 });
  try {
    target.ledger.admit(admission);
    target.ledger.markRunning(admission.commandId, admission.authority, admission.admittedGeneration);
    target.ledger.markTerminal(
      admission.commandId,
      admission.authority,
      admission.admittedGeneration,
      { type: "command_result", code: "OK" },
    );
    target.ledger.bindResultCursor(admission.commandId, admission.authority, "cursor");
    now += 101;
    target.ledger.compact();
    assert.ok(target.ledger.get(admission.commandId), "unacknowledged result was compacted");
    target.ledger.acknowledgeCursor("cursor");
    target.ledger.compact();
    assert.equal(target.ledger.get(admission.commandId), undefined);
    assert.equal(target.ledger.admit(admission).kind, "expired");
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

test("fails admission closed when the newest durable generation is corrupt", () => {
  const target = tempLedger();
  try {
    target.ledger.admit(admission);
    target.ledger.markRunning(admission.commandId, admission.authority, admission.admittedGeneration);
    writeFileSync(`${target.fileBase}.a.json`, "{corrupt");
    const recovered = new ReverseCommandLedger({ fileBase: target.fileBase });
    assert.equal(recovered.get(admission.commandId)?.state, "accepted");
    assert.equal(recovered.status().recoveredFromCorruption, true);
    assert.equal(recovered.status().recoveryBlocked, true);
    assert.equal(recovered.admit({ ...admission, commandId: "118f4f0c-9f30-7a61-bf1a-66d2582bdb4a" }).kind, "persist_failed");
    assert.equal(recovered.markRunning(admission.commandId, admission.authority, admission.admittedGeneration), false);
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

test("fails closed when both slots are corrupt instead of resetting the dedupe fence", () => {
  const target = tempLedger();
  try {
    target.ledger.admit(admission);
    target.ledger.markRunning(admission.commandId, admission.authority, admission.admittedGeneration);
    writeFileSync(`${target.fileBase}.a.json`, "{corrupt");
    writeFileSync(`${target.fileBase}.b.json`, "{corrupt");
    const recovered = new ReverseCommandLedger({ fileBase: target.fileBase });
    assert.equal(recovered.status().recoveryBlocked, true);
    assert.equal(recovered.admit(admission).kind, "persist_failed");
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});

test("CAS lifecycle cannot revive terminal work", () => {
  const target = tempLedger();
  try {
    target.ledger.admit(admission);
    assert.equal(target.ledger.markRunning(admission.commandId, admission.authority, admission.admittedGeneration), true);
    assert.equal(target.ledger.markTerminal(
      admission.commandId,
      admission.authority,
      admission.admittedGeneration,
      { type: "command_result", code: "OK" },
    ), true);
    assert.equal(target.ledger.markRunning(admission.commandId, admission.authority, admission.admittedGeneration), false);
    assert.equal(target.ledger.get(admission.commandId)?.state, "terminal");
  } finally {
    rmSync(target.directory, { recursive: true, force: true });
  }
});
