import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRun, AgentSteerCallbacks, AgentSteerInput } from "../agents/index.js";

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
