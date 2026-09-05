export const TOKEN_USAGE_SEMANTICS_VERSION = 1;
const CODEX_AGENTS = new Set(["codex", "codex-app-server"]);
export function canonicalUsageProvider(agent) {
    return CODEX_AGENTS.has(agent) ? "codex" : agent;
}
function token(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/**
 * Normalize provider usage without changing the persisted raw provider fields.
 *
 * Claude reports uncached input, cache writes, and cache reads as disjoint
 * categories. Codex reports cached input as a subset of input, so it must be
 * subtracted from input when producing mutually exclusive canonical buckets.
 */
export function normalizeTokenUsage(agent, usage, onDiagnostic) {
    const provider = canonicalUsageProvider(agent);
    if (!usage) {
        onDiagnostic?.({ provider, reason: "missing_token_usage" });
        return null;
    }
    const input = token(usage.inputTokens);
    const output = token(usage.outputTokens);
    const cacheWrite = token(usage.cacheCreationInputTokens);
    const cacheRead = token(usage.cacheReadInputTokens);
    const supplied = [
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationInputTokens,
        usage.cacheReadInputTokens,
    ].filter((value) => value !== null && value !== undefined);
    if (supplied.length === 0) {
        onDiagnostic?.({ provider, reason: "missing_token_usage" });
        return null;
    }
    if (supplied.some((value) => token(value) === null)) {
        onDiagnostic?.({ provider, reason: "invalid_token_usage" });
        return null;
    }
    if (provider === "codex") {
        const codexCachedInput = cacheRead ?? 0;
        const codexCacheWrite = cacheWrite ?? 0;
        if (input === null || codexCachedInput + codexCacheWrite > input) {
            onDiagnostic?.({
                provider,
                reason: input !== null && codexCachedInput + codexCacheWrite > input
                    ? "overlapping_codex_cache"
                    : "missing_token_usage",
            });
            return null;
        }
        const uncachedInputTokens = input - codexCachedInput - codexCacheWrite;
        const cachedInputTokens = codexCachedInput;
        const outputTokens = output ?? 0;
        return {
            semanticsVersion: TOKEN_USAGE_SEMANTICS_VERSION,
            provider,
            uncachedInputTokens,
            cachedInputTokens,
            cacheWriteInputTokens: codexCacheWrite,
            outputTokens,
            processedTokens: input + outputTokens,
        };
    }
    const uncachedInputTokens = input ?? 0;
    const cachedInputTokens = cacheRead ?? 0;
    const cacheWriteInputTokens = cacheWrite ?? 0;
    const outputTokens = output ?? 0;
    return {
        semanticsVersion: TOKEN_USAGE_SEMANTICS_VERSION,
        provider,
        uncachedInputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        outputTokens,
        processedTokens: uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens + outputTokens,
    };
}
