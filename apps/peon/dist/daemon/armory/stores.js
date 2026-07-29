import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { armoryCredentialMetadataSchema, armoryOperationSchema, armorySettingsSchema, credentialStateSchema, installedArmoryPackageSchema, installedStateSchema, MAX_OPERATION_HISTORY, ownershipStateSchema, } from "./contracts.js";
import { AtomicJsonStore } from "./atomicJsonStore.js";
import { assertPackageId, createArmoryPaths, resolveContainedPath } from "./paths.js";
const defaultInstalledState = { schemaVersion: 1, packages: {} };
const defaultOwnershipState = { schemaVersion: 1, packages: {} };
const defaultCredentialState = { schemaVersion: 1, packages: {} };
const defaultSettings = { schemaVersion: 1, registryUrl: "https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json", agentInstallAllowlist: [] };
export class InstalledPackageStore {
    store;
    constructor(filePath) {
        this.store = new AtomicJsonStore({ filePath, schema: installedStateSchema, defaults: () => defaultInstalledState });
    }
    async list() { return Object.values((await this.store.read()).packages); }
    async get(packageId) { return (await this.store.read()).packages[assertPackageId(packageId)] ?? null; }
    async set(record) {
        const validated = installedArmoryPackageSchema.parse(record);
        await this.store.update((state) => ({ ...state, packages: { ...state.packages, [validated.id]: validated } }));
        return validated;
    }
    async update(packageId, mutate) {
        const id = assertPackageId(packageId);
        let updated;
        await this.store.update((state) => {
            const current = state.packages[id];
            if (!current)
                throw new Error(`Armory package is not installed: ${id}`);
            updated = installedArmoryPackageSchema.parse(mutate(structuredClone(current)));
            if (updated.id !== id)
                throw new Error("cannot change installed package identity");
            return { ...state, packages: { ...state.packages, [id]: updated } };
        });
        return updated;
    }
    async remove(packageId) {
        const id = assertPackageId(packageId);
        await this.store.update((state) => {
            const packages = { ...state.packages };
            delete packages[id];
            return { ...state, packages };
        });
    }
}
export class ArmorySettingsStore {
    store;
    constructor(filePath) { this.store = new AtomicJsonStore({ filePath, schema: armorySettingsSchema, defaults: () => defaultSettings }); }
    read() { return this.store.read(); }
    update(mutate) { return this.store.update(mutate); }
}
export class ArmoryCredentialStore {
    store;
    constructor(filePath) { this.store = new AtomicJsonStore({ filePath, schema: credentialStateSchema, defaults: () => defaultCredentialState, mode: 0o600 }); }
    async metadata(packageId) {
        const id = assertPackageId(packageId);
        const entry = (await this.store.read()).packages[id];
        return armoryCredentialMetadataSchema.parse({
            packageId: id,
            configuredFields: Object.fromEntries(Object.keys(entry?.values ?? {}).map((field) => [field, true])),
            createdAt: entry?.createdAt ?? 0,
            updatedAt: entry?.updatedAt ?? 0,
        });
    }
    async values(packageId) {
        const entry = (await this.store.read()).packages[assertPackageId(packageId)];
        return entry ? structuredClone(entry.values) : null;
    }
    async set(packageId, values, now = Date.now()) {
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
    async delete(packageId) {
        const id = assertPackageId(packageId);
        await this.store.update((state) => {
            const packages = { ...state.packages };
            delete packages[id];
            return { ...state, packages };
        });
    }
}
export class OwnershipLedgerStore {
    store;
    constructor(filePath) { this.store = new AtomicJsonStore({ filePath, schema: ownershipStateSchema, defaults: () => defaultOwnershipState }); }
    async list(packageId) { return (await this.store.read()).packages[assertPackageId(packageId)] ?? []; }
    async replace(packageId, entries) {
        const id = assertPackageId(packageId);
        await this.store.update((state) => ownershipStateSchema.parse({ ...state, packages: { ...state.packages, [id]: entries } }));
    }
    async remove(packageId) {
        const id = assertPackageId(packageId);
        await this.store.update((state) => {
            const packages = { ...state.packages };
            delete packages[id];
            return { ...state, packages };
        });
    }
}
export class ArmoryOperationStore {
    directory;
    maxHistory;
    stores = new Map();
    constructor(directory, maxHistory = MAX_OPERATION_HISTORY) {
        this.directory = directory;
        this.maxHistory = maxHistory;
    }
    operationFile(id) {
        const parsed = zUuid(id);
        return resolveContainedPath(this.directory, `${parsed}.json`);
    }
    operationStore(id) {
        const existing = this.stores.get(id);
        if (existing)
            return existing;
        const empty = { id, packageId: "placeholder", kind: "install", status: "queued", phase: "queued", progress: null, message: "", errorCode: null, startedAt: null, finishedAt: null };
        const store = new AtomicJsonStore({ filePath: this.operationFile(id), schema: armoryOperationSchema, defaults: () => empty });
        this.stores.set(id, store);
        return store;
    }
    async save(operation) {
        const validated = armoryOperationSchema.parse(operation);
        return this.operationStore(validated.id).update(() => validated);
    }
    async get(id) {
        const file = this.operationFile(id);
        try {
            await stat(file);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return null;
            throw error;
        }
        return this.operationStore(id).read();
    }
    async list() {
        let entries;
        try {
            entries = await readdir(this.directory, { withFileTypes: true });
        }
        catch (error) {
            if (error.code === "ENOENT")
                return [];
            throw error;
        }
        const operations = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".json"))
                continue;
            const id = entry.name.slice(0, -5);
            operations.push(await this.operationStore(id).read());
        }
        return operations.sort((a, b) => (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0));
    }
    async prune(maxHistory = this.maxHistory) {
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
function zUuid(value) {
    return armoryOperationSchema.shape.id.parse(value);
}
export function createArmoryStores(roots) {
    const paths = createArmoryPaths(roots);
    return {
        paths,
        installed: new InstalledPackageStore(paths.installedFile),
        operations: new ArmoryOperationStore(paths.operationsDir),
        settings: new ArmorySettingsStore(paths.settingsFile),
        credentials: new ArmoryCredentialStore(paths.credentialsFile),
        ownership: new OwnershipLedgerStore(paths.ownershipFile),
    };
}
export async function initializeArmoryDirectories(paths) {
    await Promise.all([
        paths.packagesDir,
        paths.activeDir,
        paths.homesDir,
        paths.stagingDir,
        paths.operationsDir,
        paths.logsDir,
    ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
}
