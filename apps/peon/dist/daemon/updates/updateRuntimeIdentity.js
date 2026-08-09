import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9A-Za-z._:+-]{1,128}$/;
const FILE_NAME = ".peon-release-identity.json";
export function isUpdateReleaseIdentity(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const candidate = value;
    return Object.keys(candidate).length === 3
        && typeof candidate.version === "string" && candidate.version.length > 0 && candidate.version.length <= 128
        && typeof candidate.revision === "string" && REVISION.test(candidate.revision)
        && typeof candidate.sha256 === "string" && SHA256.test(candidate.sha256);
}
export function sameUpdateReleaseIdentity(approved, observed) {
    return approved.version === observed.version
        && approved.revision === observed.revision
        && approved.sha256 === observed.sha256;
}
export function updateRuntimeIdentityPath(packageRoot) {
    return path.join(packageRoot, FILE_NAME);
}
export function readUpdateRuntimeIdentity(packageRoot) {
    const file = updateRuntimeIdentityPath(packageRoot);
    if (!existsSync(file))
        return null;
    try {
        const value = JSON.parse(readFileSync(file, "utf8"));
        return isUpdateReleaseIdentity(value) ? value : null;
    }
    catch {
        return null;
    }
}
export function writeUpdateRuntimeIdentity(packageRoot, identity) {
    if (!isUpdateReleaseIdentity(identity))
        throw new Error("invalid update runtime identity");
    writeFileSync(updateRuntimeIdentityPath(packageRoot), JSON.stringify(identity), {
        encoding: "utf8",
        mode: 0o600,
        flag: "w",
    });
}
