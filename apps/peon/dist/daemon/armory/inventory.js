import semver from "semver";
import { DEFAULT_ARMORY_REGISTRY_URL } from "./contracts.js";
import { ArmoryCatalogClient, ArmoryCatalogError } from "./catalogClient.js";
import { createArmoryStores } from "./stores.js";
export class ArmoryInventoryError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ArmoryInventoryError";
    }
}
export class ArmoryInventory {
    installed;
    catalogSource;
    constructor(installed, catalogSource) {
        this.installed = installed;
        this.catalogSource = catalogSource;
    }
    async list(query = {}) {
        const snapshot = await this.snapshot(query.forceRefresh === true);
        const needle = (query.q ?? "").trim().toLowerCase();
        const offset = decodeCursor(query.cursor);
        const limit = normalizeLimit(query.limit);
        const packages = mergePackages(snapshot.catalog, snapshot.installed)
            .filter((entry) => !query.installedOnly || entry.installed !== null)
            .filter((entry) => !needle || searchableText(entry).includes(needle));
        return {
            registry: snapshot.registry,
            packages: packages.slice(offset, offset + limit),
            total: packages.length,
            nextCursor: offset + limit < packages.length ? encodeCursor(offset + limit) : null,
        };
    }
    async get(packageId) {
        const snapshot = await this.snapshot();
        const entry = mergePackages(snapshot.catalog, snapshot.installed).find((candidate) => candidate.id === packageId);
        if (!entry)
            throw new ArmoryInventoryError("NOT_FOUND", `Armory package not found: ${packageId}`);
        return {
            registry: snapshot.registry,
            package: entry,
            catalog: snapshot.catalog?.packages.find((candidate) => candidate.id === packageId) ?? null,
        };
    }
    async snapshot(forceRefresh = false) {
        const installed = await this.installed.list();
        const description = await this.catalogSource.describe();
        try {
            const result = await this.catalogSource.refresh({ force: forceRefresh });
            return {
                installed,
                catalog: result.catalog,
                registry: {
                    url: result.registryUrl,
                    official: result.officialRegistry,
                    source: result.source,
                    fetchedAt: result.fetchedAt,
                    catalogUpdatedAt: result.catalog.updatedAt,
                    error: result.lastRefreshError,
                },
            };
        }
        catch (error) {
            const safe = error instanceof ArmoryCatalogError
                ? { code: error.code, message: error.message }
                : { code: "REGISTRY_UNAVAILABLE", message: "Armory registry is unavailable" };
            return {
                installed,
                catalog: null,
                registry: {
                    url: description.registryUrl,
                    official: description.officialRegistry,
                    source: "unavailable",
                    fetchedAt: null,
                    catalogUpdatedAt: null,
                    error: safe,
                },
            };
        }
    }
}
function mergePackages(catalog, installed) {
    const installedById = new Map(installed.map((record) => [record.id, record]));
    const merged = [];
    for (const entry of catalog?.packages ?? []) {
        const local = installedById.get(entry.id) ?? null;
        installedById.delete(entry.id);
        merged.push({
            id: entry.id,
            available: true,
            displayName: entry.displayName,
            iconUrl: entry.iconUrl ?? null,
            summary: entry.summary,
            publisher: entry.publisher,
            documentationUrl: entry.documentationUrl,
            latestVersion: entry.latest,
            requirements: entry.requirements,
            capabilities: entry.capabilities ?? local?.capabilities ?? { mcp: true },
            installed: local,
            updateAvailable: local ? semver.gt(entry.latest, local.version) : null,
        });
    }
    for (const local of installedById.values()) {
        merged.push({
            id: local.id,
            available: false,
            displayName: null,
            iconUrl: null,
            summary: null,
            publisher: null,
            documentationUrl: null,
            latestVersion: null,
            requirements: null,
            capabilities: local.capabilities ?? { mcp: true },
            installed: local,
            updateAvailable: null,
        });
    }
    return merged.sort((a, b) => a.id.localeCompare(b.id));
}
function searchableText(entry) {
    return [entry.id, entry.displayName, entry.summary, entry.publisher, entry.installed?.version]
        .filter((value) => typeof value === "string")
        .join(" ")
        .toLowerCase();
}
function normalizeLimit(value) {
    if (value === undefined)
        return 50;
    if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new ArmoryInventoryError("BAD_REQUEST", "limit must be an integer between 1 and 100");
    }
    return value;
}
function encodeCursor(offset) {
    return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}
function decodeCursor(cursor) {
    if (!cursor)
        return 0;
    try {
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (Number.isInteger(value.offset) && value.offset >= 0)
            return value.offset;
    }
    catch {
        // Return the same stable validation error for malformed encodings and data.
    }
    throw new ArmoryInventoryError("BAD_REQUEST", "cursor is invalid");
}
class StoredCatalogSource {
    stores;
    constructor(stores) {
        this.stores = stores;
    }
    async describe() {
        const configured = (await this.stores.settings.read()).registryUrl;
        const registryUrl = process.env.PEON_ARMORY_REGISTRY_URL || configured;
        return { registryUrl, officialRegistry: registryUrl === DEFAULT_ARMORY_REGISTRY_URL };
    }
    async refresh(options) {
        const { registryUrl } = await this.describe();
        return new ArmoryCatalogClient({ registryUrl, cacheFile: this.stores.paths.catalogCacheFile }).refresh(options);
    }
}
const defaultStores = createArmoryStores();
export const armoryInventory = new ArmoryInventory(defaultStores.installed, new StoredCatalogSource(defaultStores));
