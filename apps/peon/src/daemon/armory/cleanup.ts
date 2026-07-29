import { readdir, rm, stat } from "node:fs/promises";
import { MAX_OPERATION_HISTORY } from "./contracts.js";
import { resolveContainedPath, type ArmoryPaths } from "./paths.js";
import { ArmoryOperationStore } from "./stores.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArmoryCleanupOptions {
  now?: number;
  maxOperationHistory?: number;
  stagingMaxAgeMs?: number;
  logMaxAgeMs?: number;
}

export interface ArmoryCleanupResult {
  operationsRemoved: number;
  stagingRemoved: number;
  logsRemoved: number;
}

async function removeOldChildren(root: string, cutoff: number, kind: "directory" | "file"): Promise<number> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let removed = 0;
  for (const entry of entries) {
    const matchesKind = kind === "directory" ? entry.isDirectory() : entry.isFile();
    if (!matchesKind) continue;
    const target = resolveContainedPath(root, entry.name);
    const details = await stat(target);
    if (details.mtimeMs >= cutoff) continue;
    await rm(target, { recursive: kind === "directory", force: true });
    removed += 1;
  }
  return removed;
}

export async function cleanupArmoryArtifacts(paths: ArmoryPaths, options: ArmoryCleanupOptions = {}): Promise<ArmoryCleanupResult> {
  const now = options.now ?? Date.now();
  const operations = new ArmoryOperationStore(paths.operationsDir, options.maxOperationHistory ?? MAX_OPERATION_HISTORY);
  return {
    operationsRemoved: await operations.prune(options.maxOperationHistory),
    stagingRemoved: await removeOldChildren(paths.stagingDir, now - (options.stagingMaxAgeMs ?? DAY_MS), "directory"),
    logsRemoved: await removeOldChildren(paths.logsDir, now - (options.logMaxAgeMs ?? 30 * DAY_MS), "file"),
  };
}
