import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ArmoryInventoryReader } from "../armory/inventory.js";
import type { ArmoryMcpRuntime } from "../armory/mcpRuntime.js";
import type { ArmoryProjectPackagesService } from "../armory/projectPackages.js";
import { ArmoryRuntimeOperationsService } from "../armory/runtimeOperations.js";
import { createArmoryStores, initializeArmoryDirectories } from "../armory/stores.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "peon-armory-runtime-operations-"));
  const stores = createArmoryStores({ data: path.join(root, "data"), state: path.join(root, "state"), config: path.join(root, "config") });
  await initializeArmoryDirectories(stores.paths);
  await stores.installed.set({
    id: "fixture", version: "1.0.0", state: "ready", installedAt: 1, updatedAt: 1,
    sourceDigest: "a".repeat(64), lastError: null, activeOperationId: null, capabilities: { mcp: true },
  });
  const inventory = { get: async () => ({
    registry: { url: "https://example.test/armory.json", official: false, source: "live" as const, fetchedAt: 1, catalogUpdatedAt: new Date(0).toISOString(), error: null },
    package: { id: "fixture", available: true, displayName: "Fixture", iconUrl: null, summary: "Fixture", publisher: "rnm-dev", documentationUrl: "https://example.test", latestVersion: "2.0.0", requirements: { credentials: false, hostWrites: false }, capabilities: { mcp: true }, installed: null, updateAvailable: null },
    catalog: { id: "fixture", displayName: "Fixture", summary: "Fixture", publisher: "rnm-dev" as const, documentationUrl: "https://example.test", latest: "2.0.0", requirements: { credentials: false, hostWrites: false }, capabilities: { mcp: true }, versions: [{ version: "2.0.0", minPeonVersion: "1.2.0", platforms: [{ os: process.platform as "darwin" | "linux", arch: process.arch as "x64" | "arm64" }], archive: { url: "https://example.test/fixture.tgz", size: 100, sha256: "b".repeat(64) } }] },
  }) } as ArmoryInventoryReader;
  const calls: string[] = [];
  const runtime = {
    usage: (packageId: string) => ({ packageId, calls: 0, failures: 0, timeouts: 0, totalDurationMs: 0, activeCalls: 0, activeTurnLeases: 0, runningRuntimes: 0, lastUsedAt: null, resetAt: 1 }),
    drainStatus: (packageId: string) => ({ packageId, state: "accepting" as const, activeCalls: 0, activeTurnLeases: 0 }),
    restart: async (packageId: string) => { calls.push(`restart:${packageId}`); },
    stop: async (packageId: string) => { calls.push(`stop:${packageId}`); },
    diagnose: async () => [{ id: "mcp-handshake", status: "pass" as const, code: null }],
  } as unknown as ArmoryMcpRuntime;
  const projectPackages = { getAssignment: async () => ({ projectId: "00000000-0000-4000-8000-000000000001", packageId: "fixture", profileId: null }) } as unknown as ArmoryProjectPackagesService;
  return { stores, calls, service: new ArmoryRuntimeOperationsService({ stores, inventory, runtime, projectPackages, peonVersion: "1.2.1" }) };
}

test("preflight reports deterministic compatibility checks without downloading an archive", async () => {
  const { service } = await fixture();
  const result = await service.preflight("fixture");
  assert.equal(result.compatible, true);
  assert.equal(result.version, "2.0.0");
  assert.deepEqual(result.checks.map((entry) => entry.id), ["catalog", "version", "platform", "peon-version", "archive-size"]);
});

test("restart and explicit drain are durable package operations", async () => {
  const { service, calls } = await fixture();
  const restart = await service.restart("fixture");
  assert.equal((await service.operations.wait(restart.id)).status, "success");
  const drain = await service.drain("fixture");
  assert.equal((await service.operations.wait(drain.id)).status, "success");
  assert.deepEqual(calls, ["restart:fixture", "stop:fixture"]);
});
