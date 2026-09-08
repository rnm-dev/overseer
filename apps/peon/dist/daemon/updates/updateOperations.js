import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isGitCheckout, readLocalSha } from "../../shared/repo.js";
import { startSelfUpdate } from "./selfUpdate.js";
import { readUpdateCommandReceipt, writeUpdateCommandReceipt } from "./updateCommandReceipt.js";
import { readUpdateRuntimeIdentity } from "./updateRuntimeIdentity.js";
import { updateChecker } from "./updateChecker.js";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
let preflightActive = false;
function runtimeIdentity() {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    const installed = readUpdateRuntimeIdentity(PACKAGE_ROOT);
    return installed && installed.version === manifest.version
        ? installed
        : { version: manifest.version, revision: readLocalSha(PACKAGE_ROOT), sha256: null };
}
function statusView() {
    const state = updateChecker.getState();
    return {
        updateAvailable: state.updateAvailable,
        currentVersion: state.currentVersion,
        latestVersion: state.latestVersion,
        currentRevision: state.currentRevision,
        latestRevision: state.latestRevision,
        checkedAt: state.checkedAt,
        checkError: state.error,
    };
}
function boundedReceipt(receipt) {
    if (receipt.state === "running" || receipt.state === "ready_to_attest") {
        return { requestId: receipt.commandId, status: "pending", code: "UPDATE_PENDING" };
    }
    if (receipt.state === "succeeded") {
        return {
            requestId: receipt.commandId,
            status: "applied",
            code: "OK",
            result: {
                version: receipt.actualVersion ?? null,
                revision: receipt.actualRevision ?? null,
                sha256: receipt.actualSha256 ?? null,
                attested: true,
            },
        };
    }
    return { requestId: receipt.commandId, status: "failed", code: receipt.code ?? "UPDATE_FAILED" };
}
export function recoverUpdateOperation(runningPid = process.pid, runningIdentity) {
    const receipt = readUpdateCommandReceipt();
    if (!receipt || receipt.state !== "ready_to_attest" || receipt.initiatorPid === runningPid)
        return receipt;
    const actual = runningIdentity ?? runtimeIdentity();
    const matches = receipt.expectedVersion !== null
        && receipt.expectedVersion === actual.version
        && receipt.expectedRevision === actual.revision
        && receipt.expectedSha256 === actual.sha256;
    const recovered = matches
        ? {
            ...receipt,
            state: "succeeded",
            code: "OK",
            attested: true,
            actualVersion: actual.version,
            actualRevision: actual.revision,
            actualSha256: actual.sha256,
            updatedAt: Date.now(),
        }
        : {
            ...receipt,
            state: "failed",
            code: "ATTESTATION_MISMATCH",
            attested: false,
            actualVersion: actual.version,
            actualRevision: actual.revision,
            actualSha256: actual.sha256,
            updatedAt: Date.now(),
        };
    writeUpdateCommandReceipt(recovered);
    return recovered;
}
export async function checkUpdate() {
    if (process.env.PEON_DESKTOP === "1") {
        return { status: 409, body: { code: "DESKTOP_MANAGED", error: "Update Peon Desktop using its Windows installer." } };
    }
    if (preflightActive) {
        return { status: 409, body: { error: "another update operation is in progress", code: "UPDATE_IN_PROGRESS" } };
    }
    const active = recoverUpdateOperation();
    if (active?.state === "running" || active?.state === "ready_to_attest") {
        return { status: 409, body: { error: "another update operation is in progress", code: "UPDATE_IN_PROGRESS" } };
    }
    preflightActive = true;
    try {
        await updateChecker.checkNow();
        const state = updateChecker.getState();
        if (state.error)
            return { status: 503, body: { error: "npm registry is unavailable", code: "REGISTRY_UNAVAILABLE" } };
        return {
            status: 200,
            body: {
                status: state.updateAvailable ? "available" : "current",
                code: state.updateAvailable ? "OK" : "NO_UPDATE",
                result: statusView(),
            },
        };
    }
    finally {
        preflightActive = false;
    }
}
export async function applyUpdate(requestId, body) {
    if (process.env.PEON_DESKTOP === "1") {
        return { status: 409, body: { code: "DESKTOP_MANAGED", error: "Update Peon Desktop using its Windows installer." } };
    }
    if (!REQUEST_ID.test(requestId)) {
        return { status: 400, body: { error: "Peon-Request-Id is required", code: "BAD_REQUEST" } };
    }
    const payload = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const force = payload.force === true;
    if (Object.keys(payload).some((key) => key !== "force")) {
        return { status: 400, body: { error: "unsupported update option", code: "BAD_REQUEST" } };
    }
    if (preflightActive) {
        return { status: 409, body: { error: "another update operation is in progress", code: "UPDATE_IN_PROGRESS" } };
    }
    const existing = recoverUpdateOperation();
    if (existing?.commandId === requestId) {
        const response = boundedReceipt(existing);
        return { status: existing.state === "running" || existing.state === "ready_to_attest" ? 202 : 200, body: response };
    }
    if (existing?.state === "running" || existing?.state === "ready_to_attest") {
        return { status: 409, body: { error: "another update operation is in progress", code: "UPDATE_IN_PROGRESS" } };
    }
    if (isGitCheckout(PACKAGE_ROOT)) {
        return { status: 409, body: { error: "source checkouts cannot attest process replacement", code: "UPDATE_BLOCKED" } };
    }
    preflightActive = true;
    try {
        await updateChecker.checkNow();
        const state = updateChecker.getState();
        if (state.error)
            return { status: 503, body: { error: "npm registry is unavailable", code: "REGISTRY_UNAVAILABLE" } };
        if (!state.updateAvailable && !force) {
            return { status: 200, body: { requestId, status: "noop", code: "NO_UPDATE", result: statusView() } };
        }
        writeUpdateCommandReceipt({
            version: 1,
            commandId: requestId,
            expectedVersion: state.latestVersion,
            expectedRevision: null,
            expectedSha256: null,
            initiatorPid: process.pid,
            state: "running",
            updatedAt: Date.now(),
        });
        const launch = startSelfUpdate({
            force,
            command: {
                commandId: requestId,
                expectedVersion: state.latestVersion,
                expectedRevision: null,
                expectedSha256: null,
            },
        });
        if (launch.busy) {
            writeUpdateCommandReceipt({
                ...readUpdateCommandReceipt(),
                state: "failed",
                code: "UPDATE_BLOCKED",
                updatedAt: Date.now(),
            });
            return { status: 409, body: { error: "update admission is blocked", code: "UPDATE_BLOCKED" } };
        }
        return { status: 202, body: { requestId, status: "pending", code: "UPDATE_PENDING" } };
    }
    finally {
        preflightActive = false;
    }
}
export function updateOperationStatus(requestId) {
    const receipt = recoverUpdateOperation();
    if (!receipt || receipt.commandId !== requestId) {
        return { status: 404, body: { error: "unknown update operation", code: "UNKNOWN_UPDATE" } };
    }
    const pending = receipt.state === "running" || receipt.state === "ready_to_attest";
    return { status: pending ? 202 : 200, body: boundedReceipt(receipt) };
}
