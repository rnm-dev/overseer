import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyAgentCliInstallation, createSelfUpdatingCliUpdater, type AgentCliUpdateInspection, type AgentCliUpdateRuntime } from "../agents/index.js";
import { CliUpdateError, CliUpdateManager, parseCliVersion } from "../updates/cliUpdates.js";

const supportedInspection = (provider: string): AgentCliUpdateInspection => ({
  executable: `/fake/${provider}`,
  realExecutable: `/fake/${provider}`,
  installationKind: "npm",
  updateSupported: true,
  reason: null,
});

test("parses provider version output", () => {
  assert.equal(parseCliVersion("codex-cli 0.137.0"), "0.137.0");
  assert.equal(parseCliVersion("2.1.8 (Claude Code)"), "2.1.8");
  assert.equal(parseCliVersion('"0.153.4"'), "0.153.4");
  assert.equal(parseCliVersion("unknown"), null);
});

test("classifies supported and externally managed CLI installations", () => {
  assert.deepEqual(classifyAgentCliInstallation({
    realExecutable: "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
    magic: "23212f75",
    packageName: "@openai/codex",
  }), { installationKind: "npm", updateSupported: true, reason: null });
  assert.equal(classifyAgentCliInstallation({
    realExecutable: "/Users/test/.local/share/claude/versions/2.1.226",
    magic: "feedfacf",
    packageName: "@anthropic-ai/claude-code",
    nativePathFragments: ["/.local/share/claude/versions/"],
  }).installationKind, "native");
  assert.equal(classifyAgentCliInstallation({
    realExecutable: "/opt/homebrew/Cellar/codex/1.2.3/bin/codex",
    magic: "feedfacf",
    packageName: "@openai/codex",
  }).installationKind, "homebrew");
  assert.equal(classifyAgentCliInstallation({
    realExecutable: "/usr/local/bin/codex",
    magic: "7f454c46",
    packageName: "@openai/codex",
  }).installationKind, "standalone");
  assert.equal(classifyAgentCliInstallation({
    realExecutable: "/nix/store/hash-codex/bin/codex",
    magic: "7f454c46",
    packageName: "@openai/codex",
  }).updateSupported, false);
  assert.equal(classifyAgentCliInstallation({
    realExecutable: "/workspace/node_modules/@openai/codex/bin/codex.js",
    magic: "23212f75",
    packageName: "@openai/codex",
  }).installationKind, "externally-managed");
  assert.equal(classifyAgentCliInstallation({
    realExecutable: "/usr/local/bin/codex-wrapper",
    magic: "23212f62",
    packageName: "@openai/codex",
  }).installationKind, "unknown");
});

test("self-updating driver applies and verifies the inspected executable", async () => {
  const calls: Array<[string, string[], number | undefined]> = [];
  const runtime: AgentCliUpdateRuntime = {
    resolve: async () => ({ executable: "/usr/local/bin/codex", realExecutable: "/usr/local/bin/codex" }),
    magic: async () => "7f454c46",
    run: async (command, args, timeout) => {
      calls.push([command, args, timeout]);
      if (args[0] === "--version") return "codex-cli 1.2.3";
      if (command === "npm") return '"1.3.0"';
      return "";
    },
  };
  const updater = createSelfUpdatingCliUpdater({ packageName: "@openai/codex", versionPattern: /codex-cli/i });
  const inspection = await updater.inspect("codex", runtime);
  assert.equal(inspection.installationKind, "standalone");
  assert.equal(await updater.latestVersion(inspection, runtime), '"1.3.0"');
  await updater.apply(inspection, runtime);
  assert.equal(await updater.verify(inspection, runtime), "codex-cli 1.2.3");
  assert.deepEqual(calls.map((call) => [call[0], call[1]]), [
    ["/usr/local/bin/codex", ["--version"]],
    ["npm", ["view", "@openai/codex", "version", "--json"]],
    ["/usr/local/bin/codex", ["update"]],
    ["/usr/local/bin/codex", ["--version"]],
  ]);
});

test("refuses a native executable that does not identify as the provider CLI", async () => {
  const runtime: AgentCliUpdateRuntime = {
    resolve: async () => ({ executable: "/usr/local/bin/codex", realExecutable: "/usr/local/bin/codex" }),
    magic: async () => "7f454c46",
    run: async () => "different-tool 1.2.3",
  };
  const updater = createSelfUpdatingCliUpdater({ packageName: "@openai/codex", versionPattern: /codex-cli/i });
  const inspection = await updater.inspect("codex", runtime);
  assert.equal(inspection.installationKind, "unknown");
  assert.equal(inspection.updateSupported, false);
});

test("persists checks and starts one durable update operation", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peon-cli-update-"));
  const spawned: string[][] = [];
  const manager = new CliUpdateManager({
    statePath: path.join(dir, "state.json"),
    command: (provider) => `/fake/${provider}`,
    inspectionRunner: async (provider) => supportedInspection(provider),
    versionRunner: async () => "codex-cli 1.2.3",
    latestRunner: async () => "1.3.0",
    spawnWorker: (args) => {
      spawned.push(args);
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = () => undefined;
      return child as never;
    },
    now: () => 1000,
  });
  const checked = await manager.get("codex-app-server", true);
  assert.equal(checked.providers[0].updateAvailable, true);
  const operation = await manager.start("codex-app-server");
  assert.equal(operation.status, "running");
  assert.equal(spawned.length, 1);
  await assert.rejects(() => manager.start("codex-app-server"), (error: unknown) => error instanceof CliUpdateError && error.code === "UPDATE_IN_PROGRESS");
  const restored = new CliUpdateManager({ statePath: path.join(dir, "state.json"), now: () => 1001 });
  assert.equal((await restored.get("codex-app-server")).providers[0].operation?.id, operation.id);
});

test("does not launch an update when the installed CLI is current", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peon-cli-current-"));
  const manager = new CliUpdateManager({
    statePath: path.join(dir, "state.json"),
    inspectionRunner: async (provider) => supportedInspection(provider),
    versionRunner: async () => "2.0.0",
    latestRunner: async () => "2.0.0",
  });
  await assert.rejects(() => manager.start("claude-code"), (error: unknown) => error instanceof CliUpdateError && error.code === "NO_UPDATE_AVAILABLE");
});

test("refuses an unknown wrapper before starting a worker", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peon-cli-unsupported-"));
  let spawned = false;
  const manager = new CliUpdateManager({
    statePath: path.join(dir, "state.json"),
    inspectionRunner: async (provider) => ({
      ...supportedInspection(provider), installationKind: "unknown", updateSupported: false,
      reason: "CLI executable is a wrapper or has an unknown owner; automatic update was refused",
    }),
    versionRunner: async () => "1.0.0",
    latestRunner: async () => "2.0.0",
    spawnWorker: () => { spawned = true; throw new Error("must not spawn"); },
  });
  const checked = await manager.get("codex-app-server", true);
  assert.equal(checked.providers[0].installationKind, "unknown");
  assert.equal(checked.providers[0].updateSupported, false);
  assert.equal(checked.providers[0].updateAvailable, null);
  await assert.rejects(() => manager.start("codex-app-server"), (error: unknown) =>
    error instanceof CliUpdateError && error.code === "UPDATE_UNSUPPORTED");
  assert.equal(spawned, false);
});

test("refuses updates while a session is active and prepares a persistent runtime before spawn", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peon-cli-busy-"));
  let busy = true;
  let prepared = 0;
  let spawned = 0;
  const manager = new CliUpdateManager({
    statePath: path.join(dir, "state.json"),
    inspectionRunner: async (provider) => supportedInspection(provider),
    versionRunner: async () => "1.0.0",
    latestRunner: async () => "2.0.0",
    isBusy: () => busy,
    prepare: async () => { prepared++; },
    spawnWorker: () => {
      spawned++;
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = () => undefined;
      return child as never;
    },
  });
  await assert.rejects(() => manager.start("codex-app-server"), (error: unknown) =>
    error instanceof CliUpdateError && error.code === "UPDATE_BUSY");
  assert.equal(prepared, 0);
  busy = false;
  await manager.start("codex-app-server");
  assert.equal(prepared, 1);
  assert.equal(spawned, 1);
});
