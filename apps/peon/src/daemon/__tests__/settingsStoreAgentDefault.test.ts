import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_MAX_TURNS, SettingsStore } from "../settings/settingsStore.js";

function freshStore(installed: string[]): SettingsStore {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-agent-default-"));
  return new SettingsStore(path.join(root, "settings.json"), (command) => installed.includes(command));
}

test("new Peon selects Codex when it is the only installed coding agent", () => {
  const settings = freshStore(["codex"]).get();

  assert.equal(settings.defaultAgent, "codex-app-server");
  assert.equal(settings.ai.defaultModel, null);
  assert.equal(settings.ai.defaultReasoningEffort, null);
});

test("new Peon keeps Claude preference unless Codex is the only installed agent", () => {
  for (const installed of [[], ["claude"], ["claude", "codex"]]) {
    const settings = freshStore(installed).get();
    assert.equal(settings.defaultAgent, "claude-code");
    assert.equal(settings.ai.defaultModel, null);
    assert.equal(settings.ai.defaultReasoningEffort, null);
  }
});

test("new and upgraded Peons receive the larger logical turn budget once", () => {
  assert.equal(freshStore([]).get().maxTurns, DEFAULT_MAX_TURNS);

  const root = mkdtempSync(path.join(os.tmpdir(), "peon-turn-default-"));
  const settingsPath = path.join(root, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ maxTurns: 300 }));
  const store = new SettingsStore(settingsPath);
  assert.equal(store.get().maxTurns, 1_000);

  store.update({ name: "Migrated Peon" });
  const persisted = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.maxTurns, 1_000);
  assert.equal(persisted.settingsDefaultsVersion, 2);
});

test("turn budget migration preserves non-default and versioned operator choices", () => {
  for (const value of [75, 800]) {
    const root = mkdtempSync(path.join(os.tmpdir(), "peon-turn-custom-"));
    const settingsPath = path.join(root, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ maxTurns: value }));
    assert.equal(new SettingsStore(settingsPath).get().maxTurns, value);
  }

  const root = mkdtempSync(path.join(os.tmpdir(), "peon-turn-versioned-"));
  const settingsPath = path.join(root, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ maxTurns: 300, settingsDefaultsVersion: 2 }));
  assert.equal(new SettingsStore(settingsPath).get().maxTurns, 300);
});

test("an existing settings file is never reselected from installed commands", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-agent-existing-"));
  const settingsPath = path.join(root, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ name: "Existing Peon" }));

  const settings = new SettingsStore(settingsPath, (command) => command === "codex").get();
  assert.equal(settings.defaultAgent, "claude-code");
  assert.equal(settings.ai.defaultModel, null);
});
