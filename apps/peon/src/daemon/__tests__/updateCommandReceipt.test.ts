import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  attestUpdateCommand,
  waitForUpdateReplacement,
} from "../overseer/socket/channels/updateCommandHandlers.js";
import { readUpdateCommandReceipt, writeUpdateCommandReceipt } from "../updateCommandReceipt.js";
import { ReverseCommandLedger } from "../overseer/socket/reverseCommandLedger.js";

test("update command receipt survives process replacement and gates success on attestation", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-update-command-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  try {
    writeUpdateCommandReceipt({
      version: 1,
      commandId: "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      expectedVersion: "999.0.0",
      expectedRevision: null,
      expectedSha256: "a".repeat(64),
      initiatorPid: process.pid - 1,
      state: "ready_to_attest",
      updatedAt: 1,
    });
    assert.equal(readUpdateCommandReceipt()?.state, "ready_to_attest");
    const result = attestUpdateCommand("018f4f0c-9f30-7a61-bf1a-66d2582bdb4a");
    assert.equal(result?.status, "failed");
    assert.equal(result?.code, "ATTESTATION_MISMATCH");
    assert.equal(result?.result?.attested, false);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed update receipts expose only a stable code", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-update-command-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  try {
    writeUpdateCommandReceipt({
      version: 1,
      commandId: "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      expectedVersion: null,
      expectedRevision: null,
      expectedSha256: null,
      initiatorPid: process.pid - 1,
      state: "failed",
      code: "INSTALL_FAILED_ROLLED_BACK",
      updatedAt: 1,
    });
    assert.deepEqual(attestUpdateCommand("018f4f0c-9f30-7a61-bf1a-66d2582bdb4a"), {
      status: "failed",
      code: "INSTALL_FAILED_ROLLED_BACK",
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the launching daemon never attests a ready receipt before process replacement", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-update-command-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  const commandId = "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  try {
    writeUpdateCommandReceipt({
      version: 1,
      commandId,
      expectedVersion: null,
      expectedRevision: null,
      expectedSha256: null,
      initiatorPid: process.pid,
      state: "ready_to_attest",
      updatedAt: 1,
    });
    assert.deepEqual(await waitForUpdateReplacement(commandId, { timeoutMs: 5, pollMs: 1 }), {
      status: "failed",
      code: "RESTART_TIMEOUT",
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("updated files cannot attest until a replacement process is running", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-update-command-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  const commandId = "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  try {
    writeUpdateCommandReceipt({
      version: 1,
      commandId,
      expectedVersion: null,
      expectedRevision: null,
      expectedSha256: null,
      initiatorPid: 4242,
      state: "ready_to_attest",
      updatedAt: 1,
    });
    assert.equal(attestUpdateCommand(commandId, { runningPid: 4242 }), null);
    assert.equal(attestUpdateCommand(commandId, { runningPid: 4243 })?.status, "applied");
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("replacement success requires exact version, immutable revision and SHA-256", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-update-command-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  const commandId = "028f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  const expected = { version: "1.2.3", revision: "revision-a", sha256: "a".repeat(64) };
  try {
    writeUpdateCommandReceipt({
      version: 1,
      commandId,
      expectedVersion: expected.version,
      expectedRevision: expected.revision,
      expectedSha256: expected.sha256,
      initiatorPid: 4242,
      state: "ready_to_attest",
      updatedAt: 1,
    });
    assert.equal(attestUpdateCommand(commandId, {
      runningPid: 4243,
      runningIdentity: expected,
    })?.status, "applied");
    for (const runningIdentity of [
      { ...expected, revision: "revision-b" },
      { ...expected, sha256: "b".repeat(64) },
    ]) {
      const result = attestUpdateCommand(commandId, { runningPid: 4243, runningIdentity });
      assert.equal(result?.code, "ATTESTATION_MISMATCH");
      assert.equal(result?.result?.attested, false);
    }
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart while updater is still running preserves the admitted command", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-update-ledger-"));
  try {
    const ledger = new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") });
    const admitted = ledger.admit({
      commandId: "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      requestHash: "hash",
      operation: "update.apply",
      peonId: "f4de920f-e33e-4cf5-97d0-3a75e9266090",
      actorUserId: "b169219d-45f6-4f42-b78f-3fb931dac7ee",
      authority: "authority",
      admittedGeneration: 1,
      command: {},
    });
    assert.equal(admitted.kind, "accepted");
    assert.equal(ledger.markRunning(
      "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a", "authority", 1,
    ), true);
    ledger.recoverInterrupted(() => null);
    assert.equal(ledger.get("018f4f0c-9f30-7a61-bf1a-66d2582bdb4a")?.state, "running");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
