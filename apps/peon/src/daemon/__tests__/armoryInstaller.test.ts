import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Header } from "tar";
import {
  ArmoryInstaller,
  ArmoryOperationError,
  ArmoryPackageInstallService,
  createArmoryStores,
  downloadArchive,
  getArmoryActivation,
  inspectArchive,
  packageActivationPath,
  packageVersionPath,
  recoverInterruptedArmoryOperations,
  resolveContainedPath,
  type ArchiveSelection,
  type ArmoryStores,
} from "../armory/index.js";
import type { ArmoryInventoryReader } from "../armory/inventory.js";

interface TarEntry { path: string; type?: "File" | "Directory" | "SymbolicLink" | "Link" | "FIFO"; body?: string | Buffer; linkpath?: string }

async function fixture(): Promise<{ root: string; stores: ArmoryStores }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "peon-armory-installer-"));
  return {
    root,
    stores: createArmoryStores({ data: path.join(root, "data"), state: path.join(root, "state"), config: path.join(root, "config") }),
  };
}
function manifest(id: string, version: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    version,
    minPeonVersion: "0.0.1",
    platforms: [{ os: "darwin", arch: "arm64" }],
    permissions: { networkHosts: [], hostPaths: [] },
    dependencies: [],
    mcp: { command: { executable: "bin/server", args: [] }, toolPrefix: id.replaceAll("-", "_") },
  };
}

function packageArchive(id: string, version: string, overrideManifest?: Record<string, unknown>): Buffer {
  const root = `${id}-${version}`;
  return tarBuffer([
    { path: `${root}/`, type: "Directory" },
    { path: `${root}/armory.package.json`, body: JSON.stringify(overrideManifest ?? manifest(id, version)) },
    { path: `${root}/bin/`, type: "Directory" },
    { path: `${root}/bin/server`, body: "#!/usr/bin/env node\n" },
  ]);
}

function selection(id: string, version: string, archive: Buffer, digest = createHash("sha256").update(archive).digest("hex")): ArchiveSelection {
  return {
    packageId: id,
    version,
    minPeonVersion: "0.0.1",
    platforms: [{ os: "darwin", arch: "arm64" }],
    archive: {
      url: `https://github.com/rnm-dev/armory/releases/download/${id}-v${version}/${id}-${version}.tar.gz`,
      size: archive.byteLength,
      sha256: digest,
    },
  };
}

function responseFor(archive: Buffer): typeof fetch {
  return (async () => new Response(archive, { status: 200, headers: { "content-length": String(archive.byteLength) } })) as typeof fetch;
}

test("installs verified versions side by side and atomically advances activation", async () => {
  const { stores } = await fixture();
  const v1 = packageArchive("demo", "1.0.0");
  const installer1 = new ArmoryInstaller({ stores, fetchImpl: responseFor(v1) });
  const first = await installer1.install(selection("demo", "1.0.0", v1));
  assert.equal((await installer1.operations.wait(first.id)).status, "success");
  const firstActivation = (await getArmoryActivation(stores, "demo"))!;
  assert.equal(firstActivation.schemaVersion, 1);
  assert.equal(firstActivation.id, "demo");
  assert.equal(firstActivation.version, "1.0.0");
  assert.equal(firstActivation.previousVersion, null);
  assert.equal(firstActivation.operationId, first.id);
  assert.equal(firstActivation.sourceDigest, createHash("sha256").update(v1).digest("hex"));
  assert.equal(firstActivation.installed.activeOperationId, null);
  assert.equal(firstActivation.installed.version, "1.0.0");
  assert.equal((await stat(packageVersionPath(stores.paths, "demo", "1.0.0"))).isDirectory(), true);
  assert.deepEqual(await readdir(stores.paths.stagingDir), []);

  const v2 = packageArchive("demo", "2.0.0");
  const installer2 = new ArmoryInstaller({ stores, fetchImpl: responseFor(v2) });
  const second = await installer2.install(selection("demo", "2.0.0", v2), "update");
  assert.equal((await installer2.operations.wait(second.id)).status, "success");
  const active = await getArmoryActivation(stores, "demo");
  assert.equal(active?.version, "2.0.0");
  assert.equal(active?.previousVersion, "1.0.0");
  assert.equal((await stat(packageVersionPath(stores.paths, "demo", "1.0.0"))).isDirectory(), true);
  assert.equal((await stat(packageVersionPath(stores.paths, "demo", "2.0.0"))).isDirectory(), true);
  assert.equal((await stores.installed.get("demo"))?.activeOperationId, null);
});

test("installs after profile migration create no activation state or implicit assignment", async () => {
  const { stores } = await fixture();
  await stores.projectPackages.write({
    schemaVersion: 1,
    migrationCompletedAt: 1,
    profiles: {},
    assignments: [],
    legacyProfileByPackage: {},
  });
  const archive = packageArchive("demo", "1.0.0");
  const installer = new ArmoryInstaller({ stores, fetchImpl: responseFor(archive) });
  const operation = await installer.install(selection("demo", "1.0.0", archive));
  assert.equal((await installer.operations.wait(operation.id)).status, "success");
  const installed = (await stores.installed.get("demo"))!;
  assert.equal("enabled" in installed, false);
  assert.equal("configurationStatus" in installed, false);
  const activation = (await getArmoryActivation(stores, "demo"))!;
  assert.equal("enabled" in activation.installed, false);
  assert.equal("configurationStatus" in activation.installed, false);
  assert.deepEqual((await stores.projectPackages.read()).assignments, []);
});

test("updates drain the previous artifact without restoring package-wide activation", async () => {
  const { stores } = await fixture();
  const v1 = packageArchive("demo", "1.0.0");
  const initial = new ArmoryInstaller({ stores, fetchImpl: responseFor(v1) });
  const installed = await initial.install(selection("demo", "1.0.0", v1));
  assert.equal((await initial.operations.wait(installed.id)).status, "success");
  await stores.projectPackages.write({ schemaVersion: 1, migrationCompletedAt: 1, profiles: {}, assignments: [], legacyProfileByPackage: {} });

  const calls: string[] = [];
  const runtime = {
    stop: async (id: string) => { calls.push(`stop:${id}`); },
    healthCheck: async (id: string) => { calls.push(`health:${id}`); },
    start: async (id: string) => { calls.push(`start:${id}`); },
  };
  const v2 = packageArchive("demo", "2.0.0");
  const updater = new ArmoryInstaller({ stores, runtime, fetchImpl: responseFor(v2) });
  const update = await updater.install(selection("demo", "2.0.0", v2), "update");
  assert.equal((await updater.operations.wait(update.id)).status, "success");
  assert.deepEqual(calls, ["stop:demo"]);
  assert.equal((await stores.installed.get("demo"))?.version, "2.0.0");
  assert.equal("enabled" in (await stores.installed.get("demo"))!, false);
});

test("install service resolves an operator-requested catalog version and rejects reinstall", async () => {
  const { stores } = await fixture();
  const archive = packageArchive("demo", "1.0.0");
  const catalog = {
    id: "demo",
    displayName: "Demo",
    iconUrl: "https://raw.githubusercontent.com/rnm-dev/armory/main/packages/demo/assets/icon.png",
    summary: "Demo package",
    publisher: "rnm-dev" as const,
    documentationUrl: "https://github.com/rnm-dev/armory/tree/main/packages/demo",
    latest: "1.0.0",
    requirements: { credentials: false, hostWrites: false },
    versions: [selection("demo", "1.0.0", archive)].map(({ packageId: _packageId, ...version }) => version),
  };
  const inventory: ArmoryInventoryReader = {
    list: async () => { throw new Error("not used"); },
    get: async () => ({
      registry: { url: "https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json", official: true, source: "live", fetchedAt: 1, catalogUpdatedAt: "2026-07-15T00:00:00.000Z", error: null },
      package: { id: "demo", available: true, displayName: "Demo", iconUrl: catalog.iconUrl, summary: "Demo package", publisher: "rnm-dev", documentationUrl: catalog.documentationUrl, latestVersion: "1.0.0", requirements: catalog.requirements, installed: null, updateAvailable: null },
      catalog,
    }),
  };
  const installer = new ArmoryInstaller({ stores, fetchImpl: responseFor(archive) });
  const service = new ArmoryPackageInstallService({ stores, inventory, installer, peonVersion: "0.0.1", platform: { os: "darwin", arch: "arm64" } });

  const operation = await service.install("demo", { version: "1.0.0" });
  assert.equal((await installer.operations.wait(operation.id)).status, "success");
  assert.equal((await stores.installed.get("demo"))?.version, "1.0.0");
  await assert.rejects(
    service.install("demo"),
    (error: unknown) => error instanceof ArmoryOperationError && error.code === "PACKAGE_ALREADY_INSTALLED",
  );
});

test("digest failure cleans staging and preserves the previously active version", async () => {
  const { stores } = await fixture();
  const v1 = packageArchive("demo", "1.0.0");
  const initial = new ArmoryInstaller({ stores, fetchImpl: responseFor(v1) });
  const installed = await initial.install(selection("demo", "1.0.0", v1));
  assert.equal((await initial.operations.wait(installed.id)).status, "success");

  const v2 = packageArchive("demo", "2.0.0");
  const update = new ArmoryInstaller({ stores, fetchImpl: responseFor(v2) });
  const failed = await update.install(selection("demo", "2.0.0", v2, "0".repeat(64)), "update");
  const result = await update.operations.wait(failed.id);
  assert.equal(result.status, "failure");
  assert.equal(result.errorCode, "ARCHIVE_DIGEST_MISMATCH");
  assert.equal((await getArmoryActivation(stores, "demo"))?.version, "1.0.0");
  assert.equal((await stores.installed.get("demo"))?.version, "1.0.0");
  await assert.rejects(stat(packageVersionPath(stores.paths, "demo", "2.0.0")), { code: "ENOENT" });
  assert.deepEqual(await readdir(stores.paths.stagingDir), []);
});

test("package operation lock rejects a second mutating operation", async () => {
  const { stores } = await fixture();
  const archive = packageArchive("demo", "1.0.0");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delayedFetch = (async () => {
    await gate;
    return new Response(archive, { status: 200, headers: { "content-length": String(archive.byteLength) } });
  }) as typeof fetch;
  const installer = new ArmoryInstaller({ stores, fetchImpl: delayedFetch });
  const first = await installer.install(selection("demo", "1.0.0", archive));
  await assert.rejects(
    installer.install(selection("demo", "1.0.0", archive)),
    (error: unknown) => {
      assert.ok(error instanceof ArmoryOperationError);
      assert.equal(error.code, "OPERATION_IN_PROGRESS");
      assert.match(error.message, /blocked by install operation [0-9a-f-]+/);
      assert.match(error.message, /phase/);
      assert.match(error.message, /restart the Peon to recover/);
      assert.equal(typeof error.details?.blockingOperationId, "string");
      assert.equal(error.details?.packageId, "demo");
      return true;
    },
  );
  release();
  assert.equal((await installer.operations.wait(first.id)).status, "success");
});

test("download enforces time, byte, and redirect-host limits", async () => {
  const { root } = await fixture();
  const archive = packageArchive("demo", "1.0.0");
  const chosen = selection("demo", "1.0.0", archive);
  await assert.rejects(
    downloadArchive({
      selection: { ...chosen, archive: { ...chosen.archive, size: archive.byteLength - 1 } },
      destination: path.join(root, "oversized.tar.gz"),
      fetchImpl: responseFor(archive),
    }),
    (error: unknown) => error instanceof ArmoryOperationError && error.code === "ARCHIVE_TOO_LARGE",
  );

  const hangingFetch = ((_: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  await assert.rejects(
    downloadArchive({ selection: chosen, destination: path.join(root, "timeout.tar.gz"), fetchImpl: hangingFetch, timeoutMs: 5 }),
    (error: unknown) => error instanceof ArmoryOperationError && error.code === "DOWNLOAD_TIMEOUT",
  );

  const redirectingFetch = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/archive.tar.gz" } })) as typeof fetch;
  await assert.rejects(
    downloadArchive({ selection: chosen, destination: path.join(root, "redirect.tar.gz"), fetchImpl: redirectingFetch }),
    (error: unknown) => error instanceof ArmoryOperationError && error.code === "DOWNLOAD_POLICY_DENIED",
  );
});

test("archive inspection rejects traversal, escaping links, special files, duplicates, and limits", async () => {
  const { root } = await fixture();
  const cases: Array<{ name: string; entries: TarEntry[]; code: string; options?: { maxFiles?: number; maxExpandedBytes?: number } }> = [
    { name: "traversal", entries: [{ path: "demo-1.0.0/../evil", body: "x" }], code: "ARCHIVE_PATH_INVALID" },
    { name: "link", entries: [{ path: "demo-1.0.0/link", type: "SymbolicLink", linkpath: "../../evil" }], code: "ARCHIVE_LINK_ESCAPE" },
    { name: "special", entries: [{ path: "demo-1.0.0/pipe", type: "FIFO" }], code: "ARCHIVE_SPECIAL_FILE" },
    { name: "duplicate", entries: [{ path: "demo-1.0.0/file", body: "a" }, { path: "demo-1.0.0/file", body: "b" }], code: "ARCHIVE_DUPLICATE_PATH" },
    { name: "count", entries: [{ path: "demo-1.0.0/a", body: "a" }, { path: "demo-1.0.0/b", body: "b" }], code: "ARCHIVE_TOO_MANY_FILES", options: { maxFiles: 1 } },
    { name: "expanded", entries: [{ path: "demo-1.0.0/file", body: "large" }], code: "ARCHIVE_EXPANDED_TOO_LARGE", options: { maxExpandedBytes: 2 } },
  ];
  for (const entry of cases) {
    const file = path.join(root, `${entry.name}.tar.gz`);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, tarBuffer(entry.entries)));
    await assert.rejects(
      inspectArchive({ archiveFile: file, expectedRoot: "demo-1.0.0", ...entry.options }),
      (error: unknown) => error instanceof ArmoryOperationError && error.code === entry.code,
      entry.name,
    );
  }
});

test("manifest identity mismatch fails before activation", async () => {
  const { stores } = await fixture();
  const archive = packageArchive("demo", "1.0.0", manifest("other", "1.0.0"));
  const installer = new ArmoryInstaller({ stores, fetchImpl: responseFor(archive) });
  const operation = await installer.install(selection("demo", "1.0.0", archive));
  const result = await installer.operations.wait(operation.id);
  assert.equal(result.status, "failure");
  assert.equal(result.errorCode, "MANIFEST_IDENTITY_MISMATCH");
  assert.equal(await getArmoryActivation(stores, "demo"), null);
});

test("invalid manifest command paths fail before activation", async () => {
  const { stores } = await fixture();
  const invalid = manifest("demo", "1.0.0");
  (invalid.mcp as { command: { executable: string } }).command.executable = "bin/missing";
  const archive = packageArchive("demo", "1.0.0", invalid);
  const installer = new ArmoryInstaller({ stores, fetchImpl: responseFor(archive) });
  const operation = await installer.install(selection("demo", "1.0.0", archive));
  const result = await installer.operations.wait(operation.id);
  assert.equal(result.status, "failure");
  assert.equal(result.errorCode, "COMMAND_EXECUTABLE_INVALID");
  assert.equal(await getArmoryActivation(stores, "demo"), null);
});

test("restart recovery marks interrupted operations failed, removes staging, and preserves activation", async () => {
  const { stores } = await fixture();
  const archive = packageArchive("demo", "1.0.0");
  const installer = new ArmoryInstaller({ stores, fetchImpl: responseFor(archive) });
  const first = await installer.install(selection("demo", "1.0.0", archive));
  assert.equal((await installer.operations.wait(first.id)).status, "success");
  const interruptedId = randomUUID();
  await stores.operations.save({
    id: interruptedId, packageId: "demo", kind: "update", status: "running", phase: "extracting", progress: 50,
    message: "Extracting", errorCode: null, startedAt: 1, finishedAt: null,
  });
  const installed = (await stores.installed.get("demo"))!;
  await stores.installed.set({ ...installed, activeOperationId: interruptedId });
  const staged = resolveContainedPath(stores.paths.stagingDir, interruptedId);
  await mkdir(staged, { recursive: true });
  await writeFile(path.join(staged, "install-transaction.json"), `${JSON.stringify({
    schemaVersion: 1,
    operationId: interruptedId,
    packageId: "demo",
    version: "2.0.0",
  })}\n`);
  const interruptedDestination = packageVersionPath(stores.paths, "demo", "2.0.0");
  await mkdir(interruptedDestination, { recursive: true });
  await writeFile(path.join(interruptedDestination, "partial"), "partial");

  assert.equal(await recoverInterruptedArmoryOperations(stores, 1234), 1);
  assert.equal((await stores.operations.get(interruptedId))?.errorCode, "INTERRUPTED_OPERATION");
  assert.equal((await stores.installed.get("demo"))?.version, "1.0.0");
  assert.equal((await stores.installed.get("demo"))?.activeOperationId, null);
  await assert.rejects(stat(staged), { code: "ENOENT" });
  await assert.rejects(stat(interruptedDestination), { code: "ENOENT" });
});

test("restart recovery rolls back an update that crashed after activation but before runtime readiness", async () => {
  const { stores } = await fixture();
  const v1 = packageArchive("demo", "1.0.0");
  const initial = new ArmoryInstaller({ stores, fetchImpl: responseFor(v1) });
  const first = await initial.install(selection("demo", "1.0.0", v1));
  assert.equal((await initial.operations.wait(first.id)).status, "success");
  await stores.installed.update("demo", (record) => ({ ...record, enabled: true }));
  const previousInstalled = (await stores.installed.get("demo"))!;
  const previousActivation = (await getArmoryActivation(stores, "demo"))!;
  const operationId = randomUUID();
  const v2 = packageArchive("demo", "2.0.0");
  const chosen = selection("demo", "2.0.0", v2);
  const nextInstalled = { ...previousInstalled, version: "2.0.0", enabled: false, sourceDigest: chosen.archive.sha256, activeOperationId: operationId };
  await stores.installed.set(nextInstalled);
  await stores.operations.save({ id: operationId, packageId: "demo", kind: "update", status: "running", phase: "health_check", progress: 94, message: "Checking", errorCode: null, startedAt: 1, finishedAt: null });
  await writeFile(packageActivationPath(stores.paths, "demo"), `${JSON.stringify({ schemaVersion: 1, id: "demo", version: "2.0.0", previousVersion: "1.0.0", activatedAt: 2, sourceDigest: chosen.archive.sha256, operationId, installed: { ...nextInstalled, activeOperationId: null } })}\n`);
  const destination = packageVersionPath(stores.paths, "demo", "2.0.0");
  await mkdir(destination, { recursive: true });
  const staged = resolveContainedPath(stores.paths.stagingDir, operationId);
  await mkdir(staged, { recursive: true });
  await writeFile(path.join(staged, "install-transaction.json"), `${JSON.stringify({ schemaVersion: 1, operationId, packageId: "demo", version: "2.0.0", kind: "update", phase: "activation_committed", previousActivation, previousInstalled })}\n`);

  assert.equal(await recoverInterruptedArmoryOperations(stores, 5000), 1);
  assert.equal((await stores.operations.get(operationId))?.errorCode, "INTERRUPTED_OPERATION");
  assert.equal((await getArmoryActivation(stores, "demo"))?.version, "1.0.0");
  assert.equal((await stores.installed.get("demo"))?.version, "1.0.0");
  assert.equal((await stores.installed.get("demo"))?.enabled, true);
  await assert.rejects(stat(destination), { code: "ENOENT" });
});

test("restart recovery preserves the previous enabled state when an update crashes during download", async () => {
  const { stores } = await fixture();
  const v1 = packageArchive("demo", "1.0.0");
  const initial = new ArmoryInstaller({ stores, fetchImpl: responseFor(v1) });
  const first = await initial.install(selection("demo", "1.0.0", v1));
  assert.equal((await initial.operations.wait(first.id)).status, "success");
  await stores.installed.update("demo", (record) => ({ ...record, enabled: true }));
  const previousInstalled = (await stores.installed.get("demo"))!;
  const previousActivation = (await getArmoryActivation(stores, "demo"))!;
  const operationId = randomUUID();
  await stores.installed.set({ ...previousInstalled, activeOperationId: operationId });
  await stores.operations.save({ id: operationId, packageId: "demo", kind: "update", status: "running", phase: "downloading", progress: 10, message: "Downloading", errorCode: null, startedAt: 1, finishedAt: null });
  const staged = resolveContainedPath(stores.paths.stagingDir, operationId);
  await mkdir(staged, { recursive: true });
  await writeFile(path.join(staged, "install-transaction.json"), `${JSON.stringify({ schemaVersion: 1, operationId, packageId: "demo", version: "2.0.0", kind: "update", phase: "prepared", previousActivation, previousInstalled })}\n`);

  assert.equal(await recoverInterruptedArmoryOperations(stores, 5500), 1);
  assert.equal((await stores.installed.get("demo"))?.version, "1.0.0");
  assert.equal((await stores.installed.get("demo"))?.enabled, true);
  assert.equal((await stores.installed.get("demo"))?.activeOperationId, null);
});

test("restart recovery finishes forward only after runtime readiness was journaled", async () => {
  const { stores } = await fixture();
  const v1 = packageArchive("demo", "1.0.0");
  const initial = new ArmoryInstaller({ stores, fetchImpl: responseFor(v1) });
  const first = await initial.install(selection("demo", "1.0.0", v1));
  assert.equal((await initial.operations.wait(first.id)).status, "success");
  await stores.installed.update("demo", (record) => ({ ...record, enabled: true }));
  const previousInstalled = (await stores.installed.get("demo"))!;
  const previousActivation = (await getArmoryActivation(stores, "demo"))!;
  const operationId = randomUUID();
  const v2 = packageArchive("demo", "2.0.0");
  const chosen = selection("demo", "2.0.0", v2);
  const nextInstalled = { ...previousInstalled, version: "2.0.0", enabled: true, sourceDigest: chosen.archive.sha256, activeOperationId: null };
  await stores.installed.set(nextInstalled);
  await stores.operations.save({ id: operationId, packageId: "demo", kind: "update", status: "running", phase: "starting", progress: 97, message: "Starting", errorCode: null, startedAt: 1, finishedAt: null });
  await writeFile(packageActivationPath(stores.paths, "demo"), `${JSON.stringify({ schemaVersion: 1, id: "demo", version: "2.0.0", previousVersion: "1.0.0", activatedAt: 2, sourceDigest: chosen.archive.sha256, operationId, installed: nextInstalled })}\n`);
  const destination = packageVersionPath(stores.paths, "demo", "2.0.0");
  await mkdir(destination, { recursive: true });
  const staged = resolveContainedPath(stores.paths.stagingDir, operationId);
  await mkdir(staged, { recursive: true });
  await writeFile(path.join(staged, "install-transaction.json"), `${JSON.stringify({ schemaVersion: 1, operationId, packageId: "demo", version: "2.0.0", kind: "update", phase: "runtime_started", previousActivation, previousInstalled })}\n`);

  assert.equal(await recoverInterruptedArmoryOperations(stores, 6000), 1);
  assert.equal((await stores.operations.get(operationId))?.status, "success");
  assert.equal((await getArmoryActivation(stores, "demo"))?.version, "2.0.0");
  assert.equal((await stores.installed.get("demo"))?.version, "2.0.0");
  assert.equal((await stores.installed.get("demo"))?.enabled, true);
  assert.equal((await stat(destination)).isDirectory(), true);
});

test("restart recovery removes an unactivated first-install version so retry can succeed", async () => {
  const { stores } = await fixture();
  const archive = packageArchive("demo", "1.0.0");
  const interruptedId = randomUUID();
  await stores.operations.save({
    id: interruptedId, packageId: "demo", kind: "install", status: "running", phase: "activating", progress: 90,
    message: "Activating", errorCode: null, startedAt: 1, finishedAt: null,
  });
  await stores.installed.set({
    id: "demo", version: "1.0.0", enabled: false, state: "installing", installedAt: 1, updatedAt: 1,
    sourceDigest: createHash("sha256").update(archive).digest("hex"), configurationStatus: "not_required",
    lastError: null, activeOperationId: interruptedId,
  });
  const staged = resolveContainedPath(stores.paths.stagingDir, interruptedId);
  await mkdir(staged, { recursive: true });
  await writeFile(path.join(staged, "install-transaction.json"), `${JSON.stringify({
    schemaVersion: 1,
    operationId: interruptedId,
    packageId: "demo",
    version: "1.0.0",
  })}\n`);
  const destination = packageVersionPath(stores.paths, "demo", "1.0.0");
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "partial"), "partial");

  assert.equal(await recoverInterruptedArmoryOperations(stores, 2000), 1);
  await assert.rejects(stat(destination), { code: "ENOENT" });
  assert.equal((await stores.installed.get("demo"))?.state, "error");

  const retry = new ArmoryInstaller({ stores, fetchImpl: responseFor(archive) });
  const operation = await retry.install(selection("demo", "1.0.0", archive));
  assert.equal((await retry.operations.wait(operation.id)).status, "success");
  assert.equal((await getArmoryActivation(stores, "demo"))?.version, "1.0.0");
});

test("restart recovery retries cleanup journals left by an already-failed operation", async () => {
  const { stores } = await fixture();
  const operationId = randomUUID();
  await stores.operations.save({
    id: operationId, packageId: "demo", kind: "install", status: "failure", phase: "failed", progress: null,
    message: "Rollback was interrupted", errorCode: "OPERATION_FAILED", startedAt: 1, finishedAt: 2,
  });
  const staged = resolveContainedPath(stores.paths.stagingDir, operationId);
  await mkdir(staged, { recursive: true });
  await writeFile(path.join(staged, "install-transaction.json"), `${JSON.stringify({
    schemaVersion: 1,
    operationId,
    packageId: "demo",
    version: "1.0.0",
  })}\n`);
  const destination = packageVersionPath(stores.paths, "demo", "1.0.0");
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "partial"), "partial");

  assert.equal(await recoverInterruptedArmoryOperations(stores, 3000), 1);
  await assert.rejects(stat(destination), { code: "ENOENT" });
  await assert.rejects(stat(staged), { code: "ENOENT" });
  assert.equal((await stores.operations.get(operationId))?.errorCode, "INTERRUPTED_OPERATION");
});

test("restart recovery recognizes an activation committed before operation completion persisted", async () => {
  const { stores } = await fixture();
  const archive = packageArchive("demo", "1.0.0");
  const installer = new ArmoryInstaller({ stores, fetchImpl: responseFor(archive) });
  const operation = await installer.install(selection("demo", "1.0.0", archive));
  const completed = await installer.operations.wait(operation.id);
  const installed = (await stores.installed.get("demo"))!;
  await stores.operations.save({ ...completed, status: "running", phase: "activating", progress: 90, finishedAt: null });
  await stores.installed.set({ ...installed, activeOperationId: operation.id, state: "installing" });
  const staged = resolveContainedPath(stores.paths.stagingDir, operation.id);
  await mkdir(staged, { recursive: true });
  await writeFile(path.join(staged, "install-transaction.json"), `${JSON.stringify({
    schemaVersion: 1,
    operationId: operation.id,
    packageId: "demo",
    version: "1.0.0",
  })}\n`);

  assert.equal(await recoverInterruptedArmoryOperations(stores, 4321), 1);
  assert.equal((await stores.operations.get(operation.id))?.status, "success");
  assert.equal((await stores.installed.get("demo"))?.state, "ready");
  assert.equal((await stores.installed.get("demo"))?.activeOperationId, null);
  assert.equal((await stat(packageVersionPath(stores.paths, "demo", "1.0.0"))).isDirectory(), true);
  await assert.rejects(stat(staged), { code: "ENOENT" });
});

function tarBuffer(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? "");
    const header = new Header({
      path: entry.path,
      type: entry.type ?? "File",
      linkpath: entry.linkpath,
      size: entry.type && entry.type !== "File" ? 0 : body.byteLength,
      mode: entry.type === "Directory" ? 0o755 : 0o644,
      uid: 0,
      gid: 0,
      mtime: new Date(0),
    });
    const block = Buffer.alloc(512);
    header.encode(block);
    blocks.push(block);
    if (body.byteLength) {
      blocks.push(body);
      const padding = (512 - (body.byteLength % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
