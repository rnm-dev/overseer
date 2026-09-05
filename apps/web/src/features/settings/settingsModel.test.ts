import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProvider } from "./models";
import { effortsForModel } from "./models";
import { buildSettingsPayload, resolveDefaultModel, resolveDefaultReasoningEffort } from "./settingsModel";

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

test("Codex settings include the selected provider-neutral default model", () => {
  assert.deepEqual(
    buildSettingsPayload({ defaultAgent: "codex", aiDefaultModel: "gpt-5.6-sol", name: "Kanat" }, codex, true),
    { defaultAgent: "codex", aiDefaultModel: "gpt-5.6-sol", name: "Kanat" },
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

test("settings save never echoes projection or command metadata", () => {
  assert.deepEqual(
    buildSettingsPayload({
      defaultAgent: "codex",
      aiDefaultModel: "gpt-5.4",
      sync: { status: "current", revision: 7 },
      commandId: "00000000-0000-4000-8000-000000000001",
      restart: { required: false, components: [] },
    }, codex, true),
    { defaultAgent: "codex", aiDefaultModel: "gpt-5.4" },
  );
});

test("settings save preserves execution safety controls", () => {
  assert.deepEqual(
    buildSettingsPayload({
      defaultAgent: "codex",
      aiDefaultModel: "gpt-5.4",
      maxTurns: 2_000,
      taskTimeoutMs: 3_600_000,
      maxBudgetUsd: 50,
    }, codex, true),
    {
      defaultAgent: "codex",
      aiDefaultModel: "gpt-5.4",
      maxTurns: 2_000,
      taskTimeoutMs: 3_600_000,
      maxBudgetUsd: 50,
    },
  );
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

const claudeWithEfforts: ModelProvider = {
  agent: "claude-code",
  label: "Claude Code",
  models: [
    { id: "claude-opus-5", label: "Opus 5", default: true, reasoningEfforts: [
      { id: "low", label: "Low" },
      { id: "high", label: "High", default: true },
      { id: "max", label: "Max" },
    ] },
    // Omits the key entirely, exactly as a real peon does for an
    // effort-less model — not an empty list.
    { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
  reasoningEfforts: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", default: true },
    { id: "max", label: "Max" },
  ],
};

test("a model that advertises its own efforts overrides the provider list", () => {
  assert.deepEqual(effortsForModel(claudeWithEfforts, "claude-opus-5").map((e) => e.id), ["low", "high", "max"]);
  assert.deepEqual(effortsForModel(claudeWithEfforts, "claude-haiku-4-5"), []);
});

test("a configured effort survives only while its model still advertises it", () => {
  assert.equal(resolveDefaultReasoningEffort(claudeWithEfforts, "claude-opus-5", "max"), "max");
  assert.equal(resolveDefaultReasoningEffort(claudeWithEfforts, "claude-opus-5", "minimal"), null);
  // Haiku takes no effort at all, so even a provider-listed one is dropped.
  assert.equal(resolveDefaultReasoningEffort(claudeWithEfforts, "claude-haiku-4-5", "max"), null);
  assert.equal(resolveDefaultReasoningEffort(claudeWithEfforts, "claude-opus-5", null), null);
});

test("clearing the effort is sent as an explicit null, not dropped as an unset field", () => {
  assert.deepEqual(
    buildSettingsPayload({ defaultAgent: "claude-code", aiDefaultModel: "claude-opus-5", aiDefaultReasoningEffort: null }, claudeWithEfforts, true),
    { defaultAgent: "claude-code", aiDefaultModel: "claude-opus-5", aiDefaultReasoningEffort: null },
  );
});

test("a chosen effort is submitted and an unsupported one is normalized away", () => {
  assert.deepEqual(
    buildSettingsPayload({ defaultAgent: "claude-code", aiDefaultModel: "claude-opus-5", aiDefaultReasoningEffort: "max" }, claudeWithEfforts, true),
    { defaultAgent: "claude-code", aiDefaultModel: "claude-opus-5", aiDefaultReasoningEffort: "max" },
  );
  assert.deepEqual(
    buildSettingsPayload({ defaultAgent: "claude-code", aiDefaultModel: "claude-opus-5", aiDefaultReasoningEffort: "minimal" }, claudeWithEfforts, true),
    { defaultAgent: "claude-code", aiDefaultModel: "claude-opus-5", aiDefaultReasoningEffort: null },
  );
});

test("providers and models with no efforts get no effort key at all", () => {
  // Codex here advertises none, so the peon must not be sent the field.
  assert.deepEqual(
    buildSettingsPayload({ defaultAgent: "codex", aiDefaultModel: "gpt-5.6-sol", aiDefaultReasoningEffort: "high" }, codex, true),
    { defaultAgent: "codex", aiDefaultModel: "gpt-5.6-sol" },
  );
  assert.deepEqual(
    buildSettingsPayload({ defaultAgent: "claude-code", aiDefaultModel: "claude-haiku-4-5", aiDefaultReasoningEffort: "high" }, claudeWithEfforts, true),
    { defaultAgent: "claude-code", aiDefaultModel: "claude-haiku-4-5" },
  );
});

test("an older peon exposing only provider-level efforts still resolves", () => {
  const legacy: ModelProvider = { ...claudeWithEfforts, models: [{ id: "claude-opus-5", label: "Opus 5", default: true }] };
  assert.deepEqual(effortsForModel(legacy, "claude-opus-5").map((e) => e.id), ["low", "high", "max"]);
  assert.equal(resolveDefaultReasoningEffort(legacy, "claude-opus-5", "low"), "low");
});

// The shape a current production Peon actually publishes: efforts live on each
// model, and a model that takes none (Haiku) omits the key rather than sending
// an empty list. Verified against peon-kanat.mesh.rnm on 2026-07-27.
const liveClaude: ModelProvider = {
  agent: "claude-code",
  label: "Claude Code",
  models: [
    { id: "claude-opus-5", label: "Opus 5", alias: "opus", default: true, reasoningEfforts: [
      { id: "low", label: "Low" }, { id: "high", label: "High", default: true }, { id: "max", label: "Max" },
    ] },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", alias: "haiku" },
  ],
  reasoningEfforts: [
    { id: "low", label: "Low" }, { id: "high", label: "High", default: true }, { id: "max", label: "Max" },
  ],
};

test("a model omitting the effort key on an effort-scoping peon takes no effort", () => {
  assert.deepEqual(effortsForModel(liveClaude, "claude-opus-5").map((e) => e.id), ["low", "high", "max"]);
  // Haiku must not inherit the provider-wide list just because it omits its own.
  assert.deepEqual(effortsForModel(liveClaude, "claude-haiku-4-5-20251001"), []);
  assert.equal(resolveDefaultReasoningEffort(liveClaude, "claude-haiku-4-5-20251001", "high"), null);
  assert.deepEqual(
    buildSettingsPayload({ defaultAgent: "claude-code", aiDefaultModel: "claude-haiku-4-5-20251001", aiDefaultReasoningEffort: "high" }, liveClaude, true),
    { defaultAgent: "claude-code", aiDefaultModel: "claude-haiku-4-5-20251001" },
  );
});

test("a model alias resolves to the same effort list as its id", () => {
  assert.deepEqual(effortsForModel(liveClaude, "opus").map((e) => e.id), ["low", "high", "max"]);
  assert.deepEqual(effortsForModel(liveClaude, "haiku"), []);
});

test("a session with no model of its own still offers the provider list", () => {
  assert.deepEqual(effortsForModel(liveClaude, null).map((e) => e.id), ["low", "high", "max"]);
});
