import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliUpdateError, CliUpdateManager, parseCliVersion } from "../updates/cliUpdates.js";

test("parses provider version output", () => {
  assert.equal(parseCliVersion("codex-cli 0.137.0"), "0.137.0");
  assert.equal(parseCliVersion("2.1.8 (Claude Code)"), "2.1.8");
  assert.equal(parseCliVersion("unknown"), null);
});

test("persists checks and starts one durable update operation", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peon-cli-update-"));
  const spawned: string[][] = [];
  const manager = new CliUpdateManager({
    statePath: path.join(dir, "state.json"),
    command: (provider) => `/fake/${provider}`,
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
    versionRunner: async () => "2.0.0",
    latestRunner: async () => "2.0.0",
  });
  await assert.rejects(() => manager.start("claude-code"), (error: unknown) => error instanceof CliUpdateError && error.code === "NO_UPDATE_AVAILABLE");
});
