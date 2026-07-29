import { readdir, rm, stat } from "node:fs/promises";
import { MAX_OPERATION_HISTORY } from "./contracts.js";
import { resolveContainedPath } from "./paths.js";
import { ArmoryOperationStore } from "./stores.js";
const DAY_MS = 24 * 60 * 60 * 1000;
async function removeOldChildren(root, cutoff, kind) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === "ENOENT")
            return 0;
        throw error;
    }
    let removed = 0;
    for (const entry of entries) {
        const matchesKind = kind === "directory" ? entry.isDirectory() : entry.isFile();
        if (!matchesKind)
            continue;
        const target = resolveContainedPath(root, entry.name);
        const details = await stat(target);
        if (details.mtimeMs >= cutoff)
            continue;
        await rm(target, { recursive: kind === "directory", force: true });
        removed += 1;
    }
    return removed;
}
export async function cleanupArmoryArtifacts(paths, options = {}) {
    const now = options.now ?? Date.now();
    const operations = new ArmoryOperationStore(paths.operationsDir, options.maxOperationHistory ?? MAX_OPERATION_HISTORY);
    return {
        operationsRemoved: await operations.prune(options.maxOperationHistory),
        stagingRemoved: await removeOldChildren(paths.stagingDir, now - (options.stagingMaxAgeMs ?? DAY_MS), "directory"),
        logsRemoved: await removeOldChildren(paths.logsDir, now - (options.logMaxAgeMs ?? 30 * DAY_MS), "file"),
    };
}
