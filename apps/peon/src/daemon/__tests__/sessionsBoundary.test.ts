import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentRun } from "../agents/index.js";
import {
  type ProjectSessionContract,
  type SessionCatalogReader,
  type SessionLifecycleContract,
  type SessionQueueContract,
  type SessionTranscriptEventContract,
  sessions,
} from "../sessions/index.js";
import type { SessionRecord } from "../sessions/index.js";
import { sessionState } from "../sessions/state.js";

function makeRecord(id: string): SessionRecord {
  return {
    id,
    status: "running",
    projectKey: null,
    projectId: null,
    title: null,
    prompt: "boundary test prompt",
    lastMessagePreview: null,
    initiator: null,
    outcome: null,
    startedAt: 1,
    endedAt: null,
    candidateProjectKeys: [],
    taskKey: null,
    taskTitle: null,
    parentSessionId: null,
    spawnDepth: 0,
    spawnRequestId: null,
    parentCompletionNotifiedAt: null,
    parentCompletionNotificationPending: false,
    queuedFollowUps: [],
    followUpPrompts: [],
    pendingSystemPrompts: [],
    expectsOutcome: false,
    lastActivityAt: 1,
    lastUserMessageAt: 1,
    turnBudget: 0,
    turnCount: 0,
    usage: null,
    usageByModel: {},
    contextUsage: null,
    eventCount: 0,
    autoResumeAttempts: 0,
    backendSessionId: null,
    backendTurnId: null,
    backendRuntimeGeneration: null,
    backendTurnStatus: null,
    agent: "claude-code",
    model: null,
    reasoningEffort: null,
    dir: "/tmp/peon-boundary-session",
    dirWasPruned: false,
  } as SessionRecord;
}

test("sessions public index exports an explicit runtime/contract boundary", async () => {
  const api = await import("../sessions/index.js");
  const keys = Object.keys(api);

  assert.equal(keys.includes("sessions"), true);
  assert.equal(keys.includes("toPublicSessionRecord"), true);
  assert.equal(keys.includes("SessionOrchestrationService"), true);
  assert.equal(keys.includes("SessionSpawnError"), true);

  assert.equal(keys.includes("records"), false);
  assert.equal(keys.includes("activeRuns"), false);
  assert.equal(keys.includes("resumePending"), false);
  assert.equal(keys.includes("steerPending"), false);
  assert.equal(keys.includes("sessionState"), false);
});

test("sessions singleton satisfies explicit contracts", () => {
  const catalog: SessionCatalogReader = sessions;
  const lifecycle: SessionLifecycleContract = sessions;
  const queue: SessionQueueContract = sessions;
  const transcript: SessionTranscriptEventContract = sessions;
  const project: ProjectSessionContract = sessions;

  assert.equal(typeof catalog.list, "function");
  assert.equal(typeof lifecycle.start, "function");
  assert.equal(typeof lifecycle.resume, "function");
  assert.equal(typeof queue.enqueue, "function");
  assert.equal(typeof queue.editQueued, "function");
  assert.equal(typeof transcript.on, "function");
  assert.equal(typeof transcript.off, "function");
  assert.equal(typeof project.start, "function");
});

test("session contracts are implementation-agnostic boundaries", () => {
  const source = readFileSync(fileURLToPath(new URL("../sessions/contracts.ts", import.meta.url)), "utf8");
  assert.equal(new RegExp("\\\\bexpress\\\\b").test(source), false);
  assert.equal(new RegExp("from\\\\s+[\"']\\\\./state\\\\.js").test(source), false);
  assert.equal(new RegExp("from\\\\s+[\"']\\\\./state\\\\.ts").test(source), false);
  assert.equal(new RegExp("\\\\bRequest\\\\b").test(source), false);
  assert.equal(new RegExp("\\\\bResponse\\\\b").test(source), false);
  assert.equal(new RegExp("\\\\bnew\\\\s+Map<").test(source), false);
  assert.equal(new RegExp("\\\\bnew\\\\s+Set<").test(source), false);
});

test("sessions state boundary exports minimal mutable operations", () => {
  const id = "boundary-session";
  const record = makeRecord(id);
  const run: AgentRun = {
    emitter: new EventEmitter(),
    kill() {},
  };

  assert.equal(sessionState.records instanceof Map, false);
  assert.equal(sessionState.activeRuns instanceof Map, false);
  assert.equal(sessionState.resumePending instanceof Set, false);
  assert.equal(sessionState.steerPending instanceof Set, false);
  assert.equal(sessionState.queueDispatchPending instanceof Set, false);

  sessionState.records.set(record);
  assert.equal(sessionState.records.has(id), true);
  assert.equal(sessionState.records.get(id), record);
  assert.equal(sessionState.records.size(), 1);

  sessionState.activeRuns.set(id, run);
  assert.equal(sessionState.activeRuns.has(id), true);
  assert.equal(sessionState.activeRuns.get(id), run);
  assert.equal(sessionState.activeRuns.size(), 1);

  let pinged = false;
  const listener = () => {
    pinged = true;
  };
  sessionState.emitter.on("boundary", listener);
  sessionState.emitter.emit("boundary");
  assert.equal(pinged, true);
  sessionState.emitter.off("boundary", listener);

  sessionState.warningThrottle.set("k", { at: 1, ratio: 0.25 });
  assert.deepEqual(sessionState.warningThrottle.get("k"), { at: 1, ratio: 0.25 });

  sessionState.resumePending.add(id);
  assert.equal(sessionState.resumePending.has(id), true);
  assert.equal(sessionState.resumePending.size(), 1);
  sessionState.steerPending.add(id);
  assert.equal(sessionState.steerPending.has(id), true);
  assert.equal(sessionState.steerPending.size(), 1);
  sessionState.queueDispatchPending.add(id);
  assert.equal(sessionState.queueDispatchPending.has(id), true);
  assert.equal(sessionState.queueDispatchPending.size(), 1);

  sessionState.records.delete(id);
  sessionState.activeRuns.delete(id);
  sessionState.resumePending.delete(id);
  sessionState.steerPending.delete(id);
  sessionState.queueDispatchPending.delete(id);
  sessionState.warningThrottle.set("k", { at: 2, ratio: 0.5 });

  assert.equal(sessionState.records.has(id), false);
  assert.equal(sessionState.activeRuns.has(id), false);
  assert.equal(sessionState.resumePending.has(id), false);
  assert.equal(sessionState.steerPending.has(id), false);
  assert.equal(sessionState.queueDispatchPending.has(id), false);
});
