import assert from "node:assert/strict";
import { type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import type { SessionRecord, SessionUsage } from "../sessions/sessionTypes.js";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-stats-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-stats-state-"));

const { settings } = await import("../settings/index.js");
const { sessions } = await import("../sessions/index.js");
const { sessionsDir, summaryPath } = await import("../sessions/sessionArtifacts.js");
const { createAgentRouter } = await import("../agentApi.js");

const token = "pn_stats_test";
settings.update({ overseerToken: token });

function usage(
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens: number,
  cacheReadInputTokens: number,
  durationMs: number,
  totalCostUsd: number,
): SessionUsage {
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    durationMs,
    totalCostUsd,
  };
}

function recordedSession(
  id: string,
  agent: "claude-code" | "codex" | "codex-app-server",
  model: string,
  recordedUsage: SessionUsage,
): SessionRecord {
  const now = Date.now();
  return {
    id,
    prompt: "record usage",
    title: null,
    followUpPrompts: [],
    queuedFollowUps: [],
    pendingSystemPrompts: [],
    dir: os.tmpdir(),
    agent,
    backendSessionId: null,
    backendTurnId: null,
    backendRuntimeGeneration: null,
    backendTurnStatus: "completed",
    model,
    reasoningEffort: null,
    projectId: null,
    projectKey: null,
    candidateProjectKeys: [],
    taskKey: null,
    taskTitle: null,
    initiator: null,
    expectsOutcome: false,
    status: "completed",
    outcome: { result: "success", summary: "done" },
    startedAt: now,
    endedAt: now,
    turnCount: 1,
    turnBudget: 1,
    usage: recordedUsage,
    usageByModel: { [model]: recordedUsage },
    contextUsage: null,
    autoResumeAttempts: 0,
    lastActivityAt: now,
    lastUserMessageAt: now,
    lastMessagePreview: null,
    eventCount: 0,
  };
}

mkdirSync(sessionsDir, { recursive: true });
const appServerUsage = usage(100, 20, 5, 50, 1_000, 0.25);
const legacyUsage = usage(40, 10, 3, 7, 500, 0.10);
for (const record of [
  recordedSession("stats-app-server", "codex-app-server", "gpt-5.4", appServerUsage),
  recordedSession("stats-legacy", "codex", "gpt-5.4", legacyUsage),
  recordedSession("stats-claude", "claude-code", "claude-sonnet-5", usage(0, 0, 0, 0, 0, 0)),
]) {
  writeFileSync(summaryPath(record.id), JSON.stringify(record));
}
sessions.restoreFromDisk();

const app = express();
app.use("/api/v1", createAgentRouter());
const api: Server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => api.once("listening", resolve));
const address = api.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}/api/v1`;

test.after(async () => {
  api.closeAllConnections();
  await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
});

test("GET /stats emits and groups Codex usage under the canonical provider id", async () => {
  const response = await fetch(`${base}/stats?period=day`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);

  const body = await response.json() as {
    sessionCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheCreationTokens: number;
    totalCacheReadTokens: number;
    totalTokens: number;
    processedTokens: number;
    totalDurationMs: number;
    totalCostUsd: number;
    byModel: Array<{
      agent: string;
      model: string;
      sessionCount: number;
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      totalTokens: number;
      processedTokens: number;
      totalDurationMs: number;
      totalCostUsd: number;
    }>;
  };

  assert.equal(body.sessionCount, 3);
  assert.equal(body.totalInputTokens, 75);
  assert.equal(body.totalOutputTokens, 30);
  assert.equal(body.totalCacheCreationTokens, 8);
  assert.equal(body.totalCacheReadTokens, 57);
  assert.equal(body.totalTokens, 170);
  assert.equal(body.processedTokens, 170);
  assert.equal(body.totalDurationMs, 1_500);
  assert.ok(Math.abs(body.totalCostUsd - 0.35) < Number.EPSILON);

  assert.equal(body.byModel.some((row) => row.agent === "codex-app-server"), false);
  const codex = body.byModel.find((row) => row.agent === "codex");
  assert.ok(codex);
  const { totalCostUsd, ...codexWithoutCost } = codex;
  assert.deepEqual(codexWithoutCost, {
    agent: "codex",
    model: "gpt-5.4",
    sessionCount: 2,
    inputTokens: 75,
    outputTokens: 30,
    cacheCreationTokens: 8,
    cacheReadTokens: 57,
    totalTokens: 170,
    processedTokens: 170,
    totalDurationMs: 1_500,
    usagePartialTurns: 0,
    usageLegacyTurns: 2,
    cacheBreakdownComplete: true,
    reasoningOutputTokens: null,
  });
  assert.ok(Math.abs(totalCostUsd - 0.35) < Number.EPSILON);
  assert.equal(body.byModel.find((row) => row.model === "claude-sonnet-5")?.agent, "claude-code");
});
