import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AtomicJsonStore, syncDirectory } from "./atomicJsonStore.js";
import { installedArmoryPackageSchema, parseArmoryManifest, type ArmoryActivation, type ArmoryHookInput, type ArmoryManifest, type ArmoryOperation, type InstalledArmoryPackage } from "./contracts.js";
import { ArmoryHookRunner } from "./hookRunner.js";
import { getArmoryActivation } from "./installer.js";
import { ArmoryOperationError, ArmoryOperationCoordinator } from "./operationCoordinator.js";
import { assertPackageId, packageActivationPath, packageVersionPath, resolveContainedPath } from "./paths.js";
import { initializeArmoryDirectories, type ArmoryStores } from "./stores.js";

const JOURNAL_FILE = "uninstall-transaction.json";
const journalSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.uuid(),
  packageId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  version: z.string().min(1),
  installed: installedArmoryPackageSchema,
  phase: z.enum(["prepared", "hook_completed", "activation_removed"]),
}).strict();
type UninstallJournal = z.infer<typeof journalSchema>;

export interface ArmoryPackageUninstallApi {
  uninstall(packageId: string): Promise<ArmoryOperation>;
}

export class ArmoryUninstallService implements ArmoryPackageUninstallApi {
  readonly operations: ArmoryOperationCoordinator;
  private readonly hookRunner: ArmoryHookRunner;
  private readonly now: () => number;
  private readonly platform: { os: "darwin" | "linux"; arch: "x64" | "arm64" };

  constructor(private readonly options: {
    stores: ArmoryStores;
    runtime: { stop(packageId: string): Promise<void> };
    hookRunner?: ArmoryHookRunner;
    now?: () => number;
    platform?: { os: "darwin" | "linux"; arch: "x64" | "arm64" };
  }) {
    this.hookRunner = options.hookRunner ?? new ArmoryHookRunner();
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? currentPlatform();
    this.operations = new ArmoryOperationCoordinator(options.stores.operations, this.now);
  }

  async uninstall(packageIdValue: string): Promise<ArmoryOperation> {
    const packageId = assertPackageId(packageIdValue);
    const result = await this.operations.start(packageId, "uninstall", async (operation) => {
      const active = await loadActivePackage(this.options.stores, packageId);
      const staging = resolveContainedPath(this.options.stores.paths.stagingDir, operation.operationId);
      let hookCompleted = false;
      await writeJournal(staging, {
        schemaVersion: 1,
        operationId: operation.operationId,
        packageId,
        version: active.activation.version,
        installed: active.installed,
        phase: "prepared",
      });
      await this.options.stores.installed.set({
        ...active.activation.installed,
        enabled: false,
        state: "removing",
        activeOperationId: operation.operationId,
        lastError: null,
        updatedAt: this.now(),
      });
      try {
        await operation.update("stopping", 20, "Stopping package MCP server");
        await this.options.runtime.stop(packageId);
        if (active.manifest.lifecycle?.preUninstall) {
          const home = resolveContainedPath(this.options.stores.paths.homesDir, packageId);
          await operation.update("pre_uninstall", 40, "Running package pre-uninstall hook");
          await this.hookRunner.run({
            command: active.manifest.lifecycle.preUninstall,
            input: hookInput(active, home, this.platform),
            packageDir: active.packageDir,
            managedHome: home,
            environment: providerEnvironment(active.manifest, home),
            onProgress: (event) => operation.update(event.phase, event.percent, event.message),
          });
        }
        await writeJournal(staging, {
          schemaVersion: 1,
          operationId: operation.operationId,
          packageId,
          version: active.activation.version,
          installed: active.installed,
          phase: "hook_completed",
        });
        hookCompleted = true;
        await operation.update("removing", 70, "Removing package activation and runtime files");
        await removeActivation(this.options.stores, packageId);
        await writeJournal(staging, {
          schemaVersion: 1,
          operationId: operation.operationId,
          packageId,
          version: active.activation.version,
          installed: active.installed,
          phase: "activation_removed",
        });
        await finishCommittedUninstall(this.options.stores, packageId);
      } catch (error) {
        if (!hookCompleted) {
          await restoreAfterUninstallFailure(this.options.stores, active.installed, error, this.now());
          await removeDurably(staging);
        }
        throw error;
      }
    });
    void this.operations.wait(result.id).then(async (completed) => {
      if (completed.status === "success") await removeDurably(resolveContainedPath(this.options.stores.paths.stagingDir, result.id));
    }).catch(() => undefined);
    return result;
  }
}

interface ActivePackage { activation: ArmoryActivation; installed: InstalledArmoryPackage; manifest: ArmoryManifest; packageDir: string }

async function loadActivePackage(stores: ArmoryStores, packageId: string): Promise<ActivePackage> {
  const activation = await getArmoryActivation(stores, packageId);
  const installed = await stores.installed.get(packageId);
  if (!activation || !installed) throw new ArmoryOperationError("PACKAGE_NOT_ACTIVE", `Armory package is not installed: ${packageId}`);
  const packageDir = packageVersionPath(stores.paths, packageId, activation.version);
  try {
    const manifest = parseArmoryManifest(JSON.parse(await readFile(resolveContainedPath(packageDir, "armory.package.json"), "utf8")));
    return { activation, installed, manifest, packageDir };
  } catch (error) {
    throw new ArmoryOperationError("MANIFEST_INVALID", `Armory package manifest is invalid: ${packageId}`, { cause: error });
  }
}

function hookInput(active: ActivePackage, home: string, platform: { os: "darwin" | "linux"; arch: "x64" | "arm64" }): ArmoryHookInput {
  return {
    protocolVersion: 1,
    type: "input",
    operation: "pre_uninstall",
    package: { id: active.manifest.id, version: active.manifest.version, dir: active.packageDir, home },
    platform,
  };
}

function providerEnvironment(manifest: ArmoryManifest, home: string): Record<string, string> {
  return Object.fromEntries(Object.entries(manifest.configuration?.environment ?? {}).map(([name, relative]) => [name, resolveContainedPath(home, relative)]));
}

async function writeJournal(staging: string, journal: UninstallJournal): Promise<void> {
  const store = new AtomicJsonStore({ filePath: resolveContainedPath(staging, JOURNAL_FILE), schema: journalSchema, defaults: () => journal });
  await store.write(journal);
}

async function readJournal(staging: string): Promise<UninstallJournal | null> {
  try { return journalSchema.parse(JSON.parse(await readFile(resolveContainedPath(staging, JOURNAL_FILE), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return null; }
}

async function listJournals(stagingRoot: string): Promise<Map<string, UninstallJournal>> {
  const journals = new Map<string, UninstallJournal>();
  for (const entry of await readdir(stagingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const journal = await readJournal(resolveContainedPath(stagingRoot, entry.name));
    if (journal && journal.operationId === entry.name) journals.set(journal.operationId, journal);
  }
  return journals;
}

async function removeActivation(stores: ArmoryStores, packageId: string): Promise<void> {
  await rm(packageActivationPath(stores.paths, packageId), { force: true });
  await syncDirectory(stores.paths.activeDir);
}

async function finishCommittedUninstall(stores: ArmoryStores, packageId: string): Promise<void> {
  await removeDurably(resolveContainedPath(stores.paths.packagesDir, assertPackageId(packageId)));
  await stores.installed.remove(packageId);
}

async function removeDurably(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await syncDirectory(path.dirname(target));
}

async function restoreAfterUninstallFailure(stores: ArmoryStores, installed: InstalledArmoryPackage, error: unknown, now: number): Promise<void> {
  const message = error instanceof ArmoryOperationError ? error.message : "Armory uninstall failed";
  await stores.installed.set({
    ...installed,
    enabled: false,
    activeOperationId: null,
    lastError: message.slice(0, 4000),
    updatedAt: now,
  });
}

export async function recoverInterruptedArmoryUninstalls(stores: ArmoryStores, now = Date.now()): Promise<number> {
  await initializeArmoryDirectories(stores.paths);
  const operations = (await stores.operations.list()).filter((operation) => operation.kind === "uninstall");
  const journals = await listJournals(stores.paths.stagingDir);
  const activeIds = new Set((await stores.installed.list()).flatMap((record) => record.activeOperationId ? [record.activeOperationId] : []));
  const interrupted = operations.filter((operation) => operation.status === "queued" || operation.status === "running" || activeIds.has(operation.id) || journals.has(operation.id));
  for (const operation of interrupted) {
    const staging = resolveContainedPath(stores.paths.stagingDir, operation.id);
    const journal = journals.get(operation.id) ?? null;
    const activation = await getArmoryActivation(stores, operation.packageId).catch(() => null);
    if (!journal || journal.phase === "prepared") {
      if (journal) await restoreAfterUninstallFailure(stores, journal.installed, new ArmoryOperationError("UNINSTALL_INTERRUPTED", "Uninstall was interrupted before its hook completed"), now);
      else if (activation) await restoreAfterUninstallFailure(stores, activation.installed, new ArmoryOperationError("UNINSTALL_INTERRUPTED", "Uninstall was interrupted before preparation completed"), now);
      await removeDurably(staging).catch(() => undefined);
      await stores.operations.save({
        ...operation,
        status: journal ? "needs_human" : "failure",
        phase: journal ? "needs_human" : "failed",
        progress: null,
        message: journal ? "Pre-uninstall hook was interrupted; retry uninstall explicitly" : "Uninstall was interrupted before preparation completed",
        errorCode: journal ? "UNINSTALL_HOOK_INTERRUPTED" : "INTERRUPTED_OPERATION",
        finishedAt: now,
      });
      continue;
    }
    await removeActivation(stores, operation.packageId);
    await finishCommittedUninstall(stores, operation.packageId);
    await stores.operations.save({
      ...operation,
      status: "success",
      phase: "complete",
      progress: 100,
      message: "Recovered committed uninstall after daemon restart",
      errorCode: null,
      finishedAt: now,
    });
    await removeDurably(staging).catch(() => undefined);
  }
  return interrupted.length;
}

function currentPlatform(): { os: "darwin" | "linux"; arch: "x64" | "arm64" } {
  if ((process.platform !== "darwin" && process.platform !== "linux") || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new ArmoryOperationError("UNSUPPORTED_PLATFORM", `Armory does not support ${process.platform}/${process.arch}`);
  }
  return { os: process.platform, arch: process.arch };
}
