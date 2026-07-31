import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readUpdateCommandReceipt, writeUpdateCommandReceipt } from "../updateCommandReceipt.js";
import { recoverUpdateOperation, updateOperationStatus } from "../updateOperations.js";

function isolated(run: () => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-update-http-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("npm replacement success requires the admitted exact version", () => isolated(() => {
  const expected = { version: "1.2.3", revision: null, sha256: null };
  writeUpdateCommandReceipt({
    version: 1,
    commandId: "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    expectedVersion: expected.version,
    expectedRevision: expected.revision,
    expectedSha256: expected.sha256,
    initiatorPid: 4242,
    state: "ready_to_attest",
    updatedAt: 1,
  });
  assert.equal(recoverUpdateOperation(4243, expected)?.state, "succeeded");
  assert.deepEqual(updateOperationStatus("018f4f0c-9f30-7a61-bf1a-66d2582bdb4a"), {
    status: 200,
    body: {
      requestId: "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      status: "applied",
      code: "OK",
      result: { ...expected, attested: true },
    },
  });
}));

test("the initiating process cannot attest disk replacement", () => isolated(() => {
  writeUpdateCommandReceipt({
    version: 1,
    commandId: "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    expectedVersion: "1.2.3",
    expectedRevision: "revision-a",
    expectedSha256: "a".repeat(64),
    initiatorPid: 4242,
    state: "ready_to_attest",
    updatedAt: 1,
  });
  assert.equal(recoverUpdateOperation(4242, {
    version: "1.2.3", revision: "revision-a", sha256: "a".repeat(64),
  })?.state, "ready_to_attest");
}));

test("attestation mismatch is terminal and exposes only bounded identity fields", () => isolated(() => {
  writeUpdateCommandReceipt({
    version: 1,
    commandId: "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    expectedVersion: "1.2.3",
    expectedRevision: "revision-a",
    expectedSha256: "a".repeat(64),
    initiatorPid: 4242,
    state: "ready_to_attest",
    updatedAt: 1,
  });
  assert.equal(recoverUpdateOperation(4243, {
    version: "1.2.3", revision: "revision-b", sha256: "a".repeat(64),
  })?.code, "ATTESTATION_MISMATCH");
  assert.equal(readUpdateCommandReceipt()?.attested, false);
  assert.deepEqual(updateOperationStatus("018f4f0c-9f30-7a61-bf1a-66d2582bdb4a").body, {
    requestId: "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    status: "failed",
    code: "ATTESTATION_MISMATCH",
  });
}));
