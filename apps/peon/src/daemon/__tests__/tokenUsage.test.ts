import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTokenUsage,
  TOKEN_USAGE_SEMANTICS_VERSION,
  type TokenUsageDiagnostic,
} from "../sessions/tokenUsage.js";
import type { SessionUsage } from "../sessions/sessionTypes.js";

function usage(
  inputTokens: number | null,
  outputTokens: number | null,
  cacheCreationInputTokens: number | null,
  cacheReadInputTokens: number | null,
): SessionUsage {
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    durationMs: null,
    totalCostUsd: null,
  };
}

test("Codex cached input is a subset of input for both drivers", () => {
  for (const provider of ["codex", "codex-app-server"] as const) {
    assert.deepEqual(normalizeTokenUsage(provider, usage(100, 20, null, 80)), {
      semanticsVersion: TOKEN_USAGE_SEMANTICS_VERSION,
      provider: "codex",
      uncachedInputTokens: 20,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 0,
      outputTokens: 20,
      processedTokens: 120,
    });
  }
});

test("uncached legacy Codex usage remains available", () => {
  assert.equal(normalizeTokenUsage("codex", usage(100, 20, null, null))?.processedTokens, 120);
});

test("Claude cache categories are disjoint", () => {
  assert.deepEqual(normalizeTokenUsage("claude-code", usage(20, 20, 10, 70)), {
    semanticsVersion: TOKEN_USAGE_SEMANTICS_VERSION,
    provider: "claude-code",
    uncachedInputTokens: 20,
    cachedInputTokens: 70,
    cacheWriteInputTokens: 10,
    outputTokens: 20,
    processedTokens: 120,
  });
});

test("missing and malformed usage are unavailable rather than fabricated zero", () => {
  const diagnostics: TokenUsageDiagnostic[] = [];
  assert.equal(normalizeTokenUsage("codex", usage(null, null, null, null), (item) => diagnostics.push(item)), null);
  assert.equal(normalizeTokenUsage("codex-app-server", usage(10, 1, null, 20), (item) => diagnostics.push(item)), null);
  assert.deepEqual(diagnostics.map(({ reason }) => reason), [
    "missing_token_usage",
    "overlapping_codex_cache",
  ]);
});
