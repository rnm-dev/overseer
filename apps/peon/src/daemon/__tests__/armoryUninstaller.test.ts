import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ArmoryUninstallService,
  AtomicJsonStore,
  armoryActivationSchema,
  createArmoryStores,
  getArmoryActivation,
  initializeArmoryDirectories,
  packageActivationPath,
  packageVersionPath,
  recoverInterruptedArmoryUninstalls,
  resolveContainedPath,
  type ArmoryStores,
  type InstalledArmoryPackage,
} from "../armory/index.js";

const digest = "a".repeat(64);

async function fixture(options: { failingHook?: boolean } = {}): Promise<{ stores: ArmoryStores; installed: InstalledArmoryPackage }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "peon-armory-uninstall-"));
  const stores = createArmoryStores({ data: path.join(root, "data"), state: path.join(root, "state"), config: path.join(root, "config") });
  await initializeArmoryDirectories(stores.paths);
  const packageDir = packageVersionPath(stores.paths, "demo", "1.0.0");
  await mkdir(resolveContainedPath(packageDir, "bin"), { recursive: true });
  const hook = options.failingHook ? { lifecycle: { preUninstall: { executable: "node", args: ["bin/uninstall.mjs"] } } } : {};
  await writeFile(resolveContainedPath(packageDir, "armory.package.json"), JSON.stringify({
    schemaVersion: 1, id: "demo", version: "1.0.0", minPeonVersion: "0.0.1",
    platforms: [{ os: "darwin", arch: "arm64" }], permissions: { networkHosts: [], hostPaths: [] }, dependencies: [], ...hook,
  }));
  if (options.failingHook) {
    await writeFile(resolveContainedPath(packageDir, "bin/uninstall.mjs"), "process.stdout.write(JSON.stringify({protocolVersion:1,type:'result',ok:false,message:'keep package',errorCode:'HOOK_REFUSED'})+'\\n')\n");
  }
  const installed: InstalledArmoryPackage = {
    id: "demo", version: "1.0.0", enabled: true, state: "ready", installedAt: 10, updatedAt: 20,
    sourceDigest: digest, configurationStatus: "verified", lastError: null, activeOperationId: null, capabilities: { mcp: false },
  };
  await stores.installed.set(installed);
  await new AtomicJsonStore({ filePath: packageActivationPath(stores.paths, "demo"), schema: armoryActivationSchema, defaults: () => ({
    schemaVersion: 1, id: "demo", version: "1.0.0", previousVersion: null, activatedAt: 20,
    sourceDigest: digest, operationId: randomUUID(), installed,
  }) }).write({ schemaVersion: 1, id: "demo", version: "1.0.0", previousVersion: null, activatedAt: 20, sourceDigest: digest, operationId: randomUUID(), installed });
  const home = resolveContainedPath(stores.paths.homesDir, "demo");
  await mkdir(home, { recursive: true });
  await writeFile(resolveContainedPath(home, "settings.json"), "preserve me");
  await stores.credentials.set("demo", { token: "secret" }, 30);
  await stores.ownership.replace("demo", [{ path: resolveContainedPath(home, "settings.json"), root: "managed_home", createdAt: 30 }]);
  return { stores, installed };
}

async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

test("ordinary uninstall removes runtime state but preserves configuration and ownership", async () => {
  const { stores } = await fixture();
  const stopped: string[] = [];
  const service = new ArmoryUninstallService({ stores, runtime: { stop: async (id) => { stopped.push(id); } }, platform: { os: "darwin", arch: "arm64" } });
  const operation = await service.uninstall("demo");
  assert.equal((await service.operations.wait(operation.id)).status, "success");
  assert.deepEqual(stopped, ["demo"]);
  assert.equal(await getArmoryActivation(stores, "demo"), null);
  assert.equal(await stores.installed.get("demo"), null);
  assert.equal(await exists(resolveContainedPath(stores.paths.packagesDir, "demo")), false);
  assert.equal(await readFile(resolveContainedPath(stores.paths.homesDir, "demo", "settings.json"), "utf8"), "preserve me");
  assert.deepEqual(await stores.credentials.values("demo"), { token: "secret" });
  assert.equal((await stores.ownership.list("demo")).length, 1);
});

test("a pre-uninstall hook failure restores the exact package state and leaves all files", async () => {
  const { stores, installed } = await fixture({ failingHook: true });
  const service = new ArmoryUninstallService({ stores, runtime: { stop: async () => undefined }, platform: { os: "darwin", arch: "arm64" } });
  const operation = await service.uninstall("demo");
  const result = await service.operations.wait(operation.id);
  assert.equal(result.status, "failure");
  assert.equal(result.errorCode, "HOOK_REFUSED");
  assert.deepEqual(await stores.installed.get("demo"), { ...installed, enabled: false, lastError: "keep package", updatedAt: (await stores.installed.get("demo"))!.updatedAt });
  assert.equal((await getArmoryActivation(stores, "demo"))?.version, "1.0.0");
  assert.equal(await exists(packageVersionPath(stores.paths, "demo", "1.0.0")), true);
  assert.deepEqual(await stores.credentials.values("demo"), { token: "secret" });
});

test("startup recovery finishes a committed uninstall without deleting configuration", async () => {
  const { stores, installed } = await fixture();
  const operationId = randomUUID();
  await stores.operations.save({ id: operationId, packageId: "demo", kind: "uninstall", status: "running", phase: "removing", progress: 70, message: "Removing", errorCode: null, startedAt: 50, finishedAt: null });
  await stores.installed.set({ ...installed, enabled: false, state: "removing", activeOperationId: operationId, updatedAt: 50 });
  const staging = resolveContainedPath(stores.paths.stagingDir, operationId);
  await mkdir(staging, { recursive: true });
  await writeFile(resolveContainedPath(staging, "uninstall-transaction.json"), JSON.stringify({ schemaVersion: 1, operationId, packageId: "demo", version: "1.0.0", installed, phase: "hook_completed" }));
  assert.equal(await recoverInterruptedArmoryUninstalls(stores, 60), 1);
  assert.equal((await stores.operations.get(operationId))?.status, "success");
  assert.equal(await stores.installed.get("demo"), null);
  assert.equal(await readFile(resolveContainedPath(stores.paths.homesDir, "demo", "settings.json"), "utf8"), "preserve me");
  assert.deepEqual(await stores.credentials.values("demo"), { token: "secret" });
  assert.equal((await stores.ownership.list("demo")).length, 1);
});
