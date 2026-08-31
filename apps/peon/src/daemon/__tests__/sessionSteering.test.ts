import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRun, AgentRunOptions, AgentSteerCallbacks, AgentSteerInput } from "../agents/index.js";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-steering-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-steering-state-"));

const {
  registerAgentDriver,
} = await import("../agents/index.js");
const { readTranscript } = await import("../sessions/sessionArtifacts.js");
const { sessions } = await import("../sessions/index.js");
const { settings } = await import("../settings/index.js");

settings.update({ taskTimeoutMs: 5_000 });

const driverId = `test-steering-${Date.now()}`;
let runCount = 0;
let pendingSteer: { input: AgentSteerInput; callbacks: AgentSteerCallbacks } | null = null;
let latestRun: AgentRun | null = null;

registerAgentDriver({
  id: driverId,
  label: "Test steering",
  available: () => true,
  visible: false,
  models: [{ id: "test-model", label: "Test", default: true }],
  canonicalModel: (value) => value === "test-model" ? "test-model" : undefined,
  reasoningEffort: () => undefined,
  command: () => "test-steering",
  conversation: { initialBackendId: () => "test-thread", recoverBackendId: (_id, persisted) => persisted },
  outcomeSchema: () => undefined,
  normalizeOutcome: () => null,
  normalizeStoredEvent: (raw) => raw as never,
  run: () => {
    runCount += 1;
    latestRun = { emitter: new EventEmitter(), kill() {} };
    return latestRun;
  },
  steer: (_run, input, callbacks) => {
    pendingSteer = { input, callbacks };
    return true;
  },
  interrupt: (run: AgentRun) => setImmediate(() => run.emitter.emit("exit", { code: null, signal: "SIGTERM", spawnError: null })),
  shutdown: (run: AgentRun) => setImmediate(() => run.emitter.emit("exit", { code: null, signal: "SIGTERM", spawnError: null })),
  auth: { observeSuccess() {}, observeFailure() {} },
  capabilities: { steering: true, cancellation: true, recovery: true, quota: false, status: false, cliUpdate: false },
  services: {},
});

const claudeStyleDriverId = `test-claude-style-steering-${Date.now()}`;
const claudeStyleRuns: AgentRunOptions[] = [];
registerAgentDriver({
  id: claudeStyleDriverId,
  label: "Test Claude-style steering",
  available: () => true,
  visible: false,
  models: [{ id: "test-model", label: "Test", default: true }],
  canonicalModel: (value) => value === "test-model" ? "test-model" : undefined,
  reasoningEffort: () => undefined,
  command: () => "test-claude-style-steering",
  conversation: { initialBackendId: (id) => id, recoverBackendId: (_id, persisted) => persisted },
  outcomeSchema: () => undefined,
  normalizeOutcome: () => null,
  normalizeStoredEvent: (raw) => raw as never,
  run: (options) => {
    claudeStyleRuns.push(options);
    const emitter = new EventEmitter();
    return { emitter, kill: () => setImmediate(() => emitter.emit("exit", { code: null, signal: "SIGTERM", spawnError: null })) };
  },
  interrupt: (run) => run.kill(),
  shutdown: (run) => run.kill(),
  auth: { observeSuccess() {}, observeFailure() {} },
  capabilities: { steering: false, cancellation: true, recovery: true, quota: false, status: false, cliUpdate: false },
  services: {},
});

const userMessages = (id: string) => readTranscript(id, driverId).filter((event) => event.type === "user_message");

async function waitForRunCount(expected: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (runCount >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`expected ${expected} driver runs, got ${runCount}`);
}

test("native steering records a follow-up only after acknowledgement", () => {
  pendingSteer = null;
  const record = sessions.start({ id: "native-steer-accepted", prompt: "first", dir: os.tmpdir(), agent: driverId });
  sessions.resume(record.id, "redirect", [], undefined, "alice@example.com", undefined, undefined, "command-2");

  assert.equal(userMessages(record.id).length, 1);
  assert.equal(sessions.get(record.id)?.followUpPrompts.length, 0);
  assert.equal(pendingSteer?.input.prompt, "redirect");
  pendingSteer?.callbacks.accepted();

  assert.deepEqual(userMessages(record.id).map((event) => [event.text, event.author, event.commandId]), [
    ["first", undefined, undefined],
    ["redirect", "alice@example.com", "command-2"],
  ]);
  assert.deepEqual(sessions.get(record.id)?.followUpPrompts, ["redirect"]);
  assert.equal(sessions.cancel(record.id), true);
});

test("a rejected native steer falls back to one interrupt-and-resume turn", async () => {
  pendingSteer = null;
  const initialRuns = runCount;
  const record = sessions.start({ id: "native-steer-rejected", prompt: "first", dir: os.tmpdir(), agent: driverId });
  sessions.resume(record.id, "fallback", [], undefined, "bob@example.com");

  assert.equal(userMessages(record.id).length, 1);
  pendingSteer?.callbacks.rejected(new Error("native steer rejected"));
  await waitForRunCount(initialRuns + 2);

  assert.deepEqual(userMessages(record.id).map((event) => [event.text, event.author]), [
    ["first", undefined],
    ["fallback", "bob@example.com"],
  ]);
  assert.deepEqual(sessions.get(record.id)?.followUpPrompts, ["fallback"]);
  assert.equal(sessions.cancel(record.id), true);
});

test("cancellation fences a late native steer acknowledgement", () => {
  pendingSteer = null;
  const record = sessions.start({ id: "native-steer-cancelled", prompt: "first", dir: os.tmpdir(), agent: driverId });
  sessions.resume(record.id, "must not appear");
  const late = pendingSteer;

  assert.equal(sessions.cancel(record.id), true);
  late?.callbacks.accepted();

  assert.equal(sessions.get(record.id)?.status, "completed");
  assert.equal(userMessages(record.id).length, 1);
  assert.deepEqual(sessions.get(record.id)?.followUpPrompts, []);
});

test("an accepted steer is recorded when its terminal notification wins the callback race", () => {
  pendingSteer = null;
  const record = sessions.start({ id: "native-steer-terminal-race", prompt: "first", dir: os.tmpdir(), agent: driverId });
  sessions.resume(record.id, "accepted before terminal");
  const accepted = pendingSteer;

  latestRun?.emitter.emit("exit", { code: 0, signal: null, spawnError: null });
  assert.equal(sessions.get(record.id)?.status, "completed");
  accepted?.callbacks.accepted();

  assert.deepEqual(userMessages(record.id).map((event) => event.text), ["first", "accepted before terminal"]);
  assert.deepEqual(sessions.get(record.id)?.followUpPrompts, ["accepted before terminal"]);
  assert.equal(sessions.get(record.id)?.status, "completed");
});

test("a queued Codex-style steer stays durable until native acknowledgement", () => {
  pendingSteer = null;
  const initialRuns = runCount;
  const record = sessions.start({ id: "native-queued-steer-accepted", prompt: "first", dir: os.tmpdir(), agent: driverId });
  sessions.enqueue(record.id, "wait normally");
  sessions.enqueue(record.id, "redirect natively", [], undefined, "alice@example.com", undefined, undefined, "command-native");
  const selected = sessions.queued(record.id)?.find((item) => item.prompt === "redirect natively");
  assert.ok(selected);

  assert.equal(sessions.steerQueued(record.id, selected.id), "steered");
  assert.equal(runCount, initialRuns + 1);
  assert.equal(sessions.queued(record.id)?.[0]?.id, selected.id);
  assert.equal(sessions.queued(record.id)?.[0]?.type, "steer");
  assert.equal(pendingSteer?.input.prompt, "redirect natively");

  pendingSteer?.callbacks.accepted();
  assert.equal(runCount, initialRuns + 1);
  assert.deepEqual(sessions.queued(record.id)?.map((item) => item.prompt), ["wait normally"]);
  assert.deepEqual(userMessages(record.id).map((event) => [event.text, event.author, event.commandId]), [
    ["first", undefined, undefined],
    ["redirect natively", "alice@example.com", "command-native"],
  ]);
  // A retry after Overseer lost the first 2xx is the same successful command,
  // not an UNKNOWN_QUEUE_ITEM refusal and not a second provider delivery.
  assert.equal(sessions.steerQueued(record.id, selected.id), "steered");
  assert.equal(userMessages(record.id).length, 2);

  const remaining = sessions.queued(record.id)?.[0];
  assert.ok(remaining);
  assert.equal(sessions.removeQueued(record.id, remaining.id), "removed");
  assert.equal(sessions.cancel(record.id), true);
});

test("a rejected queued native steer keeps the item and falls back to interrupt-and-resume", async () => {
  pendingSteer = null;
  const initialRuns = runCount;
  const record = sessions.start({ id: "native-queued-steer-rejected", prompt: "first", dir: os.tmpdir(), agent: driverId });
  sessions.enqueue(record.id, "fallback redirect", [], undefined, "bob@example.com");
  const selected = sessions.queued(record.id)?.[0];
  assert.ok(selected);

  assert.equal(sessions.steerQueued(record.id, selected.id), "steered");
  pendingSteer?.callbacks.rejected(new Error("native steer rejected"));
  assert.equal(sessions.queued(record.id)?.[0]?.id, selected.id);
  await waitForRunCount(initialRuns + 2);

  assert.equal(latestRun == null, false);
  assert.deepEqual(sessions.queued(record.id), []);
  assert.deepEqual(userMessages(record.id).map((event) => [event.text, event.author]), [
    ["first", undefined],
    ["fallback redirect", "bob@example.com"],
  ]);
  assert.equal(sessions.cancel(record.id), true);
});

test("a queued steer redirects a Claude-style backend by interrupting and resuming its conversation", async () => {
  const initialRuns = claudeStyleRuns.length;
  const record = sessions.start({
    id: "claude-style-queued-steer",
    prompt: "first",
    dir: os.tmpdir(),
    agent: claudeStyleDriverId,
  });
  sessions.enqueue(record.id, "wait normally");
  sessions.enqueue(record.id, "redirect now", [], undefined, "claude-user@example.com");
  const selected = sessions.queued(record.id)?.find((item) => item.prompt === "redirect now");
  assert.ok(selected);

  assert.equal(sessions.steerQueued(record.id, selected.id), "steered");
  assert.equal(sessions.get(record.id)?.queuedFollowUps[0]?.type, "steer");
  await waitForClaudeStyleRunCount(initialRuns + 2);

  assert.equal(claudeStyleRuns.at(-1)?.resume, true);
  assert.equal(claudeStyleRuns.at(-1)?.backendSessionId, record.id);
  assert.equal(claudeStyleRuns.at(-1)?.prompt, "redirect now");
  assert.equal(sessions.get(record.id)?.queuedFollowUps[0]?.prompt, "wait normally");
  assert.equal(sessions.steerQueued(record.id, selected.id), "steered");
  assert.equal(claudeStyleRuns.length, initialRuns + 2);
  assert.equal(sessions.cancel(record.id), true);
});

async function waitForClaudeStyleRunCount(expected: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (claudeStyleRuns.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`expected ${expected} Claude-style driver runs, got ${claudeStyleRuns.length}`);
}
