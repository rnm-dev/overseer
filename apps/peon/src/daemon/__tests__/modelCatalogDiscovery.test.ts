import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  normalizeClaudeModelResponse,
  normalizeCodexModelResponse,
  registerAgentDriver,
  type AgentDriver,
} from "../agents/index.js";
import {
  canonicalModel,
  modelCatalog,
  narrowReasoningEffort,
  refreshAgentModelCatalog,
} from "../providers/modelCatalog.js";

test("normalizes Codex app-server model/list with model-specific efforts", () => {
  const models = normalizeCodexModelResponse({ data: [
    {
      id: "catalog-astra", model: "gpt-6-astra", displayName: "GPT-6-Astra", isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "balanced" },
        { reasoningEffort: "ultra", description: "delegating" },
      ],
      defaultReasoningEffort: "medium",
    },
    { id: "hidden", model: "hidden-model", displayName: "Hidden", hidden: true },
  ] });
  assert.deepEqual(models, [{
    id: "gpt-6-astra",
    alias: "catalog-astra",
    label: "GPT-6-Astra",
    default: true,
    reasoningEfforts: [
      { id: "medium", label: "Medium", default: true },
      { id: "ultra", label: "Ultra" },
    ],
  }]);
});

test("normalizes Claude SDK initialize models and resolves aliases", () => {
  const models = normalizeClaudeModelResponse([
    {
      value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default",
      supportsEffort: true, supportedEffortLevels: ["low", "high"],
    },
    {
      value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)",
      supportsEffort: true, supportedEffortLevels: ["low", "high"],
    },
    {
      value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku",
      supportsEffort: false,
    },
  ]);
  assert.deepEqual(models, [
    {
      id: "claude-opus-5[1m]", alias: "opus[1m]", label: "Opus (1M context)", default: true,
      reasoningEfforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
    },
    {
      id: "claude-haiku-4-5-20251001", alias: "haiku", label: "Haiku", reasoningEfforts: [],
    },
  ]);
});

function testDriver(id: string, discover: AgentDriver["services"]["modelCatalog"]): AgentDriver {
  return {
    id, label: "Dynamic test", available: () => true, visible: true,
    models: [{ id: "fallback", label: "Fallback", default: true }],
    canonicalModel: (value) => value === "fallback" ? "fallback" : undefined,
    reasoningEffort: () => undefined,
    command: () => "dynamic-test",
    conversation: { initialBackendId: (sessionId) => sessionId, recoverBackendId: (_sessionId, persisted) => persisted },
    outcomeSchema: () => undefined,
    normalizeOutcome: () => null,
    normalizeStoredEvent: () => null,
    run: () => ({ emitter: new EventEmitter(), kill() {} }),
    interrupt: (run) => run.kill(), shutdown: (run) => run.kill(),
    auth: { observeSuccess() {}, observeFailure() {} },
    capabilities: { steering: false, cancellation: true, recovery: false, quota: false, status: false, cliUpdate: false },
    services: { modelCatalog: discover },
  };
}

test("live driver catalog becomes authoritative for model and effort validation", async () => {
  const id = `dynamic-models-${Date.now()}`;
  registerAgentDriver(testDriver(id, {
    discover: async () => [{
      id: "live-model", alias: "live", label: "Live", default: true,
      reasoningEfforts: [{ id: "new-effort", label: "New effort", default: true }],
    }],
  }));
  await refreshAgentModelCatalog(id, "dynamic-test", true);
  assert.equal(canonicalModel(id, "live"), "live-model");
  assert.equal(canonicalModel(id, "fallback"), undefined);
  assert.equal(narrowReasoningEffort("new-effort", id, "live-model"), "new-effort");
  const provider = modelCatalog(id, null).find((item) => item.agent === id);
  assert.equal(provider?.catalogSource, "cli");
  assert.equal(provider?.catalogError, null);
  assert.equal(provider?.models[0]?.id, "live-model");
  assert.equal(provider?.reasoningEfforts?.[0]?.default, true);
});

test("failed discovery exposes diagnostics and retains the bundled fallback", async () => {
  const id = `fallback-models-${Date.now()}`;
  registerAgentDriver(testDriver(id, { discover: async () => { throw new Error("unsupported discovery"); } }));
  await refreshAgentModelCatalog(id, "dynamic-test", true);
  assert.equal(canonicalModel(id, "fallback"), "fallback");
  const provider = modelCatalog(id, null).find((item) => item.agent === id);
  assert.equal(provider?.catalogSource, "fallback");
  assert.equal(provider?.catalogError, "unsupported discovery");
  assert.equal(provider?.models[0]?.id, "fallback");
});
