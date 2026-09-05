import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dataDir } from "../runtime/xdgPaths.js";
import {
  ArmoryStorageError,
  cleanupArmoryArtifacts,
  createArmoryPaths,
  createArmoryStores,
  initializeArmoryDirectories,
  parseArmoryCatalog,
  parseArmoryHookEvent,
  parseArmoryManifest,
  resolveContainedPath,
  type ArmoryOperation,
  type InstalledArmoryPackage,
} from "../armory/index.js";

function isolatedRoots() {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-armory-"));
  return {
    root,
    roots: {
      config: path.join(root, "config"),
      data: path.join(root, "data"),
      state: path.join(root, "state"),
    },
  };
}

function installed(id = "fixture-echo"): InstalledArmoryPackage {
  return {
    id,
    version: "1.0.0",
    enabled: false,
    state: "ready",
    installedAt: 100,
    updatedAt: 100,
    sourceDigest: "a".repeat(64),
    configurationStatus: "not_required",
    lastError: null,
    activeOperationId: null,
  };
}

function operation(index: number): ArmoryOperation {
  return {
    id: randomUUID(),
    packageId: "fixture-echo",
    kind: "install",
    status: "success",
    phase: "complete",
    progress: 100,
    message: `operation ${index}`,
    errorCode: null,
    startedAt: index,
    finishedAt: index,
  };
}

test("dataDir follows XDG_DATA_HOME and the .peon convention", () => {
  const previous = process.env.XDG_DATA_HOME;
  const home = path.join(os.tmpdir(), `peon-data-${randomUUID()}`);
  process.env.XDG_DATA_HOME = home;
  try { assert.equal(dataDir(), path.join(home, ".peon")); }
  finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
});

test("missing and legacy-empty stores receive safe migration defaults", async () => {
  const { roots } = isolatedRoots();
  const stores = createArmoryStores(roots);
  assert.deepEqual(await stores.installed.list(), []);
  assert.deepEqual(await stores.settings.read(), {
    schemaVersion: 1,
    registryUrl: "https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json",
    agentInstallAllowlist: [],
  });

  await mkdir(roots.config, { recursive: true });
  await writeFile(stores.paths.settingsFile, "{}\n", { mode: 0o600 });
  assert.deepEqual(await createArmoryStores(roots).settings.read(), {
    schemaVersion: 1,
    registryUrl: "https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json",
    agentInstallAllowlist: [],
  });
});

test("installed state writes atomically and survives a store restart", async () => {
  const { roots } = isolatedRoots();
  const first = createArmoryStores(roots);
  await first.installed.set(installed());
  assert.equal((await stat(first.paths.installedFile)).mode & 0o777, 0o600);
  assert.equal((await readdir(path.dirname(first.paths.installedFile))).some((name) => name.endsWith(".tmp")), false);

  const restarted = createArmoryStores(roots);
  assert.deepEqual(await restarted.installed.get("fixture-echo"), installed());
});

test("malformed and command-bearing persisted state fail clearly", async () => {
  const { roots } = isolatedRoots();
  const stores = createArmoryStores(roots);
  await mkdir(path.dirname(stores.paths.installedFile), { recursive: true });
  await writeFile(stores.paths.installedFile, "{broken", { mode: 0o600 });
  await assert.rejects(stores.installed.list(), (error: unknown) => error instanceof ArmoryStorageError && error.code === "MALFORMED_STATE");

  await writeFile(stores.paths.installedFile, `${JSON.stringify({ schemaVersion: 1, packages: { "fixture-echo": { ...installed(), command: { executable: "bad", args: [] } } } })}\n`, { mode: 0o600 });
  await assert.rejects(createArmoryStores(roots).installed.list(), (error: unknown) => error instanceof ArmoryStorageError && error.code === "INVALID_STATE");
});

test("concurrent settings updates are serialized without losing entries", async () => {
  const { roots } = isolatedRoots();
  const stores = createArmoryStores(roots);
  const ids = Array.from({ length: 20 }, (_, index) => `fixture-${index}`);
  await Promise.all(ids.map((id) => stores.settings.update((current) => ({ ...current, agentInstallAllowlist: [...current.agentInstallAllowlist, id] }))));
  assert.deepEqual((await stores.settings.read()).agentInstallAllowlist, ids);
});

test("independent store instances serialize updates to the same state file", async () => {
  const { roots } = isolatedRoots();
  const stores = Array.from({ length: 20 }, () => createArmoryStores(roots));
  const ids = stores.map((_, index) => `shared-${index}`);
  await Promise.all(stores.map((entry, index) => entry.settings.update(async (current) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { ...current, agentInstallAllowlist: [...current.agentInstallAllowlist, ids[index]!] };
  })));
  assert.deepEqual((await createArmoryStores(roots).settings.read()).agentInstallAllowlist, ids);
});

test("structured credential storage is 0600 and metadata never exposes values", async () => {
  const { roots } = isolatedRoots();
  const stores = createArmoryStores(roots);
  const metadata = await stores.credentials.set("fixture-configured", { apiToken: "top-secret", region: "test-east" }, 123);
  assert.equal(JSON.stringify(metadata).includes("top-secret"), false);
  assert.deepEqual(metadata.configuredFields, { apiToken: true, region: true });
  assert.deepEqual(await stores.credentials.values("fixture-configured"), { apiToken: "top-secret", region: "test-east" });
  assert.equal((await stat(stores.paths.credentialsFile)).mode & 0o777, 0o600);
  assert.ok((await readFile(stores.paths.credentialsFile, "utf8")).includes("top-secret"));
});

test("ownership ledgers persist independently", async () => {
  const { roots } = isolatedRoots();
  const stores = createArmoryStores(roots);
  await stores.ownership.replace("fixture-configured", [{ path: "config/config.json", root: "managed_home", createdAt: 10 }]);
  const restarted = createArmoryStores(roots);
  assert.deepEqual(await restarted.ownership.list("fixture-configured"), [{ path: "config/config.json", root: "managed_home", createdAt: 10 }]);
});

test("path containment rejects traversal and invalid package IDs", async () => {
  const root = path.join(os.tmpdir(), "armory-root");
  assert.equal(resolveContainedPath(root, "fixture", "file"), path.join(root, "fixture", "file"));
  assert.throws(() => resolveContainedPath(root, "..", "escape"), /escapes Armory root/);
  const paths = createArmoryPaths({ config: root, data: root, state: root });
  assert.throws(() => paths.logsDir && resolveContainedPath(paths.logsDir, "..", "outside"));
  await assert.rejects(createArmoryStores({ config: root, data: root, state: root }).credentials.metadata("../bad"));
});

test("operation history, stale staging, and stale logs are cleaned safely", async () => {
  const { roots } = isolatedRoots();
  const stores = createArmoryStores(roots);
  await initializeArmoryDirectories(stores.paths);
  for (const index of [1, 2, 3]) await stores.operations.save(operation(index));

  const oldStaging = path.join(stores.paths.stagingDir, randomUUID());
  const freshStaging = path.join(stores.paths.stagingDir, randomUUID());
  const oldLog = path.join(stores.paths.logsDir, "fixture-echo.log");
  await mkdir(oldStaging);
  await mkdir(freshStaging);
  await writeFile(oldLog, "old log\n");
  await utimes(oldStaging, new Date(1), new Date(1));
  await utimes(oldLog, new Date(1), new Date(1));

  const result = await cleanupArmoryArtifacts(stores.paths, { now: 10_000, maxOperationHistory: 1, stagingMaxAgeMs: 5_000, logMaxAgeMs: 5_000 });
  assert.deepEqual(result, { operationsRemoved: 2, stagingRemoved: 1, logsRemoved: 1 });
  assert.equal((await stores.operations.list()).length, 1);
  assert.deepEqual(await readdir(stores.paths.stagingDir), [path.basename(freshStaging)]);
});

test("catalog, manifest, and hook validators reject unknown or malformed fields", () => {
  assert.throws(() => parseArmoryCatalog({ schemaVersion: 1, name: "rnm-dev/armory", updatedAt: "2026-07-14T00:00:00.000Z", packages: [], typo: true }));
  const manifest = {
    schemaVersion: 1,
    id: "fixture-echo",
    version: "1.0.0",
    minPeonVersion: "0.0.1",
    platforms: [{ os: "linux", arch: "x64" }],
    permissions: { networkHosts: [], hostPaths: [] },
    dependencies: [],
    mcp: { command: { executable: "node", args: ["dist/mcp.js"] }, toolPrefix: "fixture_echo" },
  };
  assert.equal(parseArmoryManifest(manifest).id, "fixture-echo");
  assert.deepEqual(
    parseArmoryManifest({ ...manifest, permissions: { networkHosts: ["*", "*.example.com", "api.example.com"], hostPaths: [] } }).permissions.networkHosts,
    ["*", "*.example.com", "api.example.com"],
  );
  for (const networkHost of ["*example.com", "example.*", "https://example.com", "UPPER.example.com"]) {
    assert.throws(() => parseArmoryManifest({ ...manifest, permissions: { networkHosts: [networkHost], hostPaths: [] } }));
  }
  const { mcp: _mcp, ...withoutMcp } = manifest;
  assert.equal(parseArmoryManifest(withoutMcp).mcp, undefined);
  assert.throws(() => parseArmoryManifest({ ...manifest, typo: true }));
  assert.equal(parseArmoryHookEvent({ protocolVersion: 1, type: "result", ok: true, message: "ready" }).type, "result");
  assert.throws(() => parseArmoryHookEvent({ protocolVersion: 1, type: "result", ok: false, message: "failed" }));
});
