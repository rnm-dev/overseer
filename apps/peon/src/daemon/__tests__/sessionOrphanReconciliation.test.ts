import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRun } from "../agents/index.js";
import type { SessionRecord } from "../sessionTypes.js";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-orphan-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-orphan-state-"));

const { ORPHANED_RUN_MARKER, sessions } = await import("../sessions/index.js");
const { sessionState } = await import("../sessions/state.js");

function makeRunningRecord(id: string): SessionRecord {
  const now = Date.now();
  return {
    id,
    prompt: "test",
    title: null,
    followUpPrompts: [],
    queuedFollowUps: [],
    pendingSystemPrompts: [],
    dir: os.tmpdir(),
    agent: "claude-code",
    backendSessionId: null,
    backendTurnId: null,
    backendRuntimeGeneration: null,
    backendTurnStatus: null,
    model: null,
    reasoningEffort: null,
    projectId: null,
    projectKey: null,
    candidateProjectKeys: [],
    taskKey: null,
    taskTitle: null,
    initiator: null,
    expectsOutcome: false,
    status: "running",
    outcome: null,
    startedAt: now,
    endedAt: null,
    turnCount: 0,
    turnBudget: 10,
    usage: null,
    usageByModel: {},
    contextUsage: null,
    autoResumeAttempts: 0,
    lastActivityAt: now,
    lastUserMessageAt: now,
    lastMessagePreview: "test",
    eventCount: 1,
  };
}

function cleanup(id: string): void {
  sessionState.records.delete(id);
  sessionState.activeRuns.delete(id);
  sessionState.resumePending.delete(id);
  sessionState.steerPending.delete(id);
}

test("get heals a running record whose run disappeared", () => {
  const record = makeRunningRecord("orphaned-read");
  sessionState.records.set(record);

  const reconciled = sessions.get(record.id)!;

  assert.equal(reconciled.status, "completed");
  assert.equal(reconciled.outcome?.result, "failure");
  assert.match(reconciled.outcome?.summary ?? "", new RegExp(ORPHANED_RUN_MARKER));
  assert.equal(sessions.activeCount(), 0);
  cleanup(record.id);
});

test("cancel heals an orphaned run without returning not-running", () => {
  const record = makeRunningRecord("orphaned-cancel");
  sessionState.records.set(record);

  assert.equal(sessions.cancel(record.id), true);
  assert.equal(record.status, "completed");
  assert.match(record.outcome?.summary ?? "", new RegExp(ORPHANED_RUN_MARKER));
  cleanup(record.id);
});

test("list and page heal orphaned records before exposing them", () => {
  const listRecord = makeRunningRecord("orphaned-list");
  const pageRecord = makeRunningRecord("orphaned-page");
  sessionState.records.set(listRecord);
  assert.equal(sessions.list().find(({ id }) => id === listRecord.id)?.status, "completed");

  sessionState.records.set(pageRecord);
  assert.equal(sessions.page({ limit: 100 }).sessions.find(({ id }) => id === pageRecord.id)?.status, "completed");
  cleanup(listRecord.id);
  cleanup(pageRecord.id);
});

test("read reconciliation leaves live and pending runs untouched", () => {
  const live = makeRunningRecord("live-read");
  const resumePending = makeRunningRecord("resume-pending-read");
  const steerPending = makeRunningRecord("steer-pending-read");
  const run: AgentRun = { emitter: new EventEmitter(), kill() {} };
  sessionState.records.set(live);
  sessionState.records.set(resumePending);
  sessionState.records.set(steerPending);
  sessionState.activeRuns.set(live.id, run);
  sessionState.resumePending.add(resumePending.id);
  sessionState.steerPending.add(steerPending.id);

  assert.equal(sessions.get(live.id)?.status, "running");
  assert.equal(sessions.get(resumePending.id)?.status, "running");
  assert.equal(sessions.get(steerPending.id)?.status, "running");
  assert.equal(sessions.activeCount(), 2);

  cleanup(live.id);
  cleanup(resumePending.id);
  cleanup(steerPending.id);
});
