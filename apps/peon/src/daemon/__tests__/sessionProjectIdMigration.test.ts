import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const configRoot = mkdtempSync(path.join(os.tmpdir(), "peon-session-project-id-config-"));
const stateRoot = mkdtempSync(path.join(os.tmpdir(), "peon-session-project-id-state-"));
process.env.XDG_CONFIG_HOME = configRoot;
process.env.XDG_STATE_HOME = stateRoot;

const projectId = "5421fcc7-c71f-49cc-b7d6-bf8e9487b12f";
const projectDir = mkdtempSync(path.join(os.tmpdir(), "peon-session-project-id-project-"));

// xdgPaths appends `.peon`; prepare the legacy-compatible project store before
// importing either singleton so session restoration can resolve its identity.
const { configDir } = await import("../xdgPaths.js");
mkdirSync(configDir(), { recursive: true });
writeFileSync(path.join(configDir(), "projects.json"), JSON.stringify({
  projects: {
    expo: { projectId, key: "expo", label: "Expo", dir: projectDir, metadata: null, lastSyncedAt: 1 },
  },
}));

const { sessionsDir } = await import("../sessions/sessionArtifacts.js");
const { sessions } = await import("../sessions/index.js");

test("legacy stored sessions backfill project identity and safe root-orchestration defaults", () => {
  mkdirSync(sessionsDir, { recursive: true });
  const summaryPath = path.join(sessionsDir, "legacy-project-session.summary.json");
  const now = Date.now();
  writeFileSync(summaryPath, JSON.stringify({
    id: "legacy-project-session",
    prompt: "legacy",
    title: null,
    followUpPrompts: [],
    queuedFollowUps: [],
    dir: projectDir,
    agent: "codex",
    backendSessionId: null,
    model: null,
    reasoningEffort: null,
    projectKey: "expo",
    candidateProjectKeys: [],
    taskKey: null,
    taskTitle: null,
    initiator: null,
    expectsOutcome: false,
    status: "completed",
    outcome: null,
    startedAt: now,
    endedAt: now,
    turnCount: 0,
    turnBudget: 0,
    usage: null,
    usageByModel: {},
    autoResumeAttempts: 0,
    lastActivityAt: now,
    lastUserMessageAt: now,
    lastMessagePreview: null,
    eventCount: 0,
  }));

  sessions.restoreFromDisk();
  const restored = sessions.get("legacy-project-session")!;
  assert.equal(restored.projectId, projectId);
  assert.equal(restored.parentSessionId, null);
  assert.equal(restored.spawnDepth, 0);
  assert.equal(restored.spawnRequestId, null);
  assert.equal(restored.parentCompletionNotifiedAt, null);
  assert.deepEqual(restored.pendingSystemPrompts, []);
  const persisted = JSON.parse(readFileSync(summaryPath, "utf8"));
  assert.equal(persisted.projectId, projectId);
  assert.equal(persisted.parentSessionId, null);
  assert.equal(persisted.spawnDepth, 0);
  assert.equal(persisted.spawnRequestId, null);
  assert.equal(persisted.parentCompletionNotifiedAt, null);
  assert.deepEqual(persisted.pendingSystemPrompts, []);
});
