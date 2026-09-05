import assert from "node:assert/strict";
import test from "node:test";
import { CodexUsageAccumulator } from "../agents/codexUsage.js";
import { claudeResultUsage, ClaudeInputAccumulator } from "../agents/claudeUsage.js";
import { getAgentDriver } from "../agents/index.js";
import { addUsage, usageFromEvent } from "../sessions/usageAccounting.js";

const counts = (inputTokens: number, outputTokens: number, cachedInputTokens = 0) =>
  ({ inputTokens, outputTokens, cachedInputTokens, totalTokens: inputTokens + outputTokens });

test("Codex accumulates requests, ignores replay and excludes resumed history", () => {
  const accumulator = new CodexUsageAccumulator();
  accumulator.observe({ total: counts(1_026_254, 1_088), last: counts(26_254, 88) }, "model-a");
  const update = { total: counts(1_056_556, 1_460, 26_112), last: counts(30_302, 372, 26_112) };
  accumulator.observe(update, "model-b");
  assert.equal(accumulator.observe(update, "model-b"), false);
  assert.deepEqual(accumulator.report(true).usage, { input_tokens: 56_556, output_tokens: 460, cache_read_input_tokens: 26_112 });
  assert.equal(accumulator.report(true).usage_quality, "reported");
  assert.deepEqual(Object.keys(accumulator.report().usage_by_model as object), ["model-a", "model-b"]);
});

test("Codex resets retain only observed work and downgrade quality", () => {
  const accumulator = new CodexUsageAccumulator();
  accumulator.observe({ total: counts(100, 10), last: counts(100, 10) }, "model");
  accumulator.observe({ total: counts(20, 2), last: counts(20, 2) }, "model");
  assert.equal((accumulator.report().usage as Record<string, number>).input_tokens, 120);
  assert.equal(accumulator.report(true).usage_quality, "partial");
});

test("Codex missing cumulative counters never multiply identical notifications", () => {
  const accumulator = new CodexUsageAccumulator();
  accumulator.observe({ last: counts(100, 10) }, "model");
  accumulator.observe({ last: counts(100, 10) }, "model");
  assert.equal((accumulator.report().usage as Record<string, number>).input_tokens, 100);
  assert.equal(accumulator.report(true).usage_quality, "partial");
});

test("Claude whole-tree modelUsage replaces rather than adds main-loop usage", () => {
  const report = claudeResultUsage({ usage: { input_tokens: 999 }, modelUsage: {
    opus: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 30, costUSD: 0.2 },
    haiku: { inputTokens: 5, outputTokens: 6, cacheReadInputTokens: 7, cacheCreationInputTokens: 8, costUSD: 0.01 },
  } });
  assert.deepEqual(report.usage, { input_tokens: 15, output_tokens: 26, cache_creation_input_tokens: 38, cache_read_input_tokens: 107 });
  assert.equal(report.usage_quality, "reported");
  const stored = { type: "result", ...report, usage_run_id: "run-1", usage_session_id: "session-1", createdAt: 123 };
  assert.deepEqual(getAgentDriver("claude-code")!.normalizeStoredEvent(stored), stored);
});

test("Claude recovery deduplicates response IDs, excludes subagents and placeholder output", () => {
  const accumulator = new ClaudeInputAccumulator();
  const message = { type: "assistant", message: { id: "response-1", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100 } } };
  assert.equal(accumulator.observe(message), true);
  assert.equal(accumulator.observe(message), false);
  assert.equal(accumulator.observe({ ...message, parent_tool_use_id: "tool-1" }), false);
  assert.deepEqual(accumulator.report().usage, { input_tokens: 10, cache_read_input_tokens: 100 });
  assert.equal(accumulator.report().usage_quality, "partial");
});

test("unknown cost and token components remain unknown, not fabricated zero", () => {
  const partial = usageFromEvent({ type: "result", usage: { input_tokens: 10 }, usage_quality: "partial" });
  const total = addUsage(partial, partial);
  assert.equal(total.inputTokens, 20);
  assert.equal(total.outputTokens, null);
  assert.equal(total.totalCostUsd, null);
  assert.equal(total.quality, "partial");
});
