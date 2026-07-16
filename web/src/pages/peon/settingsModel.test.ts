import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProvider } from "./models";
import { buildSettingsPayload, resolveDefaultModel } from "./settingsModel";

const codex: ModelProvider = {
  agent: "codex",
  label: "Codex",
  models: [
    { id: "gpt-5.6-sol", label: "5.6 Sol", default: true },
    { id: "gpt-5.4", label: "5.4" },
  ],
  reasoningEfforts: [],
};

test("switching providers resolves the visible provider default for saving", () => {
  assert.equal(resolveDefaultModel(codex, "claude-sonnet-5"), "gpt-5.6-sol");
});

test("an explicit model belonging to the provider is preserved", () => {
  assert.equal(resolveDefaultModel(codex, "gpt-5.4"), "gpt-5.4");
});

test("a model alias belonging to the provider is preserved", () => {
  const provider = { ...codex, models: [{ id: "gpt-5.4", label: "5.4", alias: "codex-latest" }] };
  assert.equal(resolveDefaultModel(provider, "codex-latest"), "codex-latest");
});

test("providers without a marked default use their first model", () => {
  const provider = { ...codex, models: codex.models.map(({ default: _default, ...model }) => model) };
  assert.equal(resolveDefaultModel(provider, null), "gpt-5.6-sol");
});

test("Codex settings omit Peon's legacy Claude-only model field", () => {
  assert.deepEqual(
    buildSettingsPayload({ defaultAgent: "codex", aiDefaultModel: "gpt-5.6-sol", name: "Kanat" }, codex, true),
    { defaultAgent: "codex", name: "Kanat" },
  );
});

test("Claude settings include the selected model", () => {
  const claude: ModelProvider = {
    agent: "claude-code",
    label: "Claude Code",
    models: [{ id: "claude-sonnet-5", label: "Sonnet 5", default: true }],
    reasoningEfforts: [],
  };
  assert.deepEqual(
    buildSettingsPayload({ defaultAgent: "claude-code", aiDefaultModel: null }, claude, true),
    { defaultAgent: "claude-code", aiDefaultModel: "claude-sonnet-5" },
  );
});

test("settings save preserves the original payload before the catalog loads", () => {
  const form = { defaultAgent: "codex", aiDefaultModel: "gpt-5.6-sol" };
  assert.deepEqual(buildSettingsPayload(form, null, false), form);
});

test("new peon settings omit unset null fields from the partial PATCH", () => {
  const claude: ModelProvider = {
    agent: "claude-code",
    label: "Claude Code",
    models: [{ id: "claude-sonnet-5", label: "Sonnet 5", default: true }],
    reasoningEfforts: [],
  };
  assert.deepEqual(
    buildSettingsPayload({
      name: null,
      fileTransferRoot: null,
      heartbeatIntervalMs: 15_000,
      defaultAgent: "claude-code",
      aiDefaultModel: "claude-sonnet-5",
    }, claude, true),
    {
      heartbeatIntervalMs: 15_000,
      defaultAgent: "claude-code",
      aiDefaultModel: "claude-sonnet-5",
    },
  );
});
