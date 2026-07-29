import assert from "node:assert/strict";
import test from "node:test";
import { statsForPeriod } from "../sessionStats.js";
import type { SessionRecord } from "../sessionTypes.js";

function usageRecord(
  id: string,
  agent: SessionRecord["agent"],
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    durationMs: number;
    totalCostUsd: number;
  },
): SessionRecord {
  return {
    id,
    agent,
    startedAt: Date.now() - 1_000,
    status: "completed",
    outcome: { result: "success", summary: "done" },
    usage,
    usageByModel: { "gpt-5.4": usage },
  } as SessionRecord;
}

test("stats expose canonical Codex providers and merge runtime aliases", () => {
  const appServer = usageRecord("app-server", "codex-app-server", {
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationInputTokens: 5,
    cacheReadInputTokens: 10,
    durationMs: 1_500,
    totalCostUsd: 0.12,
  });
  const legacy = usageRecord("legacy", "codex", {
    inputTokens: 40,
    outputTokens: 8,
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 4,
    durationMs: 500,
    totalCostUsd: 0.03,
  });

  const stats = statsForPeriod([appServer, legacy], "day");

  assert.deepEqual(stats.byModel, [{
    agent: "codex",
    model: "gpt-5.4",
    sessionCount: 2,
    inputTokens: 140,
    outputTokens: 28,
    cacheCreationTokens: 7,
    cacheReadTokens: 14,
    totalTokens: 168,
    processedTokens: 168,
    totalDurationMs: 2_000,
    totalCostUsd: 0.15,
  }]);
  assert.equal(stats.byModel.some((row) => row.agent === "codex-app-server"), false);
});

test("stats preserve the public Claude Code provider id", () => {
  const claude = usageRecord("claude", "claude-code", {
    inputTokens: 12,
    outputTokens: 3,
    cacheCreationInputTokens: 1,
    cacheReadInputTokens: 2,
    durationMs: 250,
    totalCostUsd: 0.02,
  });

  assert.equal(statsForPeriod([claude], "day").byModel[0]?.agent, "claude-code");
});
