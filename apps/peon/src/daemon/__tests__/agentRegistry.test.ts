import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentServices,
  getAgentDriver,
  getAgentServiceDriver,
  listAgentDrivers,
  registerAgentDriver,
  requireAgentDriver,
  shutdownAgentDriverRuntimes,
  type AgentDriver,
} from "../agents/index.js";
import { modelCatalog, narrowNewSessionAgent } from "../modelCatalog.js";
import { parseSessionAnalyticsQuery } from "../sessionAnalytics.js";

describe("agent driver registry", () => {
  it("owns built-in discovery, model validation and canonical lifecycle behavior", () => {
    const claude = requireAgentDriver("claude-code");
    const codex = requireAgentDriver("codex-app-server");
    assert.equal(claude.canonicalModel("sonnet"), "claude-sonnet-5");
    assert.equal(codex.reasoningEffort("ultra", "gpt-5.6-sol"), "ultra");
    assert.equal(codex.reasoningEffort("max", "gpt-5.5"), undefined);
    assert.equal(claude.reasoningEffort("high", "claude-haiku-4-5-20251001"), undefined);
    assert.equal(claude.conversation.initialBackendId("session-1"), "session-1");
    assert.equal(codex.conversation.initialBackendId("session-1"), null);
    assert.deepEqual(codex.normalizeOutcome({ result: "success", summary: "done" }), { result: "success", summary: "done", previewPath: null });
    assert.equal(getAgentDriver("codex"), undefined);
    assert.equal(getAgentServiceDriver("codex"), codex);
  });

  it("keeps hidden legacy drivers usable for existing sessions but out of new-session discovery", () => {
    const id = `test-hidden-${Date.now()}`;
    const driver: AgentDriver = {
      id, label: "Test hidden", available: () => true, visible: false, legacy: true,
      models: [{ id: "test-model", label: "Test", default: true }],
      canonicalModel: (value) => value === "test-model" ? "test-model" : undefined,
      reasoningEffort: () => undefined,
      command: () => "test-agent",
      conversation: { initialBackendId: (sessionId) => sessionId, recoverBackendId: (_id, persisted) => persisted },
      outcomeSchema: () => undefined,
      normalizeOutcome: () => null,
      normalizeStoredEvent: (raw) => raw.type === "result" ? raw as never : null,
      run: () => ({ emitter: new EventEmitter(), kill() {} }),
      interrupt: (run) => run.kill(), shutdown: (run) => run.kill(),
      auth: { observeSuccess() {}, observeFailure() {} },
      capabilities: { steering: false, cancellation: true, recovery: true, quota: false, status: false, cliUpdate: false },
      services: {},
    };
    registerAgentDriver(driver);
    assert.equal(getAgentDriver(id), driver);
    assert.ok(listAgentDrivers().includes(driver));
    assert.equal(narrowNewSessionAgent(id), undefined);
    assert.equal(modelCatalog("claude-code", null).some((provider) => provider.agent === id), false);
  });

  it("fails unknown drivers actionably instead of silently reassigning them", () => {
    assert.throws(() => requireAgentDriver("missing-driver"), /Agent driver "missing-driver" is not registered/);
  });

  it("routes a visible third driver through discovery, services, analytics and lifecycle", async () => {
    const id = `test-visible-${Date.now()}`;
    let interrupted = false;
    const run = { emitter: new EventEmitter(), kill() {} };
    registerAgentDriver({
      id, label: "Test visible", available: () => true, visible: true,
      models: [{ id: "test-model", label: "Test", default: true }],
      canonicalModel: (value) => value === "test-model" ? "test-model" : undefined,
      reasoningEffort: () => undefined, command: () => "test-agent",
      conversation: { initialBackendId: () => null, recoverBackendId: (_id, persisted) => persisted },
      outcomeSchema: () => undefined, normalizeOutcome: () => null,
      normalizeStoredEvent: (raw) => raw as never, run: () => run,
      interrupt: () => { interrupted = true; }, shutdown: () => {},
      auth: { observeSuccess() {}, observeFailure() {} },
      capabilities: { steering: false, cancellation: true, recovery: true, quota: true, status: true, cliUpdate: false },
      services: {
        status: () => ({ status: "ok" }),
        quota: async () => ({ provider: id, status: "ok", source: null, updatedAt: 1, windows: [] }),
        capabilities: async () => ({ provider: id, status: "ok", updatedAt: 1, plugins: [], skills: [], mcps: [] }),
      },
    });
    const driver = requireAgentDriver(id);
    assert.equal(narrowNewSessionAgent(id), id);
    assert.ok(modelCatalog("claude-code", null).some((provider) => provider.agent === id));
    assert.equal((await agentServices.quota(id))?.provider, id);
    assert.equal((await agentServices.capabilities(id))?.provider, id);
    assert.deepEqual(parseSessionAnalyticsQuery({ agent: id }).filters.agent, [id]);
    driver.interrupt(run, "cancel");
    assert.equal(interrupted, true);
  });

  it("shuts down process-wide driver runtimes through the provider-neutral lifecycle", async () => {
    const id = `test-runtime-${Date.now()}`;
    let closed = 0;
    registerAgentDriver({
      id, label: "Test runtime", available: () => true, visible: false,
      models: [], canonicalModel: () => undefined, reasoningEffort: () => undefined,
      command: () => "test", conversation: { initialBackendId: () => null, recoverBackendId: (_id, persisted) => persisted },
      outcomeSchema: () => undefined, normalizeOutcome: () => null, normalizeStoredEvent: () => null,
      run: () => ({ emitter: new EventEmitter(), kill() {} }), interrupt: () => {}, shutdown: () => {},
      shutdownRuntime: async () => { closed++; },
      auth: { observeSuccess() {}, observeFailure() {} },
      capabilities: { steering: false, cancellation: false, recovery: false, quota: false, status: false, cliUpdate: false },
      services: {},
    });
    await shutdownAgentDriverRuntimes();
    assert.equal(closed, 1);
  });
});
