import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsStore } from "../settings/settingsStore.js";

function freshStore(installed: string[]): SettingsStore {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-agent-default-"));
  return new SettingsStore(path.join(root, "settings.json"), (command) => installed.includes(command));
}

test("new Peon selects Codex when it is the only installed coding agent", () => {
  const settings = freshStore(["codex"]).get();

  assert.equal(settings.defaultAgent, "codex-app-server");
  assert.equal(settings.ai.defaultModel, "gpt-5.6-sol");
  assert.equal(settings.ai.defaultReasoningEffort, "low");
});

test("new Peon keeps Claude preference unless Codex is the only installed agent", () => {
  for (const installed of [[], ["claude"], ["claude", "codex"]]) {
    const settings = freshStore(installed).get();
    assert.equal(settings.defaultAgent, "claude-code");
    assert.equal(settings.ai.defaultModel, "claude-sonnet-5");
    assert.equal(settings.ai.defaultReasoningEffort, "high");
  }
});

test("an existing settings file is never reselected from installed commands", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-agent-existing-"));
  const settingsPath = path.join(root, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ name: "Existing Peon" }));

  const settings = new SettingsStore(settingsPath, (command) => command === "codex").get();
  assert.equal(settings.defaultAgent, "claude-code");
  assert.equal(settings.ai.defaultModel, "claude-sonnet-5");
});
