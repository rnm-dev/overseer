import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultProviderForCatalog,
  effectiveModelId,
  inheritedModelId,
  isReasoningEffortValid,
  pickerDisplayName,
  pickerEntries,
  reasoningEffortsForEffectiveModel,
  type CatalogOption,
  type ModelsCatalog,
} from "./models";

const catalog = (defaultModel: string | null): ModelsCatalog => ({
  defaultAgent: "claude-code",
  defaultModel,
  providers: [
    {
      agent: "claude-code",
      label: "Claude Code",
      models: [
        { id: "claude-opus-5", label: "Opus 5", alias: "opus", default: true },
        { id: "claude-sonnet-5", label: "Sonnet 5", alias: "sonnet" },
      ],
      reasoningEfforts: [{ id: "high", label: "High", default: true }],
    },
    {
      agent: "codex",
      label: "Codex",
      models: [{ id: "gpt-5.6-sol", label: "5.6 Sol" }],
      reasoningEfforts: [{ id: "medium", label: "Medium", default: true }],
    },
  ],
});

const providerOf = (c: ModelsCatalog, agent: string) => c.providers.find((p) => p.agent === agent) ?? null;

test("a session that pinned a model keeps naming that model", () => {
  const c = catalog(null);
  assert.equal(inheritedModelId(c, providerOf(c, "claude-code"), "claude-sonnet-5"), "claude-sonnet-5");
});

test("a session with nothing pinned inherits the peon's pick for its own provider", () => {
  const c = catalog(null);
  assert.equal(inheritedModelId(c, providerOf(c, "claude-code"), null), "claude-opus-5");
});

test("a provider the peon named no default for stays unnamed rather than guessed", () => {
  // Both Codex providers ship without a marked default today; showing the first
  // model would be an invention, so the reset entry must stay plain "Default".
  const c = catalog(null);
  assert.equal(inheritedModelId(c, providerOf(c, "codex"), null), null);
  assert.equal(inheritedModelId(c, null, null), null);
});

test("the fleet-wide default model only speaks for the provider it belongs to", () => {
  const c = catalog("claude-sonnet-5");
  const codex = { ...providerOf(c, "codex")!, models: [{ id: "gpt-5.6-sol", label: "5.6 Sol" }] };
  assert.equal(inheritedModelId(c, codex, null), null);

  const plain = { ...providerOf(c, "claude-code")!, models: [{ id: "claude-sonnet-5", label: "Sonnet 5", alias: "sonnet" }] };
  assert.equal(inheritedModelId(c, plain, null), "claude-sonnet-5");
  assert.equal(inheritedModelId(c, { ...plain, models: [{ id: "claude-sonnet-5", label: "Sonnet 5", alias: "sonnet" }] }, "opus"), "opus");
});

const models: CatalogOption[] = [
  { id: "gpt-5.6-sol", label: "5.6 Sol" },
  { id: "gpt-5.6-terra", label: "5.6 Terra" },
];
const entries = (value: string, opts: { defaultId?: string; allowClear?: boolean } = {}) =>
  pickerEntries(models, value, {
    defaultId: opts.defaultId,
    defaultLabel: "Default",
    allowClear: opts.allowClear ?? true,
    markDefault: (name) => `${name} (Default)`,
  });

test("reset/inherit is separate from a named default choice", () => {
  assert.deepEqual(entries("", { defaultId: "gpt-5.6-sol" }).map((e) => e.label), ["Default", "5.6 Sol (Default)", "5.6 Terra"]);
});

test("an untouched picker displays its effective default while named rows remain explicit", () => {
  const [reset, inherited, other] = entries("", { defaultId: "gpt-5.6-sol" });
  assert.deepEqual([reset.active, inherited.active, other.active], [true, false, false]);
  assert.equal(inherited.value, "gpt-5.6-sol");
  assert.equal(other.value, "gpt-5.6-terra");
  assert.equal(pickerDisplayName(models, "", { defaultId: "gpt-5.6-sol", defaultLabel: "Default" }), "5.6 Sol");
});

test("the default named row remains explicit through A-B-A", () => {
  assert.equal(entries("gpt-5.6-sol", { defaultId: "gpt-5.6-sol" })[1]?.value, "gpt-5.6-sol");
  assert.deepEqual(entries("gpt-5.6-terra", { defaultId: "gpt-5.6-sol" }).map((entry) => entry.active), [false, false, true]);
  assert.deepEqual(entries("gpt-5.6-sol", { defaultId: "gpt-5.6-sol" }).map((entry) => entry.active), [false, true, false]);
});

test("a picker with nothing to reset to pins the default it marks", () => {
  const [inherited] = entries("", { defaultId: "gpt-5.6-sol", allowClear: false });
  assert.equal(inherited.value, "gpt-5.6-sol");
});

test("an explicit value wins over the inherited option", () => {
  assert.deepEqual(entries("gpt-5.6-terra", { defaultId: "gpt-5.6-sol" }).map((e) => e.active), [false, false, true]);
});

test("a picker with no known default keeps its plain reset entry", () => {
  const rows = entries("");
  assert.deepEqual(rows.map((e) => e.label), ["Default", "5.6 Sol", "5.6 Terra"]);
  assert.deepEqual([rows[0].value, rows[0].active], ["", true]);
  assert.deepEqual(entries("", { allowClear: false }).map((e) => e.label), ["5.6 Sol", "5.6 Terra"]);
});

test("an alias names the same default as the id", () => {
  const aliased: CatalogOption[] = [{ id: "claude-opus-5", label: "Opus 5", alias: "opus" }];
  const rows = pickerEntries(aliased, "", { defaultId: "opus", defaultLabel: "Default", allowClear: true, markDefault: (n) => `${n} (Default)` });
  assert.deepEqual(rows.map((e) => e.label), ["Default", "Opus 5 (Default)"]);
  assert.equal(rows[1].value, "claude-opus-5");
});

test("a known but unavailable default agent does not silently become the first provider", () => {
  const c = catalog(null);
  c.defaultAgent = "removed-provider";
  assert.equal(defaultProviderForCatalog(c), null);
});

test("unknown identities remain visible, and cannot borrow provider-wide effort choices", () => {
  const codex = providerOf(catalog(null), "codex");
  assert.equal(pickerDisplayName(models, "missing-model", { defaultLabel: "Default" }), "missing-model");
  assert.equal(effectiveModelId(catalog(null), codex, "missing-model", null), "missing-model");
  assert.deepEqual(reasoningEffortsForEffectiveModel(codex, "missing-model"), []);
});

test("a known model with an authoritative empty effort list rejects a restored effort", () => {
  const provider = {
    agent: "codex",
    label: "Codex",
    models: [{ id: "model-a", label: "Model A", reasoningEfforts: [] }],
    reasoningEfforts: [{ id: "high", label: "High" }],
  };
  assert.equal(isReasoningEffortValid(provider, "model-a", "high"), false);
});
