import semver from "semver";
import type { ArmoryCatalog, InstalledArmoryPackage } from "./contracts.js";
import { DEFAULT_ARMORY_REGISTRY_URL } from "./contracts.js";
import { ArmoryCatalogClient, ArmoryCatalogError, type CatalogRefreshError, type CatalogResult } from "./catalogClient.js";
import { createArmoryStores, type ArmoryStores, type InstalledPackageStore } from "./stores.js";

export interface ArmoryInventoryQuery {
  q?: string;
  installedOnly?: boolean;
  limit?: number;
  cursor?: string | null;
  forceRefresh?: boolean;
}

export interface ArmoryInventoryRegistryView {
  url: string;
  official: boolean;
  source: "live" | "cached" | "unavailable";
  fetchedAt: number | null;
  catalogUpdatedAt: string | null;
  error: CatalogRefreshError | null;
}

export interface ArmoryInventoryPackageView {
  id: string;
  available: boolean;
  displayName: string | null;
  iconUrl: string | null;
  summary: string | null;
  publisher: string | null;
  documentationUrl: string | null;
  latestVersion: string | null;
  requirements: { credentials: boolean; hostWrites: boolean } | null;
  capabilities: { mcp: boolean };
  installed: InstalledArmoryPackage | null;
  updateAvailable: boolean | null;
}

export interface ArmoryInventoryListView {
  registry: ArmoryInventoryRegistryView;
  packages: ArmoryInventoryPackageView[];
  total: number;
  nextCursor: string | null;
}

export interface ArmoryInventoryReader {
  list(query?: ArmoryInventoryQuery): Promise<ArmoryInventoryListView>;
  get(packageId: string): Promise<ArmoryInventoryDetailView>;
}

export interface ArmoryInventoryDetailView {
  registry: ArmoryInventoryRegistryView;
  package: ArmoryInventoryPackageView;
  catalog: ArmoryCatalog["packages"][number] | null;
}

export interface ArmoryInventoryCatalogSource {
  describe(): Promise<{ registryUrl: string; officialRegistry: boolean }>;
  refresh(options?: { force?: boolean }): Promise<CatalogResult>;
}

export class ArmoryInventoryError extends Error {
  constructor(readonly code: "BAD_REQUEST" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "ArmoryInventoryError";
  }
}

interface InventorySnapshot {
  registry: ArmoryInventoryRegistryView;
  catalog: ArmoryCatalog | null;
  installed: InstalledArmoryPackage[];
}

export class ArmoryInventory implements ArmoryInventoryReader {
  constructor(
    private readonly installed: Pick<InstalledPackageStore, "list">,
    private readonly catalogSource: ArmoryInventoryCatalogSource,
  ) {}

  async list(query: ArmoryInventoryQuery = {}): Promise<ArmoryInventoryListView> {
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

  async get(packageId: string): Promise<ArmoryInventoryDetailView> {
    const snapshot = await this.snapshot();
    const entry = mergePackages(snapshot.catalog, snapshot.installed).find((candidate) => candidate.id === packageId);
    if (!entry) throw new ArmoryInventoryError("NOT_FOUND", `Armory package not found: ${packageId}`);
    return {
      registry: snapshot.registry,
      package: entry,
      catalog: snapshot.catalog?.packages.find((candidate) => candidate.id === packageId) ?? null,
    };
  }

  private async snapshot(forceRefresh = false): Promise<InventorySnapshot> {
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
    } catch (error) {
      const safe = error instanceof ArmoryCatalogError
        ? { code: error.code, message: error.message }
        : { code: "REGISTRY_UNAVAILABLE" as const, message: "Armory registry is unavailable" };
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

function mergePackages(catalog: ArmoryCatalog | null, installed: InstalledArmoryPackage[]): ArmoryInventoryPackageView[] {
  const installedById = new Map(installed.map((record) => [record.id, record]));
  const merged: ArmoryInventoryPackageView[] = [];
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

function searchableText(entry: ArmoryInventoryPackageView): string {
  return [entry.id, entry.displayName, entry.summary, entry.publisher, entry.installed?.version]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new ArmoryInventoryError("BAD_REQUEST", "limit must be an integer between 1 and 100");
  }
  return value;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    if (Number.isInteger(value.offset) && (value.offset as number) >= 0) return value.offset as number;
  } catch {
    // Return the same stable validation error for malformed encodings and data.
  }
  throw new ArmoryInventoryError("BAD_REQUEST", "cursor is invalid");
}

class StoredCatalogSource implements ArmoryInventoryCatalogSource {
  constructor(private readonly stores: ArmoryStores) {}

  async describe(): Promise<{ registryUrl: string; officialRegistry: boolean }> {
    const configured = (await this.stores.settings.read()).registryUrl;
    const registryUrl = process.env.PEON_ARMORY_REGISTRY_URL || configured;
    return { registryUrl, officialRegistry: registryUrl === DEFAULT_ARMORY_REGISTRY_URL };
  }

  async refresh(options?: { force?: boolean }): Promise<CatalogResult> {
    const { registryUrl } = await this.describe();
    return new ArmoryCatalogClient({ registryUrl, cacheFile: this.stores.paths.catalogCacheFile }).refresh(options);
  }
}

const defaultStores = createArmoryStores();
export const armoryInventory = new ArmoryInventory(defaultStores.installed, new StoredCatalogSource(defaultStores));
