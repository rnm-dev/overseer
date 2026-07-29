import assert from "node:assert/strict";
import test from "node:test";
import { ArmoryCatalogError, type CatalogResult } from "../armory/catalogClient.js";
import type { ArmoryCatalog, InstalledArmoryPackage } from "../armory/contracts.js";
import { ArmoryInventory, type ArmoryInventoryCatalogSource } from "../armory/inventory.js";

const installed: InstalledArmoryPackage = {
  id: "aws",
  version: "1.0.0",
  enabled: true,
  state: "ready",
  installedAt: 100,
  updatedAt: 200,
  sourceDigest: "a".repeat(64),
  configurationStatus: "verified",
  lastError: null,
  activeOperationId: null,
};

const catalog: ArmoryCatalog = {
  schemaVersion: 1,
  name: "rnm-dev/armory",
  updatedAt: "2026-07-15T00:00:00.000Z",
  packages: [
    {
      id: "aws",
      displayName: "AWS",
      iconUrl: "https://raw.githubusercontent.com/rnm-dev/armory/main/packages/aws/assets/icon.png",
      summary: "Inspect AWS resources.",
      publisher: "rnm-dev",
      documentationUrl: "https://github.com/rnm-dev/armory/tree/main/packages/aws",
      latest: "1.1.0",
      requirements: { credentials: true, hostWrites: false },
      versions: [{
        version: "1.1.0",
        minPeonVersion: "0.0.1",
        platforms: [{ os: "darwin", arch: "arm64" }],
        archive: {
          url: "https://github.com/rnm-dev/armory/releases/download/aws-v1.1.0/aws-1.1.0.tar.gz",
          size: 100,
          sha256: "b".repeat(64),
        },
      }],
    },
    {
      id: "google-analytics",
      displayName: "Google Analytics",
      summary: "Read analytics reports.",
      publisher: "rnm-dev",
      documentationUrl: "https://github.com/rnm-dev/armory/tree/main/packages/google-analytics",
      latest: "1.0.0",
      requirements: { credentials: true, hostWrites: false },
      versions: [{
        version: "1.0.0",
        minPeonVersion: "0.0.1",
        platforms: [{ os: "darwin", arch: "arm64" }],
        archive: {
          url: "https://github.com/rnm-dev/armory/releases/download/google-analytics-v1.0.0/google-analytics-1.0.0.tar.gz",
          size: 100,
          sha256: "c".repeat(64),
        },
      }],
    },
  ],
};

function source(result: CatalogResult | Error): ArmoryInventoryCatalogSource {
  return {
    async describe() {
      return { registryUrl: "https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json", officialRegistry: true };
    },
    async refresh() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const live: CatalogResult = {
  catalog,
  source: "live",
  registryUrl: "https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json",
  officialRegistry: true,
  fetchedAt: 300,
  etag: "catalog-v1",
  lastRefreshError: null,
};

test("inventory merges catalog availability with installed state and update status", async () => {
  const inventory = new ArmoryInventory({ list: async () => [installed] }, source(live));
  const result = await inventory.list();

  assert.equal(result.registry.source, "live");
  assert.equal(result.total, 2);
  assert.equal(result.packages[0].id, "aws");
  assert.equal(result.packages[0].iconUrl, "https://raw.githubusercontent.com/rnm-dev/armory/main/packages/aws/assets/icon.png");
  assert.deepEqual(result.packages[0].installed, installed);
  assert.equal(result.packages[0].updateAvailable, true);
  assert.equal(result.packages[0].capabilities.mcp, true);
  assert.equal(result.packages[1].installed, null);

  const detail = await inventory.get("aws");
  assert.equal(detail.catalog?.versions[0].version, "1.1.0");
  assert.equal(detail.catalog?.versions[0].archive.size, 100);
});

test("inventory supports installed filtering, search, and opaque pagination", async () => {
  const inventory = new ArmoryInventory({ list: async () => [installed] }, source(live));
  const installedOnly = await inventory.list({ installedOnly: true });
  assert.deepEqual(installedOnly.packages.map((entry) => entry.id), ["aws"]);

  const searched = await inventory.list({ q: "analytics" });
  assert.deepEqual(searched.packages.map((entry) => entry.id), ["google-analytics"]);

  const first = await inventory.list({ limit: 1 });
  assert.equal(first.packages.length, 1);
  assert.ok(first.nextCursor);
  const second = await inventory.list({ limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.packages.map((entry) => entry.id), ["google-analytics"]);
});

test("registry failure still returns installed packages without credential data", async () => {
  const inventory = new ArmoryInventory(
    { list: async () => [installed] },
    source(new ArmoryCatalogError("REGISTRY_UNAVAILABLE", "registry offline")),
  );
  const result = await inventory.list();

  assert.equal(result.registry.source, "unavailable");
  assert.equal(result.registry.error?.code, "REGISTRY_UNAVAILABLE");
  assert.equal(result.packages[0].available, false);
  assert.deepEqual(result.packages[0].installed, installed);
  assert.equal(JSON.stringify(result).includes("credential"), false);
});
