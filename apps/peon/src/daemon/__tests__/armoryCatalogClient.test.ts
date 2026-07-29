import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ArmoryCatalogClient,
  ArmoryCatalogError,
  detectCatalogUpdate,
  getCatalogPackage,
  resolveCatalogVersion,
  searchCatalog,
  createArmoryStores,
  type ArmoryCatalog,
} from "../armory/index.js";

function cacheFile(): string { return path.join(mkdtempSync(path.join(os.tmpdir(), "peon-catalog-")), "catalog-cache.json"); }

function catalog(): ArmoryCatalog {
  return {
    schemaVersion: 1,
    name: "rnm-dev/armory",
    updatedAt: "2026-07-14T12:00:00.000Z",
    packages: [{
      id: "fixture-echo",
      displayName: "Fixture Echo",
      iconUrl: "https://raw.githubusercontent.com/rnm-dev/armory/main/packages/fixture-echo/assets/icon.png",
      summary: "Offline echo fixture.",
      publisher: "rnm-dev",
      documentationUrl: "https://github.com/rnm-dev/armory/tree/main/packages/fixture-echo",
      latest: "2.0.0",
      requirements: { credentials: false, hostWrites: false },
      capabilities: { mcp: true },
      versions: [
        {
          version: "1.0.0",
          minPeonVersion: "0.0.1",
          platforms: [{ os: "linux", arch: "x64" }],
          archive: { url: "https://github.com/rnm-dev/armory/releases/download/fixture-echo-v1.0.0/fixture-echo-1.0.0.tar.gz", size: 100, sha256: "a".repeat(64) },
        },
        {
          version: "1.5.0",
          minPeonVersion: "0.0.1",
          platforms: [{ os: "darwin", arch: "arm64" }],
          archive: { url: "https://github.com/rnm-dev/armory/releases/download/fixture-echo-v1.5.0/fixture-echo-1.5.0.tar.gz", size: 100, sha256: "b".repeat(64) },
        },
        {
          version: "2.0.0",
          minPeonVersion: "2.0.0",
          platforms: [{ os: "linux", arch: "x64" }],
          archive: { url: "https://github.com/rnm-dev/armory/releases/download/fixture-echo-v2.0.0/fixture-echo-2.0.0.tar.gz", size: 100, sha256: "c".repeat(64) },
        },
      ],
    }],
  };
}

function response(value = catalog(), init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", etag: '"fixture-v1"', ...init.headers }, ...init });
}

test("successful refresh validates and atomically caches the live catalog", async () => {
  const client = new ArmoryCatalogClient({ cacheFile: cacheFile(), fetchImpl: async () => response(), now: () => 123 });
  const live = await client.refresh();
  assert.equal(live.source, "live");
  assert.equal(live.fetchedAt, 123);
  assert.equal(live.etag, '"fixture-v1"');
  assert.equal(live.officialRegistry, true);
  const cached = await client.cached();
  assert.equal(cached?.source, "cached");
  assert.deepEqual(cached?.catalog, catalog());
});

test("ETag refresh sends If-None-Match and accepts 304 only with cache", async () => {
  const file = cacheFile();
  let request = 0;
  const seen: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers).get("if-none-match"));
    request += 1;
    return request === 1 ? response() : new Response(null, { status: 304 });
  };
  const client = new ArmoryCatalogClient({ cacheFile: file, fetchImpl, now: () => 10 });
  await client.refresh();
  const result = await client.refresh();
  assert.deepEqual(seen, [null, '"fixture-v1"']);
  assert.equal(result.source, "cached");
  assert.equal(result.lastRefreshError, null);

  const empty = new ArmoryCatalogClient({ cacheFile: cacheFile(), fetchImpl: async () => new Response(null, { status: 304 }) });
  await assert.rejects(empty.refresh(), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "INVALID_CATALOG");
});

test("forced refresh bypasses stale validators with a policy-safe cache buster", async () => {
  const file = cacheFile();
  const seen: Array<{ url: string; etag: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), etag: new Headers(init?.headers).get("if-none-match") });
    return response();
  };
  const client = new ArmoryCatalogClient({ cacheFile: file, fetchImpl, now: () => 456 });
  await client.refresh();
  await client.refresh({ force: true });
  assert.deepEqual(seen, [
    { url: "https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json", etag: null },
    { url: "https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json?_peon_refresh=456", etag: null },
  ]);
});

test("manual same-host redirects work and cross-host redirects are denied", async () => {
  const visited: string[] = [];
  const redirected = new ArmoryCatalogClient({
    registryUrl: "https://registry.test/armory.json",
    cacheFile: cacheFile(),
    fetchImpl: async (input) => {
      visited.push(String(input));
      return visited.length === 1 ? new Response(null, { status: 302, headers: { location: "/catalog/v1.json" } }) : response();
    },
  });
  assert.equal((await redirected.refresh()).officialRegistry, false);
  assert.deepEqual(visited, ["https://registry.test/armory.json", "https://registry.test/catalog/v1.json"]);

  const denied = new ArmoryCatalogClient({
    registryUrl: "https://registry.test/armory.json",
    cacheFile: cacheFile(),
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://other.test/catalog.json" } }),
  });
  await assert.rejects(denied.refresh(), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "POLICY_DENIED");
});

test("timeouts and both declared and streaming size excesses fail safely", async () => {
  const timeout = new ArmoryCatalogClient({
    registryUrl: "https://registry.test/armory.json",
    cacheFile: cacheFile(),
    timeoutMs: 10,
    fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
  });
  await assert.rejects(timeout.refresh(), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "REGISTRY_TIMEOUT");

  const declared = new ArmoryCatalogClient({ cacheFile: cacheFile(), maxBytes: 20, fetchImpl: async () => new Response("{}", { headers: { "content-length": "21" } }) });
  await assert.rejects(declared.refresh(), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "CATALOG_TOO_LARGE");

  const streamed = new ArmoryCatalogClient({ cacheFile: cacheFile(), maxBytes: 20, fetchImpl: async () => new Response("x".repeat(21)) });
  await assert.rejects(streamed.refresh(), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "CATALOG_TOO_LARGE");
});

test("invalid catalogs and unapproved release hosts never replace a good cache", async () => {
  const file = cacheFile();
  let current: Response = response();
  const client = new ArmoryCatalogClient({ cacheFile: file, fetchImpl: async () => current });
  await client.refresh();
  current = response({ ...catalog(), typo: true } as unknown as ArmoryCatalog);
  const stale = await client.refresh();
  assert.equal(stale.source, "cached");
  assert.equal(stale.lastRefreshError?.code, "INVALID_CATALOG");

  const unsafe = catalog();
  unsafe.packages[0].versions[0].archive.url = "https://evil.example/package.tar.gz";
  const policy = new ArmoryCatalogClient({ cacheFile: cacheFile(), fetchImpl: async () => response(unsafe) });
  await assert.rejects(policy.refresh(), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "POLICY_DENIED");

  const unsafeIcon = catalog();
  unsafeIcon.packages[0].iconUrl = "https://evil.example/icon.png";
  const iconPolicy = new ArmoryCatalogClient({ cacheFile: cacheFile(), fetchImpl: async () => response(unsafeIcon) });
  await assert.rejects(iconPolicy.refresh(), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "POLICY_DENIED");
});

test("schema version, duplicates, and malformed digests are rejected before caching", async () => {
  const values: unknown[] = [];
  values.push({ ...catalog(), schemaVersion: 2 });
  const duplicate = catalog();
  duplicate.packages.push(structuredClone(duplicate.packages[0]));
  values.push(duplicate);
  const digest = catalog();
  digest.packages[0].versions[0].archive.sha256 = "NOT-A-DIGEST";
  values.push(digest);
  for (const value of values) {
    const client = new ArmoryCatalogClient({ cacheFile: cacheFile(), fetchImpl: async () => response(value as ArmoryCatalog) });
    await assert.rejects(client.refresh(), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "INVALID_CATALOG");
    assert.equal(await client.cached(), null);
  }
});

test("network failure returns last-known-good cache and fails clearly without one", async () => {
  const file = cacheFile();
  let online = true;
  const fetchImpl: typeof fetch = async () => {
    if (!online) throw new Error("internal connection details");
    return response();
  };
  const client = new ArmoryCatalogClient({ cacheFile: file, fetchImpl });
  await client.refresh();
  online = false;
  const fallback = await client.refresh();
  assert.equal(fallback.source, "cached");
  assert.deepEqual(fallback.lastRefreshError, { code: "REGISTRY_UNAVAILABLE", message: "Armory registry request failed" });
  assert.equal(JSON.stringify(fallback).includes("internal connection details"), false);

  const empty = new ArmoryCatalogClient({ cacheFile: cacheFile(), fetchImpl });
  await assert.rejects(empty.refresh(), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "REGISTRY_UNAVAILABLE");
});

test("registry failure cannot hide or corrupt independently persisted installations", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-catalog-installed-"));
  const stores = createArmoryStores({ config: path.join(root, "config"), data: path.join(root, "data"), state: path.join(root, "state") });
  await stores.installed.set({
    id: "fixture-echo",
    version: "1.0.0",
    enabled: true,
    state: "ready",
    installedAt: 1,
    updatedAt: 1,
    sourceDigest: "a".repeat(64),
    configurationStatus: "not_required",
    lastError: null,
    activeOperationId: null,
  });
  const client = new ArmoryCatalogClient({ cacheFile: stores.paths.catalogCacheFile, fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(client.refresh(), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "REGISTRY_UNAVAILABLE");
  assert.equal((await createArmoryStores({ config: path.join(root, "config"), data: path.join(root, "data"), state: path.join(root, "state") }).installed.get("fixture-echo"))?.enabled, true);
});

test("search, detail, compatibility resolution, and update detection are deterministic", () => {
  const value = catalog();
  assert.equal(searchCatalog(value, "offline").packages[0]?.id, "fixture-echo");
  assert.equal(searchCatalog(value, "echo", { installedOnly: true, installedIds: [] }).total, 0);
  assert.equal(searchCatalog(value, "echo", { installedOnly: true, installedIds: ["fixture-echo"] }).total, 1);
  assert.equal(getCatalogPackage(value, "fixture-echo").displayName, "Fixture Echo");
  assert.throws(() => getCatalogPackage(value, "missing"), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "PACKAGE_NOT_FOUND");

  const linux = { os: "linux", arch: "x64" } as const;
  assert.equal(resolveCatalogVersion(value, "fixture-echo", { peonVersion: "1.0.0", platform: linux }).version, "1.0.0");
  assert.equal(resolveCatalogVersion(value, "fixture-echo", { peonVersion: "2.0.0", platform: linux }).version, "2.0.0");
  assert.throws(() => resolveCatalogVersion(value, "fixture-echo", { version: "2.0.0", peonVersion: "1.0.0", platform: linux }), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "INCOMPATIBLE_PEON_VERSION");
  assert.throws(() => resolveCatalogVersion(value, "fixture-echo", { version: "9.0.0", peonVersion: "9.0.0", platform: linux }), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "VERSION_NOT_FOUND");
  assert.throws(() => resolveCatalogVersion(value, "fixture-echo", { peonVersion: "9.0.0", platform: { os: "darwin", arch: "x64" } }), (error: unknown) => error instanceof ArmoryCatalogError && error.code === "UNSUPPORTED_PLATFORM");
  assert.deepEqual(detectCatalogUpdate(value, "fixture-echo", "1.0.0", { peonVersion: "2.0.0", platform: linux }), { updateAvailable: true, installedVersion: "1.0.0", recommendedVersion: "2.0.0" });
});
