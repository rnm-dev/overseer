import { mkdir, readdir, rm, stat } from "node:fs/promises";
import {
  armoryCredentialMetadataSchema,
  armoryOperationSchema,
  armoryProjectPackagesStateSchema,
  armorySettingsSchema,
  credentialStateSchema,
  installedArmoryPackageSchema,
  installedStateSchema,
  MAX_OPERATION_HISTORY,
  ownershipStateSchema,
  type ArmoryCredentialMetadata,
  type ArmoryOperation,
  type ArmoryProjectPackagesState,
  type ArmoryOwnershipEntry,
  type ArmorySettings,
  type CredentialState,
  type InstalledArmoryPackage,
  type InstalledState,
  type OwnershipState,
} from "./contracts.js";
import { AtomicJsonStore } from "./atomicJsonStore.js";
import { assertPackageId, createArmoryPaths, resolveContainedPath, type ArmoryPathRoots, type ArmoryPaths } from "./paths.js";

const defaultInstalledState: InstalledState = { schemaVersion: 1, packages: {} };
const defaultOwnershipState: OwnershipState = { schemaVersion: 1, packages: {} };
const defaultCredentialState: CredentialState = { schemaVersion: 1, packages: {} };
const defaultSettings: ArmorySettings = { schemaVersion: 1, registryUrl: "https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json", agentInstallAllowlist: [] };
const defaultProjectPackagesState: ArmoryProjectPackagesState = {
  schemaVersion: 1,
  migrationCompletedAt: null,
  profiles: {},
  assignments: [],
  legacyProfileByPackage: {},
};

export class InstalledPackageStore {
  private readonly store: AtomicJsonStore<InstalledState>;

  constructor(filePath: string) {
    this.store = new AtomicJsonStore({ filePath, schema: installedStateSchema, defaults: () => defaultInstalledState });
  }

  async list(): Promise<InstalledArmoryPackage[]> { return Object.values((await this.store.read()).packages); }
  async get(packageId: string): Promise<InstalledArmoryPackage | null> { return (await this.store.read()).packages[assertPackageId(packageId)] ?? null; }

  async set(record: InstalledArmoryPackage): Promise<InstalledArmoryPackage> {
    const validated = installedArmoryPackageSchema.parse(record);
    await this.store.update((state) => ({ ...state, packages: { ...state.packages, [validated.id]: validated } }));
    return validated;
  }

  async update(packageId: string, mutate: (current: InstalledArmoryPackage) => InstalledArmoryPackage): Promise<InstalledArmoryPackage> {
    const id = assertPackageId(packageId);
    let updated: InstalledArmoryPackage | undefined;
    await this.store.update((state) => {
      const current = state.packages[id];
      if (!current) throw new Error(`Armory package is not installed: ${id}`);
      updated = installedArmoryPackageSchema.parse(mutate(structuredClone(current)));
      if (updated.id !== id) throw new Error("cannot change installed package identity");
      return { ...state, packages: { ...state.packages, [id]: updated } };
    });
    return updated!;
  }

  async remove(packageId: string): Promise<void> {
    const id = assertPackageId(packageId);
    await this.store.update((state) => {
      const packages = { ...state.packages };
      delete packages[id];
      return { ...state, packages };
    });
  }

  async retireLegacyActivationState(): Promise<void> {
    await this.store.update((state) => ({
      ...state,
      packages: Object.fromEntries(Object.entries(state.packages).map(([id, record]) => {
        const legacy = record as InstalledArmoryPackage & { enabled?: boolean; configurationStatus?: string };
        const { enabled: _enabled, configurationStatus: _configurationStatus, ...current } = legacy;
        return [id, {
          ...current,
          state: current.state === "needs_configuration" || current.state === "verifying" ? "ready" : current.state,
        } as InstalledArmoryPackage];
      })),
    }));
  }
}

export class ArmorySettingsStore {
  private readonly store: AtomicJsonStore<ArmorySettings>;
  constructor(filePath: string) { this.store = new AtomicJsonStore({ filePath, schema: armorySettingsSchema, defaults: () => defaultSettings }); }
  read(): Promise<ArmorySettings> { return this.store.read(); }
  update(mutate: (current: ArmorySettings) => ArmorySettings | Promise<ArmorySettings>): Promise<ArmorySettings> { return this.store.update(mutate); }
}

export class ArmoryCredentialStore {
  private readonly store: AtomicJsonStore<CredentialState>;
  constructor(filePath: string) { this.store = new AtomicJsonStore({ filePath, schema: credentialStateSchema, defaults: () => defaultCredentialState, mode: 0o600 }); }

  async metadata(packageId: string): Promise<ArmoryCredentialMetadata> {
    const id = assertPackageId(packageId);
    const entry = (await this.store.read()).packages[id];
    return armoryCredentialMetadataSchema.parse({
      packageId: id,
      configuredFields: Object.fromEntries(Object.keys(entry?.values ?? {}).map((field) => [field, true])),
      createdAt: entry?.createdAt ?? 0,
      updatedAt: entry?.updatedAt ?? 0,
    });
  }

  async values(packageId: string): Promise<Record<string, string> | null> {
    const entry = (await this.store.read()).packages[assertPackageId(packageId)];
    return entry ? structuredClone(entry.values) : null;
  }

  async set(packageId: string, values: Record<string, string>, now = Date.now()): Promise<ArmoryCredentialMetadata> {
    const id = assertPackageId(packageId);
    await this.store.update((state) => {
      const current = state.packages[id];
      const packages = {
        ...state.packages,
        [id]: { values: structuredClone(values), createdAt: current?.createdAt ?? now, updatedAt: now },
      };
      return credentialStateSchema.parse({ ...state, packages });
    });
    return this.metadata(id);
  }

  async delete(packageId: string): Promise<void> {
    const id = assertPackageId(packageId);
    await this.store.update((state) => {
      const packages = { ...state.packages };
      delete packages[id];
      return { ...state, packages };
    });
  }

  async snapshot(): Promise<CredentialState> { return structuredClone(await this.store.read()); }
  async clear(): Promise<void> { await this.store.write(defaultCredentialState); }
}

export class ArmoryProjectPackageStore {
  private readonly store: AtomicJsonStore<ArmoryProjectPackagesState>;
  constructor(filePath: string) {
    this.store = new AtomicJsonStore({ filePath, schema: armoryProjectPackagesStateSchema, defaults: () => defaultProjectPackagesState, mode: 0o600 });
  }
  read(): Promise<ArmoryProjectPackagesState> { return this.store.read(); }
  write(state: ArmoryProjectPackagesState): Promise<void> { return this.store.write(state); }
  update(mutate: (current: ArmoryProjectPackagesState) => ArmoryProjectPackagesState | Promise<ArmoryProjectPackagesState>): Promise<ArmoryProjectPackagesState> {
    return this.store.update(mutate);
  }
}

export class OwnershipLedgerStore {
  private readonly store: AtomicJsonStore<OwnershipState>;
  constructor(filePath: string) { this.store = new AtomicJsonStore({ filePath, schema: ownershipStateSchema, defaults: () => defaultOwnershipState }); }

  async list(packageId: string): Promise<ArmoryOwnershipEntry[]> { return (await this.store.read()).packages[assertPackageId(packageId)] ?? []; }
  async replace(packageId: string, entries: ArmoryOwnershipEntry[]): Promise<void> {
    const id = assertPackageId(packageId);
    await this.store.update((state) => ownershipStateSchema.parse({ ...state, packages: { ...state.packages, [id]: entries } }));
  }
  async remove(packageId: string): Promise<void> {
    const id = assertPackageId(packageId);
    await this.store.update((state) => {
      const packages = { ...state.packages };
      delete packages[id];
      return { ...state, packages };
    });
  }
}

export class ArmoryOperationStore {
  private readonly stores = new Map<string, AtomicJsonStore<ArmoryOperation>>();
  constructor(readonly directory: string, private readonly maxHistory = MAX_OPERATION_HISTORY) {}

  private operationFile(id: string): string {
    const parsed = zUuid(id);
    return resolveContainedPath(this.directory, `${parsed}.json`);
  }

  private operationStore(id: string): AtomicJsonStore<ArmoryOperation> {
    const existing = this.stores.get(id);
    if (existing) return existing;
    const empty: ArmoryOperation = { id, packageId: "placeholder", kind: "install", status: "queued", phase: "queued", progress: null, message: "", errorCode: null, startedAt: null, finishedAt: null };
    const store = new AtomicJsonStore<ArmoryOperation>({ filePath: this.operationFile(id), schema: armoryOperationSchema, defaults: () => empty });
    this.stores.set(id, store);
    return store;
  }

  async save(operation: ArmoryOperation): Promise<ArmoryOperation> {
    const validated = armoryOperationSchema.parse(operation);
    return this.operationStore(validated.id).update(() => validated);
  }

  async get(id: string): Promise<ArmoryOperation | null> {
    const file = this.operationFile(id);
    try { await stat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    return this.operationStore(id).read();
  }

  async list(): Promise<ArmoryOperation[]> {
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const operations: ArmoryOperation[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      operations.push(await this.operationStore(id).read());
    }
    return operations.sort((a, b) => (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0));
  }

  async prune(maxHistory = this.maxHistory): Promise<number> {
    const operations = await this.list();
    const terminal = operations.filter((operation) => ["success", "failure", "needs_human"].includes(operation.status));
    let removed = 0;
    for (const operation of terminal.slice(Math.max(0, maxHistory))) {
      await rm(this.operationFile(operation.id), { force: true });
      this.stores.delete(operation.id);
      removed += 1;
    }
    return removed;
  }
}

function zUuid(value: string): string {
  return armoryOperationSchema.shape.id.parse(value);
}

export interface ArmoryStores {
  paths: ArmoryPaths;
  installed: InstalledPackageStore;
  operations: ArmoryOperationStore;
  settings: ArmorySettingsStore;
  credentials: ArmoryCredentialStore;
  ownership: OwnershipLedgerStore;
  projectPackages: ArmoryProjectPackageStore;
}

export function createArmoryStores(roots?: ArmoryPathRoots): ArmoryStores {
  const paths = createArmoryPaths(roots);
  return {
    paths,
    installed: new InstalledPackageStore(paths.installedFile),
    operations: new ArmoryOperationStore(paths.operationsDir),
    settings: new ArmorySettingsStore(paths.settingsFile),
    credentials: new ArmoryCredentialStore(paths.credentialsFile),
    ownership: new OwnershipLedgerStore(paths.ownershipFile),
    projectPackages: new ArmoryProjectPackageStore(paths.projectPackagesFile),
  };
}

export async function initializeArmoryDirectories(paths: ArmoryPaths): Promise<void> {
  await Promise.all([
    paths.packagesDir,
    paths.activeDir,
    paths.homesDir,
    paths.stagingDir,
    paths.operationsDir,
    paths.logsDir,
  ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
}
