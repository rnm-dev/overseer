import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { z } from "zod";
import {
  armoryActivationSchema,
  armoryInstallSelectionSchema,
  installedArmoryPackageSchema,
  parseArmoryManifest,
  type ArmoryActivation,
  type ArmoryManifest,
  type ArmoryOperation,
  type InstalledArmoryPackage,
} from "./contracts.js";
import {
  assertManifestMatchesSelection,
  downloadArchive,
  extractInspectedArchive,
  inspectArchive,
  type ArchiveSelection,
} from "./archive.js";
import { AtomicJsonStore, syncDirectory } from "./atomicJsonStore.js";
import { ArmoryCatalogError, resolveCatalogVersion } from "./catalogClient.js";
import type { ArmoryInventoryReader } from "./inventory.js";
import { ArmoryOperationError, ArmoryOperationCoordinator } from "./operationCoordinator.js";
import { packageActivationPath, packageVersionPath, resolveContainedPath } from "./paths.js";
import { initializeArmoryDirectories, type ArmoryStores } from "./stores.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const INSTALL_JOURNAL_FILE = "install-transaction.json";
const installJournalSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.uuid(),
  packageId: armoryInstallSelectionSchema.shape.packageId,
  version: armoryInstallSelectionSchema.shape.version,
  kind: z.enum(["install", "update"]).optional(),
  phase: z.enum(["prepared", "version_moved", "runtime_stopped", "activation_committed", "runtime_started"]).optional(),
  previousActivation: armoryActivationSchema.nullable().optional(),
  previousInstalled: installedArmoryPackageSchema.nullable().optional(),
}).strict();
type InstallJournal = z.infer<typeof installJournalSchema>;

export interface ArmoryInstallerOptions {
  stores: ArmoryStores;
  runtime?: ArmoryUpdateRuntime;
  fetchImpl?: typeof fetch;
  downloadTimeoutMs?: number;
  maxDownloadBytes?: number;
  maxArchiveFiles?: number;
  maxExpandedBytes?: number;
  now?: () => number;
}

export interface ArmoryUpdateRuntime {
  healthCheck(packageId: string): Promise<void>;
  start(packageId: string): Promise<void>;
  stop(packageId: string): Promise<void>;
}

export interface ArmoryPackageInstallApi {
  install(packageId: string, options?: { version?: string }): Promise<ArmoryOperation>;
  update(packageId: string, options?: { version?: string }): Promise<ArmoryOperation>;
}

export class ArmoryPackageInstallService implements ArmoryPackageInstallApi {
  private readonly installer: ArmoryInstaller;

  constructor(private readonly options: {
    stores: ArmoryStores;
    inventory: ArmoryInventoryReader;
    installer?: ArmoryInstaller;
    runtime?: ArmoryUpdateRuntime;
    peonVersion?: string;
    platform?: { os: "darwin" | "linux"; arch: "x64" | "arm64" };
  }) {
    this.installer = options.installer ?? new ArmoryInstaller({ stores: options.stores, runtime: options.runtime });
  }

  async install(packageId: string, options: { version?: string } = {}): Promise<ArmoryOperation> {
    const active = await getArmoryActivation(this.options.stores, packageId);
    if (active) {
      throw new ArmoryOperationError("PACKAGE_ALREADY_INSTALLED", `Armory package is already installed: ${packageId}`);
    }

    return this.installer.install(await this.resolve(packageId, options));
  }

  async update(packageId: string, options: { version?: string } = {}): Promise<ArmoryOperation> {
    const active = await getArmoryActivation(this.options.stores, packageId);
    const installed = await this.options.stores.installed.get(packageId);
    if (!active || !installed) {
      throw new ArmoryOperationError("PACKAGE_NOT_ACTIVE", `Armory package is not installed: ${packageId}`);
    }
    const selected = await this.resolve(packageId, options);
    if (!semver.gt(selected.version, active.version)) {
      throw new ArmoryOperationError("NO_UPDATE_AVAILABLE", `Armory package ${packageId} has no update newer than ${active.version}`);
    }
    return this.installer.install(selected, "update");
  }

  private async resolve(packageId: string, options: { version?: string }): Promise<ArchiveSelection> {
    let detail;
    try {
      detail = await this.options.inventory.get(packageId);
    } catch (error) {
      if (error instanceof ArmoryCatalogError) throw new ArmoryOperationError(error.code, error.message, { cause: error });
      throw error;
    }
    if (!detail.catalog) {
      throw new ArmoryOperationError("PACKAGE_NOT_AVAILABLE", `Armory package is not available from the registry: ${packageId}`);
    }

    let selected;
    try {
      selected = resolveCatalogVersion(
        { schemaVersion: 1, name: "rnm-dev/armory", updatedAt: new Date(0).toISOString(), packages: [detail.catalog] },
        packageId,
        {
          version: options.version,
          peonVersion: this.options.peonVersion ?? "0.0.1",
          platform: this.options.platform ?? currentPlatform(),
        },
      );
    } catch (error) {
      if (error instanceof ArmoryCatalogError) throw new ArmoryOperationError(error.code, error.message, { cause: error });
      throw error;
    }

    return {
      packageId,
      version: selected.version,
      minPeonVersion: selected.minPeonVersion,
      platforms: selected.platforms,
      capabilities: detail.catalog.capabilities,
      archive: selected.archive,
    };
  }
}

export class ArmoryInstaller {
  readonly operations: ArmoryOperationCoordinator;
  private readonly now: () => number;

  constructor(private readonly options: ArmoryInstallerOptions) {
    this.now = options.now ?? Date.now;
    this.operations = new ArmoryOperationCoordinator(options.stores.operations, this.now);
  }

  async install(selectionValue: ArchiveSelection, kind: "install" | "update" = "install"): Promise<ArmoryOperation> {
    const selection = armoryInstallSelectionSchema.parse(selectionValue) as ArchiveSelection;
    return this.operations.start(selection.packageId, kind, async (operation) => {
      const { stores } = this.options;
      await initializeArmoryDirectories(stores.paths);
      const staging = resolveContainedPath(stores.paths.stagingDir, operation.operationId);
      const archiveFile = resolveContainedPath(staging, "package.tar.gz");
      const extraction = resolveContainedPath(staging, "extracted");
      const expectedRoot = `${selection.packageId}-${selection.version}`;
      const previous = await stores.installed.get(selection.packageId);
      const projectPackagesActive = (await stores.projectPackages.read()).migrationCompletedAt !== null;
      const previousActivation = await readActivation(stores, selection.packageId);
      const journal: InstallJournal = {
        schemaVersion: 1,
        operationId: operation.operationId,
        packageId: selection.packageId,
        version: selection.version,
        kind,
        phase: "prepared",
        previousActivation,
        previousInstalled: previous,
      };
      let activated = false;
      let movedDestination: string | null = null;
      let rollbackIncomplete = false;
      try {
        await mkdir(staging, { recursive: false, mode: 0o700 });
        await writeInstallJournal(staging, journal);
        await markOperationStarted(stores, selection, operation.operationId, previous, this.now(), projectPackagesActive);
        await operation.update("downloading", 10, "Downloading release archive");
        await downloadArchive({
          selection,
          destination: archiveFile,
          fetchImpl: this.options.fetchImpl,
          timeoutMs: this.options.downloadTimeoutMs,
          maxBytes: this.options.maxDownloadBytes,
        });

        await operation.update("inspecting", 35, "Inspecting release archive");
        await inspectArchive({
          archiveFile,
          expectedRoot,
          maxFiles: this.options.maxArchiveFiles,
          maxExpandedBytes: this.options.maxExpandedBytes,
        });
        await operation.update("extracting", 50, "Extracting verified release archive");
        await extractInspectedArchive(archiveFile, extraction);
        const extractedRoot = resolveContainedPath(extraction, expectedRoot);

        await operation.update("validating", 70, "Validating package manifest and commands");
        const manifest = await readManifest(extractedRoot);
        assertManifestMatchesSelection(manifest, selection);
        await validateManifestPaths(manifest, extractedRoot, resolveContainedPath(stores.paths.homesDir, selection.packageId));

        const destination = packageVersionPath(stores.paths, selection.packageId, selection.version);
        if (await pathExists(destination)) throw new ArmoryOperationError("VERSION_ALREADY_INSTALLED", `Package version is already present: ${selection.packageId}@${selection.version}`);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await syncTree(extractedRoot);
        await rename(extractedRoot, destination);
        movedDestination = destination;
        await syncDirectory(path.dirname(extractedRoot));
        await syncDirectory(path.dirname(destination));
        await writeInstallJournal(staging, { ...journal, phase: "version_moved" });

        if (kind === "update" && this.options.runtime) {
          await operation.update("stopping", 85, "Stopping the previous package version");
          await this.options.runtime.stop(selection.packageId);
          await writeInstallJournal(staging, { ...journal, phase: "runtime_stopped" });
        }
        await operation.update("activating", 90, "Activating package version");
        const installed = installedRecord(selection, manifest, operation.operationId, previous, this.now(), projectPackagesActive);
        await stores.installed.set(installed);
        const installedSnapshot = { ...installed, activeOperationId: null };
        const activation: ArmoryActivation = {
          schemaVersion: 1,
          id: selection.packageId,
          version: selection.version,
          previousVersion: previousActivation?.version ?? previous?.version ?? null,
          activatedAt: this.now(),
          sourceDigest: selection.archive.sha256,
          operationId: operation.operationId,
          installed: installedSnapshot,
        };
        await writeActivation(stores, activation);
        activated = true;
        await stores.installed.set(installedSnapshot);
        await writeInstallJournal(staging, { ...journal, phase: "activation_committed" });
        if (kind === "update") await writeInstallJournal(staging, { ...journal, phase: "runtime_started" });
      } catch (error) {
        if (activated && kind === "update" && previous && previousActivation) {
          try {
            await this.options.runtime?.stop(selection.packageId);
            await writeActivation(stores, previousActivation);
            await stores.installed.set({ ...previous, activeOperationId: null, updatedAt: this.now(), lastError: null });
            if (movedDestination) await removeDurably(movedDestination);
            movedDestination = null;
          } catch (rollbackError) {
            rollbackIncomplete = true;
            throw new ArmoryOperationError("UPDATE_ROLLBACK_FAILED", `Updated package failed and the previous version could not be restored: ${safeErrorMessage(rollbackError)}`, { cause: error });
          }
        } else if (!activated) {
          if (movedDestination) {
            try { await removeDurably(movedDestination); }
            catch { rollbackIncomplete = true; }
          }
          await restoreInstalledAfterFailure(stores, selection, previous, error, this.now(), projectPackagesActive);
        }
        throw error;
      } finally {
        if (!rollbackIncomplete) await removeDurably(staging).catch(() => undefined);
      }
    });
  }
}

async function markOperationStarted(
  stores: ArmoryStores,
  selection: ArchiveSelection,
  operationId: string,
  previous: InstalledArmoryPackage | null,
  now: number,
  projectPackagesActive: boolean,
): Promise<void> {
  if (previous) {
    await stores.installed.set({ ...previous, activeOperationId: operationId, updatedAt: now, lastError: null });
    return;
  }
  await stores.installed.set({
    id: selection.packageId,
    version: selection.version,
    ...(!projectPackagesActive ? { enabled: false, configurationStatus: "not_required" as const } : {}),
    state: "installing",
    installedAt: now,
    updatedAt: now,
    sourceDigest: selection.archive.sha256,
    lastError: null,
    activeOperationId: operationId,
    capabilities: selection.capabilities,
  });
}

function installedRecord(
  selection: ArchiveSelection,
  manifest: ArmoryManifest,
  operationId: string,
  previous: InstalledArmoryPackage | null,
  now: number,
  projectPackagesActive: boolean,
): InstalledArmoryPackage {
  const configurationStatus = manifest.configuration
    ? previous?.configurationStatus === "verified" ? "verified" as const : "missing" as const
    : "not_required" as const;
  return {
    id: selection.packageId,
    version: selection.version,
    ...(!projectPackagesActive ? { enabled: false, configurationStatus } : {}),
    state: !projectPackagesActive && configurationStatus === "missing" ? "needs_configuration" : "ready",
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
    sourceDigest: selection.archive.sha256,
    lastError: null,
    activeOperationId: operationId,
    capabilities: { mcp: Boolean(manifest.mcp) },
  };
}

async function restoreInstalledAfterFailure(
  stores: ArmoryStores,
  selection: ArchiveSelection,
  previous: InstalledArmoryPackage | null,
  error: unknown,
  now: number,
  projectPackagesActive: boolean,
): Promise<void> {
  const message = error instanceof ArmoryOperationError ? error.message : "Armory installation failed";
  if (previous) {
    await stores.installed.set({ ...previous, activeOperationId: null, updatedAt: now, lastError: message.slice(0, 4000) }).catch(() => undefined);
    return;
  }
  await stores.installed.set({
    id: selection.packageId,
    version: selection.version,
    ...(!projectPackagesActive ? { enabled: false, configurationStatus: "not_required" as const } : {}),
    state: "error",
    installedAt: now,
    updatedAt: now,
    sourceDigest: selection.archive.sha256,
    lastError: message.slice(0, 4000),
    activeOperationId: null,
    capabilities: selection.capabilities,
  }).catch(() => undefined);
}

async function readManifest(packageRoot: string): Promise<ArmoryManifest> {
  const file = resolveContainedPath(packageRoot, "armory.package.json");
  try {
    const raw = await readFile(file);
    if (raw.byteLength > MAX_MANIFEST_BYTES) throw new ArmoryOperationError("MANIFEST_TOO_LARGE", "Package manifest exceeds the size limit");
    return parseArmoryManifest(JSON.parse(raw.toString("utf8")));
  } catch (error) {
    if (error instanceof ArmoryOperationError) throw error;
    throw new ArmoryOperationError("MANIFEST_INVALID", "Package manifest is invalid", { cause: error });
  }
}

async function validateManifestPaths(manifest: ArmoryManifest, packageRoot: string, managedHome: string): Promise<void> {
  const commands = [
    manifest.mcp?.command,
    manifest.configuration?.handler,
    manifest.configuration?.verifyHandler,
    manifest.lifecycle?.postInstall,
    manifest.lifecycle?.preUninstall,
  ].filter((command): command is NonNullable<typeof command> => Boolean(command));
  for (const command of commands) {
    if (command.executable === "node") continue;
    const executable = resolveContainedPath(packageRoot, command.executable);
    const details = await lstat(executable).catch(() => null);
    if (!details?.isFile()) throw new ArmoryOperationError("COMMAND_EXECUTABLE_INVALID", `Manifest command executable is not a regular package file: ${command.executable}`);
  }
  for (const managedPath of manifest.configuration?.managedPaths ?? []) resolveContainedPath(managedHome, managedPath);
  for (const environmentPath of Object.values(manifest.configuration?.environment ?? {})) resolveContainedPath(managedHome, environmentPath);
}

async function pathExists(target: string): Promise<boolean> {
  try { await lstat(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function readActivation(stores: ArmoryStores, packageId: string): Promise<ArmoryActivation | null> {
  try {
    const raw = await readFile(packageActivationPath(stores.paths, packageId), "utf8");
    return armoryActivationSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new ArmoryOperationError("ACTIVATION_INVALID", "Package activation record is invalid", { cause: error });
    throw error;
  }
}

async function writeActivation(stores: ArmoryStores, activation: ArmoryActivation): Promise<void> {
  const store = new AtomicJsonStore({
    filePath: packageActivationPath(stores.paths, activation.id),
    schema: armoryActivationSchema,
    defaults: () => activation,
  });
  await store.write(activation);
}

async function writeInstallJournal(staging: string, journal: InstallJournal): Promise<void> {
  const store = new AtomicJsonStore({
    filePath: resolveContainedPath(staging, INSTALL_JOURNAL_FILE),
    schema: installJournalSchema,
    defaults: () => journal,
  });
  await store.write(journal);
}

async function readInstallJournal(staging: string): Promise<InstallJournal | null> {
  const file = resolveContainedPath(staging, INSTALL_JOURNAL_FILE);
  try { return installJournalSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function syncTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = resolveContainedPath(root, entry.name);
    if (entry.isDirectory()) await syncTree(target);
    else if (entry.isFile()) {
      const handle = await open(target, constants.O_RDONLY);
      try { await handle.sync(); }
      finally { await handle.close(); }
    }
  }
  await syncDirectory(root);
}

async function removeDurably(target: string): Promise<void> {
  const parent = path.dirname(target);
  await rm(target, { recursive: true, force: true });
  await syncDirectory(parent);
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

export async function recoverInterruptedArmoryOperations(stores: ArmoryStores, now = Date.now()): Promise<number> {
  await initializeArmoryDirectories(stores.paths);
  const projectPackagesActive = (await stores.projectPackages.read()).migrationCompletedAt !== null;
  const operations = await stores.operations.list();
  const interruptedProfileOperations = operations.filter((operation) =>
    (operation.kind === "profile_configure" || operation.kind === "profile_verify")
    && (operation.status === "queued" || operation.status === "running"));
  for (const operation of interruptedProfileOperations) {
    await stores.operations.save({
      ...operation,
      status: "failure",
      phase: "failed",
      progress: null,
      message: "Profile operation was interrupted by daemon restart; retry explicitly",
      errorCode: "INTERRUPTED_OPERATION",
      finishedAt: now,
    });
  }
  const activeOperationIds = new Set((await stores.installed.list()).flatMap((record) => record.activeOperationId ? [record.activeOperationId] : []));
  const journals = await collectInstallJournals(stores.paths.stagingDir);
  const interrupted = operations.filter((operation) => (operation.kind === "install" || operation.kind === "update") && (operation.status === "queued" || operation.status === "running" || activeOperationIds.has(operation.id) || journals.has(operation.id)));
  for (const operation of interrupted) {
    const staging = resolveContainedPath(stores.paths.stagingDir, operation.id);
    const journal = journals.get(operation.id) ?? await readInstallJournal(staging);
    const installed = await stores.installed.get(operation.packageId);
    const activation = await readActivation(stores, operation.packageId).catch(() => null);
    const activationCommitted = activation?.operationId === operation.id;
    const durableUpdate = operation.kind === "update" && journal?.kind === "update"
      && journal.previousActivation !== undefined && journal.previousInstalled !== undefined && journal.phase !== undefined;
    if (durableUpdate) {
      const updateCommitted = journal.phase === "runtime_started" && activationCommitted;
      if (updateCommitted) {
        const committed = installed?.version === journal.version ? installed : activation.installed;
        await stores.installed.set({
          ...committed,
          ...(!projectPackagesActive ? { enabled: journal.previousInstalled?.enabled ?? false } : {}),
          activeOperationId: null,
          lastError: null,
          updatedAt: now,
        });
      } else {
        if (journal.previousActivation) await writeActivation(stores, journal.previousActivation);
        if (journal.previousInstalled) {
          await stores.installed.set({
            ...journal.previousInstalled,
            activeOperationId: null,
            lastError: "Update was interrupted; previous version was restored",
            updatedAt: now,
          });
        }
        await removeDurably(packageVersionPath(stores.paths, journal.packageId, journal.version));
      }
      await removeDurably(staging);
      await stores.operations.save(updateCommitted
        ? {
          ...operation,
          status: "success",
          phase: "complete",
          progress: 100,
          message: "Recovered update after durable runtime activation",
          errorCode: null,
          finishedAt: now,
        }
        : {
          ...operation,
          status: "failure",
          phase: "failed",
          progress: null,
          message: "Update was interrupted by daemon restart; previous version was restored",
          errorCode: "INTERRUPTED_OPERATION",
          finishedAt: now,
        });
      continue;
    }
    if (journal?.operationId === operation.id && journal.packageId === operation.packageId && !activationCommitted) {
      await removeDurably(packageVersionPath(stores.paths, journal.packageId, journal.version));
    }
    await removeDurably(staging);
    await stores.operations.save(activationCommitted
      ? {
        ...operation,
        status: "success",
        phase: "complete",
        progress: 100,
        message: "Recovered operation after committed activation",
        errorCode: null,
        finishedAt: now,
      }
      : {
        ...operation,
        status: "failure",
        phase: "failed",
        progress: null,
        message: "Operation was interrupted by daemon restart",
        errorCode: "INTERRUPTED_OPERATION",
        finishedAt: now,
      });
    if (!installed || installed.activeOperationId !== operation.id) continue;
    if (activation) {
      await stores.installed.set({
        ...activation.installed,
        lastError: activationCommitted ? null : "Previous operation was interrupted; active version was preserved",
        updatedAt: now,
      });
    } else {
      await stores.installed.set({
        ...installed,
        state: "error",
        ...(!projectPackagesActive ? { enabled: false, configurationStatus: installed.configurationStatus ?? "not_required" as const } : {}),
        activeOperationId: null,
        lastError: "Installation was interrupted before activation",
        updatedAt: now,
      });
    }
  }
  return interrupted.length + interruptedProfileOperations.length;
}

async function collectInstallJournals(stagingRoot: string): Promise<Map<string, InstallJournal>> {
  const journals = new Map<string, InstallJournal>();
  const entries = await readdir(stagingRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const journal = await readInstallJournal(resolveContainedPath(stagingRoot, entry.name));
    if (journal && journal.operationId === entry.name) journals.set(journal.operationId, journal);
  }
  return journals;
}

export async function getArmoryActivation(stores: ArmoryStores, packageId: string): Promise<ArmoryActivation | null> {
  return readActivation(stores, packageId);
}

export async function retireLegacyArmoryActivationState(stores: ArmoryStores): Promise<void> {
  for (const record of await stores.installed.list()) {
    const activation = await readActivation(stores, record.id);
    if (!activation) continue;
    const legacy = activation.installed as InstalledArmoryPackage & { enabled?: boolean; configurationStatus?: string };
    const { enabled: _enabled, configurationStatus: _configurationStatus, ...installed } = legacy;
    await writeActivation(stores, {
      ...activation,
      installed: {
        ...installed,
        state: installed.state === "needs_configuration" || installed.state === "verifying" ? "ready" : installed.state,
      },
    });
  }
}

function currentPlatform(): { os: "darwin" | "linux"; arch: "x64" | "arm64" } {
  if ((process.platform !== "darwin" && process.platform !== "linux") || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new ArmoryOperationError("UNSUPPORTED_PLATFORM", `Armory does not support ${process.platform}/${process.arch}`);
  }
  return { os: process.platform, arch: process.arch };
}
