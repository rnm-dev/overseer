import { lstat, mkdir, readFile, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArmoryManifest, type ArmoryConfigurationField, type ArmoryHookInput, type ArmoryManifest, type ArmoryOperation, type ArmoryOwnershipEntry } from "./contracts.js";
import { ArmoryHookRunner } from "./hookRunner.js";
import { getArmoryActivation } from "./installer.js";
import { ArmoryOperationError, ArmoryOperationCoordinator } from "./operationCoordinator.js";
import { packageVersionPath, resolveContainedPath } from "./paths.js";
import type { ArmoryStores } from "./stores.js";

export interface ArmoryPackageRuntimeController {
  stop(packageId: string): Promise<void>;
  healthCheck(packageId: string): Promise<void>;
  start(packageId: string): Promise<void>;
}

export interface ConfigureArmoryOptions { confirmHostWrites?: boolean }
export interface DeleteArmoryConfigurationOptions { includeHost?: boolean; confirmHostWrites?: boolean }

export class ArmoryConfigurationError extends ArmoryOperationError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "ArmoryConfigurationError";
  }
}

export class ArmoryConfigurationService {
  readonly operations: ArmoryOperationCoordinator;
  private readonly hookRunner: ArmoryHookRunner;
  private readonly now: () => number;

  constructor(private readonly options: {
    stores: ArmoryStores;
    hookRunner?: ArmoryHookRunner;
    runtime?: ArmoryPackageRuntimeController;
    now?: () => number;
    platform?: { os: "darwin" | "linux"; arch: "x64" | "arm64" };
    hostHome?: string;
  }) {
    this.hookRunner = options.hookRunner ?? new ArmoryHookRunner();
    this.now = options.now ?? Date.now;
    this.operations = new ArmoryOperationCoordinator(options.stores.operations, this.now);
  }

  async schema(packageId: string): Promise<{ fields: ArmoryConfigurationField[]; configured: Record<string, boolean>; hostWrites: string[] }> {
    const { manifest } = await loadActivePackage(this.options.stores, packageId);
    const metadata = await this.options.stores.credentials.metadata(packageId);
    return {
      fields: manifest.configuration?.fields ?? [],
      configured: metadata.configuredFields,
      hostWrites: manifest.permissions.hostPaths.filter((entry) => entry.mode === "write").map((entry) => entry.path),
    };
  }

  async configure(packageId: string, submitted: Record<string, string>, options: ConfigureArmoryOptions = {}): Promise<ArmoryOperation> {
    return this.operations.start(packageId, "configure", async (operation) => {
      const { stores } = this.options;
      const active = await loadActivePackage(stores, packageId);
      const configuration = active.manifest.configuration;
      if (!configuration) throw new ArmoryConfigurationError("CONFIGURATION_NOT_SUPPORTED", "Package does not declare configuration");
      const values = validateConfiguration(configuration.fields, submitted);
      const redactedValues = configuration.fields.filter((field) => field.type === "secret" || field.type === "file").map((field) => values[field.id]).filter((value): value is string => value !== undefined);
      const home = resolveContainedPath(stores.paths.homesDir, packageId);
      await mkdir(home, { recursive: true, mode: 0o700 });
      const ownership = await stores.ownership.list(packageId);
      const hostHome = this.options.hostHome ?? os.homedir();
      const hostRoots = await prepareHostWrites(active.manifest, ownership, options.confirmHostWrites ?? false, hostHome);
      await this.options.runtime?.stop(packageId);
      await stores.installed.set({ ...active.installed, state: "verifying", configurationStatus: "unverified", activeOperationId: operation.operationId, updatedAt: this.now() });
      try {
        await stores.credentials.set(packageId, values, this.now());
        await operation.update("configuring", 25, "Running package configuration");
        const handler = await this.hookRunner.run({
          command: configuration.handler,
          input: hookInput("configure", active, home, this.options.platform ?? currentPlatform(), values),
          packageDir: active.packageDir,
          managedHome: home,
          environment: providerEnvironment(configuration.environment ?? {}, home),
          sensitiveValues: redactedValues,
          onProgress: (event) => operation.update(event.phase, event.percent, event.message),
          validateOwnedPaths: (paths) => validateOwnedPaths(paths, configuration.managedPaths, home, hostRoots, hostHome),
        });
        await persistOwnership(stores, packageId, handler.ownedPaths, configuration.managedPaths, home, hostRoots, hostHome, this.now());
        if (configuration.verifyHandler) {
          await operation.update("verifying", 70, "Verifying package configuration");
          await this.hookRunner.run({
            command: configuration.verifyHandler,
            input: hookInput("verify", active, home, this.options.platform ?? currentPlatform()),
            packageDir: active.packageDir,
            managedHome: home,
            environment: providerEnvironment(configuration.environment ?? {}, home),
            sensitiveValues: redactedValues,
            onProgress: (event) => operation.update(event.phase, event.percent, event.message),
          });
        }
        await this.options.runtime?.healthCheck(packageId);
        await stores.installed.set({ ...active.installed, state: "ready", configurationStatus: "verified", activeOperationId: null, lastError: null, updatedAt: this.now() });
      } catch (error) {
        await stores.installed.set({ ...active.installed, state: "needs_configuration", configurationStatus: "invalid", activeOperationId: null, lastError: safeConfigurationError(error), updatedAt: this.now() }).catch(() => undefined);
        throw error;
      }
    });
  }

  async verify(packageId: string): Promise<ArmoryOperation> {
    return this.operations.start(packageId, "verify", async (operation) => {
      const active = await loadActivePackage(this.options.stores, packageId);
      const configuration = active.manifest.configuration;
      if (!configuration?.verifyHandler) throw new ArmoryConfigurationError("VERIFY_NOT_SUPPORTED", "Package does not declare a verification hook");
      const values = await this.options.stores.credentials.values(packageId);
      if (!values) throw new ArmoryConfigurationError("CONFIGURATION_MISSING", "Package has no stored configuration");
      const home = resolveContainedPath(this.options.stores.paths.homesDir, packageId);
      const redactedValues = configuration.fields.filter((field) => field.type === "secret" || field.type === "file").map((field) => values[field.id]).filter((value): value is string => value !== undefined);
      await this.options.stores.installed.set({ ...active.installed, state: "verifying", activeOperationId: operation.operationId, updatedAt: this.now() });
      try {
        await this.hookRunner.run({ command: configuration.verifyHandler, input: hookInput("verify", active, home, this.options.platform ?? currentPlatform()), packageDir: active.packageDir, managedHome: home, environment: providerEnvironment(configuration.environment ?? {}, home), sensitiveValues: redactedValues, onProgress: (event) => operation.update(event.phase, event.percent, event.message) });
        await this.options.runtime?.healthCheck(packageId);
        await this.options.stores.installed.set({ ...active.installed, state: "ready", configurationStatus: "verified", activeOperationId: null, lastError: null, updatedAt: this.now() });
      } catch (error) {
        await this.options.stores.installed.set({ ...active.installed, state: "needs_configuration", configurationStatus: "invalid", activeOperationId: null, lastError: safeConfigurationError(error), updatedAt: this.now() }).catch(() => undefined);
        throw error;
      }
    });
  }

  async deleteConfiguration(packageId: string, options: DeleteArmoryConfigurationOptions = {}): Promise<ArmoryOperation> {
    return this.operations.start(packageId, "delete_configuration", async (operation) => {
      const active = await loadActivePackage(this.options.stores, packageId);
      await this.options.runtime?.stop(packageId);
      const entries = await this.options.stores.ownership.list(packageId);
      const configuration = active.manifest.configuration;
      const home = resolveContainedPath(this.options.stores.paths.homesDir, packageId);
      const hostHome = this.options.hostHome ?? os.homedir();
      const hostRoots = active.manifest.permissions.hostPaths.filter((entry) => entry.mode === "write").map((entry) => expandHostPath(entry.path, hostHome));
      const selected = entries.filter((entry) => entry.root === "managed_home" || (options.includeHost && options.confirmHostWrites));
      if (options.includeHost && !options.confirmHostWrites) throw new ArmoryConfigurationError("HOST_WRITE_CONFIRMATION_REQUIRED", "Deleting host configuration requires explicit confirmation");
      for (const entry of selected) validateLedgerEntry(entry, configuration?.managedPaths ?? [], home, hostRoots);
      await operation.update("deleting_configuration", 50, "Deleting recorded package configuration");
      for (const entry of selected.sort((a, b) => b.path.length - a.path.length)) await removeOwnedPath(entry);
      await this.options.stores.credentials.delete(packageId);
      await this.options.stores.ownership.replace(packageId, entries.filter((entry) => !selected.includes(entry)));
      await this.options.stores.installed.set({ ...active.installed, state: "needs_configuration", configurationStatus: "missing", activeOperationId: null, lastError: null, updatedAt: this.now() });
    });
  }
}

interface ActivePackage { manifest: ArmoryManifest; packageDir: string; installed: NonNullable<Awaited<ReturnType<ArmoryStores["installed"]["get"]>>> }

async function loadActivePackage(stores: ArmoryStores, packageId: string): Promise<ActivePackage> {
  const activation = await getArmoryActivation(stores, packageId);
  const installed = await stores.installed.get(packageId);
  if (!activation || !installed) throw new ArmoryConfigurationError("PACKAGE_NOT_ACTIVE", "Package is not actively installed");
  const packageDir = packageVersionPath(stores.paths, packageId, activation.version);
  try { return { manifest: parseArmoryManifest(JSON.parse(await readFile(resolveContainedPath(packageDir, "armory.package.json"), "utf8"))), packageDir, installed }; }
  catch (error) { throw new ArmoryConfigurationError("MANIFEST_INVALID", "Active package manifest is invalid", { cause: error }); }
}

export function validateConfiguration(fields: ArmoryConfigurationField[], submitted: Record<string, string>): Record<string, string> {
  const byId = new Map(fields.map((field) => [field.id, field]));
  for (const key of Object.keys(submitted)) if (!byId.has(key)) throw new ArmoryConfigurationError("CONFIGURATION_FIELD_UNKNOWN", `Unknown configuration field: ${key}`);
  const result: Record<string, string> = {};
  for (const field of fields) {
    const value = submitted[field.id];
    if (field.required && (value === undefined || value.length === 0)) throw new ArmoryConfigurationError("CONFIGURATION_FIELD_REQUIRED", `Configuration field is required: ${field.id}`);
    if (value === undefined) continue;
    if (field.validation?.maxLength && value.length > field.validation.maxLength) throw new ArmoryConfigurationError("CONFIGURATION_FIELD_INVALID", `Configuration field is too long: ${field.id}`);
    if (field.validation?.pattern && !new RegExp(field.validation.pattern).test(value)) throw new ArmoryConfigurationError("CONFIGURATION_FIELD_INVALID", `Configuration field has an invalid value: ${field.id}`);
    if (field.type === "select" && !field.options?.some((option) => option.value === value)) throw new ArmoryConfigurationError("CONFIGURATION_FIELD_INVALID", `Configuration field has an invalid selection: ${field.id}`);
    result[field.id] = value;
  }
  return result;
}

function hookInput(operation: "configure" | "verify", active: ActivePackage, home: string, platform: { os: "darwin" | "linux"; arch: "x64" | "arm64" }, configuration?: Record<string, string>): ArmoryHookInput {
  const base = { protocolVersion: 1 as const, type: "input" as const, package: { id: active.manifest.id, version: active.manifest.version, dir: active.packageDir, home }, platform };
  if (operation === "configure") return { ...base, operation, configuration: configuration ?? {} };
  return { ...base, operation };
}

function providerEnvironment(environment: Record<string, string>, home: string): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).map(([name, relative]) => [name, resolveContainedPath(home, relative)]));
}

async function prepareHostWrites(manifest: ArmoryManifest, ownership: ArmoryOwnershipEntry[], confirmed: boolean, hostHome: string): Promise<string[]> {
  const roots = manifest.permissions.hostPaths.filter((entry) => entry.mode === "write").map((entry) => expandHostPath(entry.path, hostHome));
  if (roots.length && !confirmed) throw new ArmoryConfigurationError("HOST_WRITE_CONFIRMATION_REQUIRED", "Package host writes require explicit confirmation");
  const owned = new Set(ownership.filter((entry) => entry.root === "host").map((entry) => path.resolve(entry.path)));
  for (const root of roots) {
    if (await exists(root) && !owned.has(path.resolve(root))) throw new ArmoryConfigurationError("HOST_PATH_PREEXISTS", `Refusing to replace pre-existing host path: ${root}`);
  }
  return roots;
}

function validateOwnedPaths(paths: string[], managedPaths: string[], home: string, hostRoots: string[], hostHome: string): void {
  for (const owned of paths) classifyOwnedPath(owned, managedPaths, home, hostRoots, hostHome);
}

async function persistOwnership(stores: ArmoryStores, packageId: string, paths: string[], managedPaths: string[], home: string, hostRoots: string[], hostHome: string, now: number): Promise<void> {
  const existing = await stores.ownership.list(packageId);
  const additions: ArmoryOwnershipEntry[] = [];
  for (const owned of paths) {
    const classified = classifyOwnedPath(owned, managedPaths, home, hostRoots, hostHome);
    if (!await exists(classified.path)) throw new ArmoryConfigurationError("OWNED_PATH_MISSING", "Hook reported an owned path it did not create");
    additions.push({ ...classified, createdAt: now });
  }
  const merged = [...existing];
  for (const entry of additions) if (!merged.some((current) => current.root === entry.root && current.path === entry.path)) merged.push(entry);
  await stores.ownership.replace(packageId, merged);
}

function classifyOwnedPath(value: string, managedPaths: string[], home: string, hostRoots: string[], hostHome: string): { path: string; root: "managed_home" | "host" } {
  if (!path.isAbsolute(value) && !value.startsWith("~/")) {
    if (!managedPaths.includes(value)) throw new ArmoryConfigurationError("OWNED_PATH_UNDECLARED", "Hook reported an undeclared managed path");
    return { path: resolveContainedPath(home, value), root: "managed_home" };
  }
  const absolute = expandHostPath(value, hostHome);
  if (!hostRoots.some((root) => absolute === path.resolve(root) || absolute.startsWith(`${path.resolve(root)}${path.sep}`))) throw new ArmoryConfigurationError("OWNED_PATH_UNDECLARED", "Hook reported an undeclared host path");
  return { path: absolute, root: "host" };
}

function validateLedgerEntry(entry: ArmoryOwnershipEntry, managedPaths: string[], home: string, hostRoots: string[]): void {
  const absolute = path.resolve(entry.path);
  if (entry.root === "managed_home") {
    if (!managedPaths.some((relative) => absolute === resolveContainedPath(home, relative))) throw new ArmoryConfigurationError("OWNERSHIP_PATH_INVALID", "Refusing to delete an invalid managed ownership path");
    return;
  }
  if (!hostRoots.some((root) => absolute === path.resolve(root) || absolute.startsWith(`${path.resolve(root)}${path.sep}`))) throw new ArmoryConfigurationError("OWNERSHIP_PATH_INVALID", "Refusing to delete an invalid host ownership path");
}

function expandHostPath(value: string, home: string): string { return path.resolve(value.startsWith("~/") ? path.join(home, value.slice(2)) : value); }
async function exists(value: string): Promise<boolean> { try { await lstat(value); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function removeOwnedPath(entry: ArmoryOwnershipEntry): Promise<void> { const details = await lstat(entry.path).catch(() => null); if (!details) return; if (details.isDirectory()) await rmdir(entry.path).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; }); else await rm(entry.path, { force: true }); }
function safeConfigurationError(error: unknown): string { return error instanceof ArmoryOperationError ? error.message.slice(0, 4000) : "Package configuration failed"; }
function currentPlatform(): { os: "darwin" | "linux"; arch: "x64" | "arm64" } { if ((process.platform !== "darwin" && process.platform !== "linux") || (process.arch !== "x64" && process.arch !== "arm64")) throw new ArmoryConfigurationError("UNSUPPORTED_PLATFORM", "Armory configuration is unsupported on this platform"); return { os: process.platform, arch: process.arch }; }
