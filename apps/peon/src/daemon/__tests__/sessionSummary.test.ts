import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { toSessionSummary } from "../sessionSummary.js";
import type { SessionRecord } from "../sessionTypes.js";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "summary-test",
    prompt: `  ${"large detail ".repeat(2_000)}  `,
    title: null,
    followUpPrompts: ["detail-only follow-up"],
    queuedFollowUps: [],
    pendingSystemPrompts: [],
    dir: os.tmpdir(),
    agent: "codex",
    backendSessionId: "backend-thread",
    model: "gpt-test",
    reasoningEffort: "high",
    projectId: "project-id",
    projectKey: "project-key",
    candidateProjectKeys: ["candidate"],
    taskKey: "TASK-1",
    taskTitle: "Detail task title",
    initiator: "owner@example.com",
    expectsOutcome: true,
    status: "completed",
    outcome: { result: "success", summary: "Done", previewPath: null },
    startedAt: 10,
    endedAt: 20,
    turnCount: 2,
    turnBudget: 4,
    usage: null,
    usageByModel: {},
    autoResumeAttempts: 0,
    lastActivityAt: 21,
    lastUserMessageAt: 15,
    lastMessagePreview: "Latest message",
    eventCount: 99,
    ...overrides,
  };
}

test("canonical session summary includes only bounded collection fields", () => {
  const full = record();
  const summary = toSessionSummary(full);

  assert.deepEqual(Object.keys(summary), [
    "id",
    "status",
    "projectKey",
    "projectId",
    "title",
    "promptPreview",
    "lastMessagePreview",
    "initiator",
    "outcome",
    "startedAt",
    "endedAt",
    "lastActivityAt",
  ]);
  assert.equal(summary.promptPreview?.length, 280);
  assert.equal("prompt" in summary, false);
  assert.equal("dir" in summary, false);
  assert.equal("usage" in summary, false);
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 10);
});

test("titled summaries do not duplicate prompt content", () => {
  assert.equal(toSessionSummary(record({ title: "Human title" })).promptPreview, null);
});

test("all collection-facing free text remains bounded for legacy records", () => {
  const oversized = "x".repeat(10_000);
  const summary = toSessionSummary(record({
    title: oversized,
    lastMessagePreview: oversized,
    initiator: oversized,
    outcome: { result: "success", summary: oversized, previewPath: oversized },
  }));
  assert.equal(summary.title?.length, 280);
  assert.equal(summary.lastMessagePreview?.length, 280);
  assert.equal(summary.initiator?.length, 280);
  assert.equal(summary.outcome?.summary.length, 280);
  assert.equal(summary.outcome?.previewPath?.length, 280);
});
