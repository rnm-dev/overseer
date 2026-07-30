import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isGitCheckout, readLocalSha } from "../../../../shared/repo.js";
import { startSelfUpdate } from "../../../selfUpdate.js";
import { readUpdateCommandReceipt } from "../../../updateCommandReceipt.js";
import {
  isUpdateReleaseIdentity,
  readUpdateRuntimeIdentity,
} from "../../../updateRuntimeIdentity.js";
import { updateChecker } from "../../../updateChecker.js";
import type { ReverseCommandExecution, ReverseCommandHandler } from "./reverseCommandChannel.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

function attestation() {
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };
  const installed = readUpdateRuntimeIdentity(PACKAGE_ROOT);
  return installed && installed.version === manifest.version
    ? installed
    : { version: manifest.version, revision: readLocalSha(PACKAGE_ROOT), sha256: null };
}

function statusResult(): Record<string, unknown> {
  const state = updateChecker.getState();
  return {
    updateAvailable: state.updateAvailable, currentVersion: state.currentVersion,
    latestVersion: state.latestVersion, currentRevision: state.currentRevision,
    latestRevision: state.latestRevision, checkedAt: state.checkedAt, checkError: state.error,
  };
}

export function attestUpdateCommand(
  commandId: string,
  options: {
    runningPid?: number;
    runningIdentity?: { version: string; revision: string | null; sha256: string | null };
  } = {},
): ReverseCommandExecution | null {
  const receipt = readUpdateCommandReceipt();
  if (!receipt || receipt.commandId !== commandId || receipt.state === "running") return null;
  if (receipt.state === "failed") return {
    status: receipt.code === "NO_UPDATE" ? "noop" : "failed",
    code: receipt.code ?? "UPDATE_FAILED",
  };
  // Disk replacement is not process replacement. Only a daemon other than the
  // one that admitted/launched the update may attest the new running code.
  if (receipt.initiatorPid === (options.runningPid ?? process.pid)) return null;
  const running = options.runningIdentity ?? attestation();
  const matches = (receipt.expectedVersion === null || receipt.expectedVersion === running.version)
    && (receipt.expectedRevision === null || receipt.expectedRevision === running.revision);
  const identityMatches = matches
    && (receipt.expectedSha256 === null || receipt.expectedSha256 === running.sha256);
  return matches
    && identityMatches
    ? { status: "applied", code: "OK", result: { ...running, attested: true } }
    : { status: "failed", code: "ATTESTATION_MISMATCH", result: { ...running, attested: false } };
}

export async function waitForUpdateReplacement(
  commandId: string,
  options: { timeoutMs?: number; pollMs?: number; attestReady?: boolean } = {},
): Promise<ReverseCommandExecution> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const receipt = readUpdateCommandReceipt();
    if (receipt?.commandId === commandId && receipt.state === "failed") {
      return attestUpdateCommand(commandId) ?? { status: "failed", code: "UPDATE_FAILED" };
    }
    if (options.attestReady) {
      const attested = attestUpdateCommand(commandId);
      if (attested) return attested;
    }
    // A ready receipt is deliberately not attested by the process that launched
    // the updater. The replacement daemon owns that decision in started(); this
    // process may still be alive between the disk swap and systemd restart.
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250));
  }
  return { status: "failed", code: "RESTART_TIMEOUT" };
}

export function updateCommandHandlers(): Record<string, ReverseCommandHandler> {
  return {
    "update.check": {
      priority: "control", maxConcurrency: 1,
      validate: (payload, expected) => Object.keys(payload).length === 0 && expected === null ? null : "invalid update.check payload",
      execute: async () => {
        await updateChecker.checkNow();
        const state = updateChecker.getState();
        if (state.error) return { status: "failed", code: "REGISTRY_UNAVAILABLE" };
        return { status: state.updateAvailable ? "applied" : "noop", code: state.updateAvailable ? "OK" : "NO_UPDATE", result: statusResult() };
      },
    },
    "update.apply": {
      priority: "control", maxConcurrency: 1,
      validate: (payload, expected) => expected === null
        && Object.keys(payload).every((key) => key === "force" || key === "release")
        && (payload.force === undefined || typeof payload.force === "boolean") ? null : "invalid update.apply payload",
      execute: async (command) => {
        if (!isUpdateReleaseIdentity(command.payload.release)) {
          return { status: "rejected", code: "UPDATE_BLOCKED" };
        }
        if (isGitCheckout(PACKAGE_ROOT)) {
          // Checkout updates do not synchronously replace the daemon. Reporting
          // success from the old process would attest files on disk, not the
          // code actually serving this socket.
          return { status: "rejected", code: "UPDATE_BLOCKED" };
        }
        await updateChecker.checkNow();
        const state = updateChecker.getState();
        if (state.error) return { status: "failed", code: "REGISTRY_UNAVAILABLE" };
        if (!state.updateAvailable && command.payload.force !== true) return { status: "noop", code: "NO_UPDATE", result: statusResult() };
        const launch = startSelfUpdate({
          force: command.payload.force === true,
          command: {
            commandId: command.commandId,
            expectedVersion: command.payload.release.version,
            expectedRevision: command.payload.release.revision,
            expectedSha256: command.payload.release.sha256,
          },
        });
        if (launch.busy) return { status: "rejected", code: "UPDATE_BLOCKED" };
        return waitForUpdateReplacement(command.commandId);
      },
    },
  };
}
