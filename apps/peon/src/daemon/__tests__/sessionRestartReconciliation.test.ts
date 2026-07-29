import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-reconcile-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-reconcile-state-"));

const { appendTranscriptEvent, readTranscript, summaryPath } = await import("../sessions/sessionArtifacts.js");
const { sessions, RESTART_INTERRUPTION_MARKER } = await import("../sessions/index.js");

test("restore trusts a committed terminal transcript event over a stale running summary", () => {
  const id = "terminal-summary-crash-race";
  const now = Date.now();
  const summary = {
    id, prompt: "first", title: null, followUpPrompts: [], queuedFollowUps: [], pendingSystemPrompts: [], dir: os.tmpdir(),
    agent: "codex-app-server", backendSessionId: "thread-1", backendTurnId: null,
    backendRuntimeGeneration: null, backendTurnStatus: null, model: null, reasoningEffort: null,
    projectId: null, projectKey: null, candidateProjectKeys: [], taskKey: null, taskTitle: null,
    initiator: null, expectsOutcome: false, status: "running", outcome: null, startedAt: now,
    endedAt: null, turnCount: 0, turnBudget: 10, usage: null, usageByModel: {}, autoResumeAttempts: 0,
    lastActivityAt: now, lastUserMessageAt: now, lastMessagePreview: "first", eventCount: 2,
  };
  mkdirSync(path.dirname(summaryPath(id)), { recursive: true });
  writeFileSync(summaryPath(id), JSON.stringify(summary));
  appendTranscriptEvent(id, { type: "user_message", text: "first" });
  appendTranscriptEvent(id, {
    type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1,
    backend_turn_id: "turn-1", backend_turn_status: "completed", runtime_generation: 7,
  });

  sessions.restoreFromDisk();

  const restored = sessions.get(id)!;
  assert.equal(restored.status, "completed");
  assert.equal(restored.outcome, null);
  assert.equal(restored.backendTurnId, "turn-1");
  assert.equal(restored.backendRuntimeGeneration, 7);
  assert.equal(restored.backendTurnStatus, "completed");
  assert.equal(restored.turnCount, 1);
  assert.equal(JSON.stringify(restored).includes(RESTART_INTERRUPTION_MARKER), false);
  assert.deepEqual(readTranscript(id, "codex-app-server").map((event) => event.type), ["user_message", "result"]);
});
