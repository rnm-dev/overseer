import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicJsonStore } from "../armory/atomicJsonStore.js";
import { armoryActivationSchema, type ArmoryManifest, type StoredArmoryProfile } from "../armory/contracts.js";
import { ArmoryMcpRuntime } from "../armory/mcpRuntime.js";
import { ArmoryOperationError } from "../armory/operationCoordinator.js";
import { packageActivationPath, packageVersionPath } from "../armory/paths.js";
import { createArmoryStores, initializeArmoryDirectories, type ArmoryStores } from "../armory/stores.js";
import { McpBindingRegistry, McpConfigAssembler } from "../mcpBindings.js";

const PROJECT_A = "87b68e30-a923-48b4-9a58-f561a2390083";
const PROJECT_B = "2f6c6295-3596-4fb9-a4e4-6f37dc8a2c71";
const PROFILE_A = "57ba5e9e-3ed2-4a92-919f-9f60ee69a450";
const PROFILE_B = "cbf7c0ae-4167-4107-b4cf-4cf334ce49ef";

async function fixture(options: { credentialFree?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "peon-armory-project-runtime-"));
  const stores = createArmoryStores({ data: path.join(root, "data"), state: path.join(root, "state"), config: path.join(root, "config") });
  await initializeArmoryDirectories(stores.paths);
  await installPackage(stores, "fixture-echo", options.credentialFree ?? false);
  const profiles: Record<string, StoredArmoryProfile> = options.credentialFree ? {} : {
    [PROFILE_A]: profile(PROFILE_A, "alpha", 10),
    [PROFILE_B]: profile(PROFILE_B, "bravo", 20),
  };
  await stores.projectPackages.write({
    schemaVersion: 1,
    migrationCompletedAt: 1,
    profiles,
    assignments: [{ projectId: PROJECT_A, packageId: "fixture-echo", profileId: options.credentialFree ? null : PROFILE_A }],
    legacyProfileByPackage: {},
  });
  const registry = new McpBindingRegistry();
  const runtime = new ArmoryMcpRuntime(stores, registry);
  const connections: Array<{ runtimeKey: string; packageId: string; profileId: string | null; profileValues: Record<string, string> }> = [];
  let closes = 0;
  (runtime as unknown as { connectPackage(selection: typeof connections[number]): Promise<unknown> }).connectPackage = async (selection) => {
    connections.push(structuredClone(selection));
    return {
      client: {
        callTool: async () => ({ content: [{ type: "text", text: selection.profileValues.token ?? "credential-free" }] }),
        close: async () => { closes += 1; },
      },
      transport: { close: async () => undefined, onclose: undefined },
      selection,
      tools: [{ name: "identity", description: "Return the selected profile identity", inputSchema: { type: "object", properties: {} } }],
    };
  };
  return { stores, runtime, registry, connections, closes: () => closes };
}

function profile(profileId: string, token: string, updatedAt: number): StoredArmoryProfile {
  return { profileId, type: "example-token", name: token, status: "verified", values: { token, unrelatedSecret: "never-injected" }, createdAt: 1, updatedAt };
}

async function installPackage(stores: ArmoryStores, packageId: string, credentialFree: boolean): Promise<void> {
  const installed = {
    id: packageId,
    version: "1.0.0",
    state: "ready" as const,
    installedAt: 1,
    updatedAt: 1,
    sourceDigest: packageId === "fixture-echo" ? "a".repeat(64) : "b".repeat(64),
    lastError: null,
    activeOperationId: null,
    capabilities: { mcp: true },
  };
  await stores.installed.set(installed);
  const packageDir = packageVersionPath(stores.paths, packageId, "1.0.0");
  await mkdir(packageDir, { recursive: true });
  const manifest: ArmoryManifest = {
    schemaVersion: 1,
    id: packageId,
    version: "1.0.0",
    minPeonVersion: "0.0.1",
    platforms: [{ os: "darwin", arch: "arm64" }],
    permissions: { networkHosts: [], hostPaths: [] },
    dependencies: [],
    ...(credentialFree ? {} : {
      configuration: {
        fields: [{ id: "token", label: "Token", type: "secret" as const, required: true }],
        handler: { executable: "node", args: ["configure.mjs"] },
        managedPaths: ["token.txt"],
      },
      profile: { type: "example-token", requiredFields: ["token"] },
    }),
    mcp: { command: { executable: "node", args: ["mcp.mjs"] }, toolPrefix: "fixture" },
  };
  await writeFile(path.join(packageDir, "armory.package.json"), JSON.stringify(manifest));
  await writeFile(path.join(packageDir, "configure.mjs"), "");
  await writeFile(path.join(packageDir, "mcp.mjs"), "");
  const activation = {
    schemaVersion: 1 as const,
    id: packageId,
    version: "1.0.0",
    previousVersion: null,
    activatedAt: 1,
    sourceDigest: installed.sourceDigest,
    operationId: randomUUID(),
    installed,
  };
  await new AtomicJsonStore({ filePath: packageActivationPath(stores.paths, packageId), schema: armoryActivationSchema, defaults: () => activation }).write(activation);
}

function binding(lease: ReturnType<ArmoryMcpRuntime["snapshotTurn"]>): string {
  assert.equal(lease.bindings.length, 1);
  return lease.bindings[0]!.bindingId;
}

test("concurrent projects isolate different typed profiles while a shared profile reuses the exact runtime", async () => {
  const { stores, runtime, connections } = await fixture();
  await stores.projectPackages.update((state) => ({
    ...state,
    assignments: [
      { projectId: PROJECT_A, packageId: "fixture-echo", profileId: PROFILE_A },
      { projectId: PROJECT_B, packageId: "fixture-echo", profileId: PROFILE_B },
    ],
  }));
  const alpha = runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "alpha-session", turnId: "alpha-turn" });
  const bravo = runtime.snapshotTurn({ projectId: PROJECT_B, sessionId: "bravo-session", turnId: "bravo-turn" });
  await Promise.all([
    runtime.listTools(binding(alpha), "alpha-session"),
    runtime.listTools(binding(bravo), "bravo-session"),
  ]);
  assert.deepEqual(connections.map((entry) => entry.profileValues.token).sort(), ["alpha", "bravo"]);
  assert.equal(connections.some((entry) => "unrelatedSecret" in entry.profileValues), false);
  assert.notEqual(connections[0]!.runtimeKey, connections[1]!.runtimeKey);
  await assert.rejects(runtime.listTools(binding(alpha), "bravo-session"), (error: unknown) => error instanceof ArmoryOperationError && error.code === "MCP_BINDING_INVALID");
  alpha.release();
  bravo.release();

  await stores.projectPackages.update((state) => ({
    ...state,
    assignments: [
      { projectId: PROJECT_A, packageId: "fixture-echo", profileId: PROFILE_A },
      { projectId: PROJECT_B, packageId: "fixture-echo", profileId: PROFILE_A },
    ],
  }));
  connections.length = 0;
  const sharedA = runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "shared-a", turnId: "turn-a" });
  const sharedB = runtime.snapshotTurn({ projectId: PROJECT_B, sessionId: "shared-b", turnId: "turn-b" });
  await Promise.all([
    runtime.listTools(binding(sharedA), "shared-a"),
    runtime.listTools(binding(sharedB), "shared-b"),
  ]);
  assert.equal(connections.length, 1);
  assert.equal(connections[0]!.profileId, PROFILE_A);
  sharedA.release();
  sharedB.release();
  await runtime.close();
});

test("unassigned packages contribute no binding or provider context and credential-free assignments use null", async () => {
  const assigned = await fixture();
  await installPackage(assigned.stores, "unassigned-broken", true);
  await writeFile(path.join(packageVersionPath(assigned.stores.paths, "unassigned-broken", "1.0.0"), "armory.package.json"), "not-json");
  const lease = assigned.runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "assigned", turnId: "turn" });
  assert.deepEqual(lease.bindings.map((entry) => entry.packageId), ["fixture-echo"]);
  lease.release();
  const none = assigned.runtime.snapshotTurn({ projectId: PROJECT_B, sessionId: "none", turnId: "turn" });
  assert.deepEqual(none.bindings, []);
  const assembled = new McpConfigAssembler(assigned.registry, "http://127.0.0.1:4570").assemble({
    projectId: PROJECT_B, sessionId: "none", turnId: "turn-2", allowSessionSpawning: false,
  })!;
  assert.equal(Object.keys(assembled.mcpServers).some((name) => name.startsWith("armory_")), false);
  none.release();
  assembled.release?.();
  await assigned.runtime.close();

  const credentialFree = await fixture({ credentialFree: true });
  const freeLease = credentialFree.runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "free", turnId: "turn" });
  await credentialFree.runtime.listTools(binding(freeLease), "free");
  assert.equal(credentialFree.connections[0]!.profileId, null);
  assert.deepEqual(credentialFree.connections[0]!.profileValues, {});
  freeLease.release();
  await credentialFree.runtime.close();
});

test("turn snapshots preserve old profile state while later mutations affect only later turns", async () => {
  const { stores, runtime, connections } = await fixture();
  const oldLease = runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "session-old", turnId: "turn-old" });
  await stores.projectPackages.update((state) => ({
    ...state,
    profiles: { ...state.profiles, [PROFILE_A]: profile(PROFILE_A, "rotated", 30) },
  }));
  const newLease = runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "session-new", turnId: "turn-new" });
  const [oldResult, newResult] = await Promise.all([
    runtime.callTool(binding(oldLease), "session-old", "identity", {}),
    runtime.callTool(binding(newLease), "session-new", "identity", {}),
  ]);
  assert.equal(oldResult.content[0]?.type === "text" ? oldResult.content[0].text : null, "alpha");
  assert.equal(newResult.content[0]?.type === "text" ? newResult.content[0].text : null, "rotated");
  assert.equal(connections.length, 2);
  assert.notEqual(connections[0]!.runtimeKey, connections[1]!.runtimeKey);
  oldLease.release();
  newLease.release();
  await runtime.close();
});

test("profile materialization supplies only declared fields and redacts runtime startup failures", async () => {
  const { stores, runtime } = await fixture();
  delete (runtime as unknown as { connectPackage?: unknown }).connectPackage;
  const packageDir = packageVersionPath(stores.paths, "fixture-echo", "1.0.0");
  await writeFile(path.join(packageDir, "configure.mjs"), `
    import fs from "node:fs/promises";
    const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks).toString());
    if ("unrelatedSecret" in input.configuration) process.exit(9);
    await fs.writeFile(new URL("token.txt", "file://" + input.package.home + "/"), input.configuration.token);
    process.stdout.write(JSON.stringify({protocolVersion:1,type:"result",ok:true,message:"configured",ownedPaths:["token.txt"]})+"\\n");
  `);
  await writeFile(path.join(packageDir, "mcp.mjs"), `
    import fs from "node:fs";
    process.stderr.write("TOKEN=" + fs.readFileSync(process.env.HOME + "/token.txt", "utf8"));
    process.exit(1);
  `);
  const lease = runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "redacted", turnId: "turn" });
  await assert.rejects(
    runtime.listTools(binding(lease), "redacted"),
    (error: unknown) => error instanceof ArmoryOperationError
      && error.code === "MCP_START_FAILED"
      && error.message.includes("TOKEN=[REDACTED]")
      && !error.message.includes("alpha")
      && !error.message.includes("never-injected"),
  );
  lease.release();
  await runtime.close();
});

test("turn resolution isolates invalid packages instead of aborting the whole turn", async () => {
  const { stores, runtime } = await fixture();
  const expectCode = (code: string) => {
    const lease = runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "invalid", turnId: randomUUID() });
    assert.deepEqual(lease.bindings, []);
    assert.equal(lease.unavailable?.[0]?.packageId, "fixture-echo");
    assert.equal(lease.unavailable?.[0]?.code, code);
    lease.release();
  };
  await stores.projectPackages.update((state) => ({ ...state, profiles: { ...state.profiles, [PROFILE_A]: { ...state.profiles[PROFILE_A]!, status: "unverified" } } }));
  expectCode("PROFILE_NOT_VERIFIED");
  await stores.projectPackages.update((state) => ({ ...state, profiles: { ...state.profiles, [PROFILE_A]: { ...state.profiles[PROFILE_A]!, status: "verified", type: "wrong-type" } } }));
  expectCode("PROFILE_TYPE_MISMATCH");
  await stores.projectPackages.update((state) => ({ ...state, profiles: { ...state.profiles, [PROFILE_A]: { ...state.profiles[PROFILE_A]!, type: "example-token", values: {} } } }));
  expectCode("PROFILE_FIELDS_MISSING");
  await stores.projectPackages.update((state) => ({ ...state, profiles: { ...state.profiles, [PROFILE_A]: { ...state.profiles[PROFILE_A]!, values: { token: "" } } } }));
  expectCode("PROFILE_FIELDS_MISSING");
  await stores.projectPackages.update((state) => ({ ...state, profiles: { ...state.profiles, [PROFILE_A]: profile(PROFILE_A, "alpha", 10) } }));
  await stores.installed.update("fixture-echo", (record) => ({ ...record, state: "error" }));
  expectCode("PACKAGE_NOT_READY");
  await stores.installed.update("fixture-echo", (record) => ({ ...record, state: "ready", sourceDigest: "c".repeat(64) }));
  expectCode("PACKAGE_NOT_READY");
  await runtime.close();
});

test("a broken assigned package does not hide healthy assigned packages", async () => {
  const { stores, runtime } = await fixture();
  await installPackage(stores, "broken-package", true);
  await stores.installed.update("broken-package", (record) => ({ ...record, state: "installing", activeOperationId: randomUUID() }));
  await stores.projectPackages.update((state) => ({
    ...state,
    assignments: [
      ...state.assignments,
      { projectId: PROJECT_A, packageId: "broken-package", profileId: null },
    ],
  }));

  const lease = runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "degraded", turnId: "turn" });
  assert.deepEqual(lease.bindings.map((entry) => entry.packageId), ["fixture-echo"]);
  assert.deepEqual(lease.unavailable, [{
    packageId: "broken-package",
    code: "PACKAGE_NOT_READY",
    message: "Assigned Armory package is not ready: broken-package",
  }]);
  lease.release();
  await runtime.close();
});

test("artifact reconciliation drains only after in-flight turn leases release and restart starts nothing globally", async () => {
  const { stores, runtime, connections, closes } = await fixture();
  const lease = runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "running", turnId: "turn" });
  await runtime.listTools(binding(lease), "running");
  assert.equal(connections.length, 1);
  let stopped = false;
  const stopping = runtime.stop("fixture-echo").then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal(stopped, false);
    assert.equal(closes(), 0);
    assert.equal(runtime.drainStatus("fixture-echo").state, "draining");
    const refused = runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "during-drain", turnId: "turn" });
    assert.equal(refused.bindings.length, 0);
    assert.equal(refused.unavailable?.at(-1)?.code, "MCP_DRAINING");
  } finally {
    lease.release();
  }
  await stopping;
  assert.equal(closes(), 1);
  assert.equal(runtime.drainStatus("fixture-echo").state, "accepting");
  await runtime.close();

  const restarted = new ArmoryMcpRuntime(stores, new McpBindingRegistry());
  let starts = 0;
  (restarted as unknown as { connectPackage(): Promise<never> }).connectPackage = async () => { starts += 1; throw new Error("unexpected startup"); };
  await restarted.reconcile();
  assert.equal(starts, 0);
  const next = restarted.snapshotTurn({ projectId: PROJECT_A, sessionId: "after-restart", turnId: "turn" });
  assert.equal(next.bindings.length, 1);
  next.release();
  await restarted.close();
});

test("package drain times out with actionable lease diagnostics instead of stalling an update forever", async () => {
  const { stores, registry } = await fixture();
  const runtime = new ArmoryMcpRuntime(stores, registry, { drainTimeoutMs: 10 });
  (runtime as unknown as { connectPackage(selection: Record<string, unknown>): Promise<unknown> }).connectPackage = async (selection) => ({
    client: { close: async () => undefined },
    transport: { close: async () => undefined, onclose: undefined },
    selection,
    tools: [],
  });
  const lease = runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "blocking-session", turnId: "turn" });
  await runtime.listTools(binding(lease), "blocking-session");

  await assert.rejects(runtime.stop("fixture-echo"), (error: unknown) => {
    assert.ok(error instanceof ArmoryOperationError);
    assert.equal(error.code, "MCP_DRAIN_TIMEOUT");
    assert.match(error.message, /1 active turn lease/);
    assert.match(error.message, /Finish or cancel sessions/);
    assert.deepEqual(error.details, { packageId: "fixture-echo", activeLeases: 1, runtimes: 1, timeoutMs: 10 });
    return true;
  });

  lease.release();
  await runtime.close();
});

test("package usage exposes only bounded aggregate MCP counters", async () => {
  const { runtime } = await fixture();
  const lease = runtime.snapshotTurn({ projectId: PROJECT_A, sessionId: "usage-session", turnId: "turn" });
  await runtime.callTool(binding(lease), "usage-session", "identity", {});
  const usage = runtime.usage("fixture-echo");
  assert.equal(usage.calls, 1);
  assert.equal(usage.failures, 0);
  assert.equal(usage.timeouts, 0);
  assert.equal(usage.activeTurnLeases, 1);
  assert.equal(usage.runningRuntimes, 1);
  assert.ok(usage.totalDurationMs >= 0);
  assert.ok((usage.lastUsedAt ?? 0) > 0);
  lease.release();
  await runtime.close();
});
