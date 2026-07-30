import { ReverseCommandLifecycleHarness } from "./reverseCommandLifecycle.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FAILURE_CODES = new Set([
  "REGISTRY_UNAVAILABLE", "RELEASE_CHANGED", "DOWNLOAD_FAILED",
  "ARCHIVE_INTEGRITY_FAILED", "UPDATE_FAILED", "INSTALL_FAILED_ROLLED_BACK",
  "INSTALL_FAILED_ROLLBACK_FAILED", "RESTART_FAILED_ROLLED_BACK",
  "RESTART_FAILED_ROLLBACK_FAILED", "RESTART_TIMEOUT",
  "RESTART_TIMEOUT_ROLLED_BACK", "RESTART_TIMEOUT_ROLLBACK_FAILED",
  "ATTESTATION_MISMATCH", "UPDATE_BLOCKED",
]);

function validRelease(release) {
  return release && VERSION.test(release.version)
    && (release.revision === null || REVISION.test(release.revision))
    && SHA256.test(release.sha256)
    && Number.isSafeInteger(release.size) && release.size > 0;
}

export function validateUpdateFrame(frame, errors, kind) {
  if (!frame || typeof frame !== "object" || !UUID.test(frame.commandId)) {
    errors.push("invalid update command identity");
    return;
  }
  if (kind === "command") {
    if (frame.type !== "command" || frame.protocol !== 1 || frame.capability !== "reverse-command-v1"
      || frame.operation !== "update.apply" || !UUID.test(frame.target?.peonId)
      || !UUID.test(frame.actor?.userId) || typeof frame.actor?.email !== "string"
      || frame.expected !== null || !frame.payload || Object.keys(frame.payload).some((key) => key !== "force")
      || (frame.payload.force !== undefined && typeof frame.payload.force !== "boolean")
      || !Number.isSafeInteger(frame.requestedAt)) errors.push("invalid update.apply command");
  } else if (kind === "accepted") {
    if (frame.type !== "command_accepted" || frame.protocol !== 1 || frame.operation !== "update.apply"
      || !["accepted", "running"].includes(frame.state) || typeof frame.replayed !== "boolean"
      || !Number.isSafeInteger(frame.acceptedAt)) errors.push("invalid update acceptance");
  } else if (kind === "status") {
    if (frame.type !== "command_status" || frame.protocol !== 1
      || !["unknown", "accepted", "running", "terminal"].includes(frame.state)
      || (frame.state === "terminal") !== (frame.result !== undefined)) errors.push("invalid update status");
  } else if (kind === "result") {
    const applied = frame.status === "applied" && frame.code === "OK"
      && VERSION.test(frame.result?.version)
      && (frame.result.revision === null || REVISION.test(frame.result.revision))
      && frame.result.attested === true;
    const failed = ["failed", "rejected"].includes(frame.status)
      && FAILURE_CODES.has(frame.code) && frame.result === null;
    if (frame.type !== "command_result" || frame.protocol !== 1 || frame.operation !== "update.apply"
      || !Number.isSafeInteger(frame.completedAt) || (!applied && !failed)) errors.push("invalid safe update result");
  }
}

export class UpdateLifecycleHarness extends ReverseCommandLifecycleHarness {
  constructor(options = {}) {
    super(options);
    this.receipts = new Map();
    this.installerLaunches = new Set();
  }

  admit(command, approvedRelease) {
    if (!validRelease(approvedRelease)) throw new Error("INVALID_RELEASE");
    const accepted = this.submit(command);
    this.deliverAccepted(accepted);
    const record = this.peon.ledger.get(command.commandId);
    if (!this.receipts.has(command.commandId)) {
      this.receipts.set(command.commandId, {
        commandId: command.commandId,
        expectedVersion: approvedRelease.version,
        expectedRevision: approvedRelease.revision,
        initiatorPid: 4242,
        state: "running",
      });
      record.state = "running";
    }
    return accepted;
  }

  install(commandId, fetchedRelease, options = {}) {
    const receipt = this.receipts.get(commandId);
    const record = this.peon.ledger.get(commandId);
    if (!receipt || !record) return null;
    if (!validRelease(fetchedRelease)
      || (options.downloadedSize ?? fetchedRelease.size) !== fetchedRelease.size
      || (options.downloadedSha256 ?? fetchedRelease.sha256) !== fetchedRelease.sha256) {
      return this.fail(commandId, "ARCHIVE_INTEGRITY_FAILED");
    }
    if (fetchedRelease.version !== receipt.expectedVersion) return this.fail(commandId, "RELEASE_CHANGED");
    if (this.installerLaunches.has(commandId)) return null;
    this.installerLaunches.add(commandId);
    this.peon.effectIds.add(commandId);
    if (options.code) return this.fail(commandId, options.code);
    receipt.state = "ready_to_attest";
    return null;
  }

  attest(commandId, running) {
    const receipt = this.receipts.get(commandId);
    const record = this.peon.ledger.get(commandId);
    if (!receipt || !record || receipt.state !== "ready_to_attest") return null;
    if (running.pid === receipt.initiatorPid) return null;
    const matches = running.version === receipt.expectedVersion
      && running.revision === receipt.expectedRevision;
    const result = matches
      ? this.#result(record.command, "applied", "OK", {
        version: running.version, revision: running.revision, attested: true,
      })
      : this.#result(record.command, "failed", "ATTESTATION_MISMATCH", null);
    record.state = "terminal";
    record.result = result;
    receipt.state = matches ? "ready_to_attest" : "failed";
    return this.#publish(result);
  }

  fail(commandId, code) {
    if (!FAILURE_CODES.has(code)) throw new Error("INVALID_UPDATE_CODE");
    const record = this.peon.ledger.get(commandId);
    const receipt = this.receipts.get(commandId);
    if (!record || !receipt) return null;
    receipt.state = "failed";
    const result = this.#result(record.command, code === "UPDATE_BLOCKED" ? "rejected" : "failed", code, null);
    record.state = "terminal";
    record.result = result;
    return this.#publish(result);
  }

  status(commandId) {
    return this.peon.status(commandId);
  }

  corruptReceipt(commandId) {
    const receipt = this.receipts.get(commandId);
    if (receipt) receipt.expectedRevision = "torn";
  }

  recoverReceipts() {
    for (const [commandId, receipt] of this.receipts) {
      if (!UUID.test(receipt.commandId)
        || (receipt.expectedRevision !== null && !REVISION.test(receipt.expectedRevision))
        || !["running", "ready_to_attest", "failed"].includes(receipt.state)) {
        this.receipts.delete(commandId);
      }
    }
  }

  #publish(result) {
    return this.results.append(result, { messageId: `result:${result.commandId}` }).cursor;
  }

  #result(command, status, code, result) {
    return {
      type: "command_result", protocol: 1, commandId: command.commandId,
      operation: "update.apply", status, code,
      completedAt: command.requestedAt + 2, result,
    };
  }
}
