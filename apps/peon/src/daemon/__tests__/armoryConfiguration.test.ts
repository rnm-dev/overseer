import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  armoryActivationSchema,
  ArmoryConfigurationService,
  ArmoryHookError,
  ArmoryHookRunner,
  AtomicJsonStore,
  createArmoryRedactor,
  createArmoryStores,
  initializeArmoryDirectories,
  packageActivationPath,
  packageVersionPath,
  type ArmoryManifest,
  type ArmoryStores,
} from "../armory/index.js";
import { ARMORY_COMMAND_PATH } from "../armory/runtimeEnvironment.js";

async function activeFixture(overrides: Partial<ArmoryManifest> = {}): Promise<{ root: string; stores: ArmoryStores; packageDir: string; home: string; manifest: ArmoryManifest }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "peon-armory-config-"));
  const stores = createArmoryStores({ data: path.join(root, "data"), state: path.join(root, "state"), config: path.join(root, "config") });
  await initializeArmoryDirectories(stores.paths);
  const packageDir = packageVersionPath(stores.paths, "configured", "1.0.0");
  const home = path.join(stores.paths.homesDir, "configured");
  await mkdir(packageDir, { recursive: true });
  const manifest: ArmoryManifest = {
    schemaVersion: 1, id: "configured", version: "1.0.0", minPeonVersion: "0.0.1",
    platforms: [{ os: "darwin", arch: "arm64" }], permissions: { networkHosts: [], hostPaths: [] }, dependencies: [],
    configuration: {
      fields: [
        { id: "name", label: "Name", type: "text", required: true, validation: { pattern: "^[a-z]+$", maxLength: 20 } },
        { id: "token", label: "Token", type: "secret", required: true },
        { id: "region", label: "Region", type: "select", required: true, options: [{ value: "east", label: "East" }] },
        { id: "file", label: "File", type: "file", required: true, validation: { maxLength: 100 } },
      ],
      handler: { executable: "node", args: ["configure.mjs"] }, verifyHandler: { executable: "node", args: ["verify.mjs"] },
      managedPaths: ["config.json"], environment: { FIXTURE_FILE: "config.json" },
    },
    mcp: { command: { executable: "node", args: ["mcp.mjs"] }, toolPrefix: "configured" },
    ...overrides,
  };
  await writeFile(path.join(packageDir, "armory.package.json"), JSON.stringify(manifest));
  await writeFile(path.join(packageDir, "mcp.mjs"), "");
  const installed = {
    id: "configured", version: "1.0.0", enabled: true, state: "needs_configuration" as const,
    installedAt: 1, updatedAt: 1, sourceDigest: "a".repeat(64), configurationStatus: "missing" as const,
    lastError: null, activeOperationId: null,
  };
  await stores.installed.set(installed);
  const activation = { schemaVersion: 1 as const, id: "configured", version: "1.0.0", previousVersion: null, activatedAt: 1, sourceDigest: "a".repeat(64), operationId: randomUUID(), installed };
  await new AtomicJsonStore({ filePath: packageActivationPath(stores.paths, "configured"), schema: armoryActivationSchema, defaults: () => activation }).write(activation);
  return { root, stores, packageDir, home, manifest };
}

const values = { name: "demo", token: "super-secret", region: "east", file: "file-secret" };

test("configuration runs bounded hooks, stores only metadata ordinarily, records ownership, and restarts runtime", async () => {
  const fixture = await activeFixture();
  await writeFile(path.join(fixture.packageDir, "configure.mjs"), `
    import fs from "node:fs/promises";
    const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks).toString());
    await fs.mkdir(input.package.home,{recursive:true});
    await fs.writeFile(process.env.FIXTURE_FILE, JSON.stringify({name:input.configuration.name,token:input.configuration.token}));
    process.stderr.write("stderr:"+input.configuration.token);
    process.stdout.write(JSON.stringify({protocolVersion:1,type:"progress",phase:"writing",message:"using "+input.configuration.token,percent:50})+"\\n");
    process.stdout.write(JSON.stringify({protocolVersion:1,type:"result",ok:true,message:"saved "+input.configuration.token,ownedPaths:["config.json"]})+"\\n");
  `);
  await writeFile(path.join(fixture.packageDir, "verify.mjs"), `
    for await (const _ of process.stdin) {}
    process.stdout.write(JSON.stringify({protocolVersion:1,type:"result",ok:true,message:"verified"})+"\\n");
  `);
  const runtimeCalls: string[] = [];
  const service = new ArmoryConfigurationService({
    stores: fixture.stores,
    platform: { os: "darwin", arch: "arm64" },
    runtime: { stop: async () => { runtimeCalls.push("stop"); }, healthCheck: async () => { runtimeCalls.push("health"); }, start: async () => { runtimeCalls.push("start"); } },
  });
  const operation = await service.configure("configured", values);
  assert.equal(operation.kind, "configure");
  const completed = await service.operations.wait(operation.id);
  assert.equal(completed.status, "success");
  assert.deepEqual(runtimeCalls, ["stop", "health", "start"]);
  assert.equal((await fixture.stores.installed.get("configured"))?.configurationStatus, "verified");
  assert.deepEqual((await service.schema("configured")).configured, { name: true, token: true, region: true, file: true });
  assert.equal((await readFile(path.join(fixture.home, "config.json"), "utf8")).includes(values.token), true);
  assert.equal((await fixture.stores.ownership.list("configured"))[0]?.root, "managed_home");
  const ordinary = `${await readFile(fixture.stores.paths.installedFile, "utf8")} ${await readFile(path.join(fixture.stores.paths.operationsDir, `${operation.id}.json`), "utf8")}`;
  assert.equal(ordinary.includes(values.token), false);
  assert.equal(ordinary.includes(values.file), false);

  const deletion = await service.deleteConfiguration("configured");
  assert.equal(deletion.kind, "delete_configuration");
  assert.equal((await service.operations.wait(deletion.id)).status, "success");
  await assert.rejects(stat(path.join(fixture.home, "config.json")), { code: "ENOENT" });
  assert.deepEqual((await service.schema("configured")).configured, {});
});

test("configuration validation and host-write safeguards fail before a hook starts", async () => {
  const hostHome = await mkdtemp(path.join(os.tmpdir(), "peon-armory-host-"));
  const hostFile = path.join(hostHome, "existing.json");
  await writeFile(hostFile, "operator-owned");
  const fixture = await activeFixture({ permissions: { networkHosts: [], hostPaths: [{ path: hostFile, mode: "write", purpose: "test" }] } });
  await writeFile(path.join(fixture.packageDir, "configure.mjs"), "throw new Error('must not run')");
  await writeFile(path.join(fixture.packageDir, "verify.mjs"), "");
  const service = new ArmoryConfigurationService({ stores: fixture.stores, platform: { os: "darwin", arch: "arm64" }, hostHome });
  const unknown = await service.configure("configured", { ...values, extra: "x" });
  assert.equal((await service.operations.wait(unknown.id)).errorCode, "CONFIGURATION_FIELD_UNKNOWN");
  const invalid = await service.configure("configured", { ...values, region: "west" });
  assert.equal((await service.operations.wait(invalid.id)).errorCode, "CONFIGURATION_FIELD_INVALID");
  const unconfirmed = await service.configure("configured", values);
  assert.equal((await service.operations.wait(unconfirmed.id)).errorCode, "HOST_WRITE_CONFIRMATION_REQUIRED");
  const preexisting = await service.configure("configured", values, { confirmHostWrites: true });
  assert.equal((await service.operations.wait(preexisting.id)).errorCode, "HOST_PATH_PREEXISTS");
  assert.equal(await readFile(hostFile, "utf8"), "operator-owned");
});

test("configuration rejects escaping or undeclared hook-owned paths", async () => {
  const fixture = await activeFixture();
  await writeFile(path.join(fixture.packageDir, "configure.mjs"), `
    for await (const _ of process.stdin) {}
    process.stdout.write(JSON.stringify({protocolVersion:1,type:"result",ok:true,message:"done",ownedPaths:["../escape"]})+"\\n");
  `);
  await writeFile(path.join(fixture.packageDir, "verify.mjs"), "");
  const service = new ArmoryConfigurationService({ stores: fixture.stores, platform: { os: "darwin", arch: "arm64" } });
  const operation = await service.configure("configured", values);
  assert.equal((await service.operations.wait(operation.id)).errorCode, "OWNED_PATH_UNDECLARED");
});

test("configuration deletion refuses tampered ownership paths", async () => {
  const fixture = await activeFixture();
  const outside = path.join(fixture.root, "operator-file");
  await writeFile(outside, "keep");
  await fixture.stores.ownership.replace("configured", [{ path: outside, root: "managed_home", createdAt: 1 }]);
  const service = new ArmoryConfigurationService({ stores: fixture.stores, platform: { os: "darwin", arch: "arm64" } });
  const operation = await service.deleteConfiguration("configured");
  assert.equal((await service.operations.wait(operation.id)).errorCode, "OWNERSHIP_PATH_INVALID");
  assert.equal(await readFile(outside, "utf8"), "keep");
});

test("hook runner rejects malformed, duplicate, missing-result, nonzero, and timeout behavior", async () => {
  const fixture = await activeFixture();
  const runner = new ArmoryHookRunner();
  const input = { protocolVersion: 1 as const, type: "input" as const, operation: "verify" as const, package: { id: "configured", version: "1.0.0", dir: fixture.packageDir, home: fixture.home }, platform: { os: "darwin" as const, arch: "arm64" as const } };
  const cases = [
    ["malformed.mjs", `process.stdout.write("not-json\\n")`, "HOOK_PROTOCOL_INVALID"],
    ["duplicate.mjs", `const r=JSON.stringify({protocolVersion:1,type:"result",ok:true,message:"ok"})+"\\n";process.stdout.write(r+r)`, "HOOK_DUPLICATE_RESULT"],
    ["missing.mjs", `process.stdout.write(JSON.stringify({protocolVersion:1,type:"progress",phase:"x",message:"x",percent:null})+"\\n")`, "HOOK_RESULT_MISSING"],
    ["nonzero.mjs", `process.stderr.write("super-secret");process.exit(2)`, "HOOK_EXIT_NONZERO"],
    ["timeout.mjs", `setInterval(()=>{},1000)`, "HOOK_TIMEOUT"],
  ] as const;
  for (const [name, source, code] of cases) {
    await writeFile(path.join(fixture.packageDir, name), source);
    await assert.rejects(runner.run({ command: { executable: "node", args: [name] }, input, packageDir: fixture.packageDir, managedHome: fixture.home, sensitiveValues: ["super-secret"], timeoutMs: name === "timeout.mjs" ? 10 : 1000 }), (error: unknown) => error instanceof ArmoryHookError && error.code === code && !error.message.includes("super-secret") && !error.stderr.includes("super-secret"), name);
  }
});

test("hook runner redacts secrets assembled across child-output fragments and enforces output size", async () => {
  const fixture = await activeFixture();
  const runner = new ArmoryHookRunner();
  const input = { protocolVersion: 1 as const, type: "input" as const, operation: "verify" as const, package: { id: "configured", version: "1.0.0", dir: fixture.packageDir, home: fixture.home }, platform: { os: "darwin" as const, arch: "arm64" as const } };
  await writeFile(path.join(fixture.packageDir, "fragmented.mjs"), `
    for await (const _ of process.stdin) {}
    process.stderr.write("secret-"); process.stderr.write("value");
    const line=JSON.stringify({protocolVersion:1,type:"result",ok:true,message:"secret-value"})+"\\n";
    process.stdout.write(line.slice(0,20)); setTimeout(()=>process.stdout.write(line.slice(20)),5);
  `);
  const result = await runner.run({ command: { executable: "node", args: ["fragmented.mjs"] }, input, packageDir: fixture.packageDir, managedHome: fixture.home, sensitiveValues: ["secret-value"] });
  assert.equal(result.message, "[REDACTED]");
  assert.equal(result.stderr, "[REDACTED]");
  await writeFile(path.join(fixture.packageDir, "large.mjs"), `process.stdout.write("x".repeat(1000))`);
  await assert.rejects(runner.run({ command: { executable: "node", args: ["large.mjs"] }, input, packageDir: fixture.packageDir, managedHome: fixture.home, maxOutputBytes: 20 }), (error: unknown) => error instanceof ArmoryHookError && error.code === "HOOK_OUTPUT_LIMIT");
});

test("hook runner uses the deterministic Armory command PATH", async () => {
  const fixture = await activeFixture();
  const runner = new ArmoryHookRunner();
  const input = { protocolVersion: 1 as const, type: "input" as const, operation: "verify" as const, package: { id: "configured", version: "1.0.0", dir: fixture.packageDir, home: fixture.home }, platform: { os: "darwin" as const, arch: "arm64" as const } };
  await writeFile(path.join(fixture.packageDir, "environment.mjs"), `
    for await (const _ of process.stdin) {}
    process.stdout.write(JSON.stringify({
      protocolVersion: 1,
      type: "result",
      ok: true,
      message: process.env.PATH + "|" + (process.env.PEON_ARMORY_TEST_INHERITED ?? "missing"),
    }) + "\\n");
  `);
  const previous = process.env.PEON_ARMORY_TEST_INHERITED;
  process.env.PEON_ARMORY_TEST_INHERITED = "operator-only";
  try {
    const result = await runner.run({
      command: { executable: "node", args: ["environment.mjs"] },
      input,
      packageDir: fixture.packageDir,
      managedHome: fixture.home,
    });
    assert.equal(result.message, `${ARMORY_COMMAND_PATH}|missing`);
  } finally {
    if (previous === undefined) delete process.env.PEON_ARMORY_TEST_INHERITED;
    else process.env.PEON_ARMORY_TEST_INHERITED = previous;
  }
});

test("redaction recursively removes secrets from nested values and fragments", () => {
  const redactor = createArmoryRedactor(["secret-value", "value"]);
  const output = redactor.value({ nested: [{ text: "prefix secret-value suffix" }], error: "value" });
  assert.deepEqual(output, { nested: [{ text: "prefix [REDACTED] suffix" }], error: "[REDACTED]" });
});
