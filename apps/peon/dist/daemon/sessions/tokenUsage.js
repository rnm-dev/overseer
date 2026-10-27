import { agentServiceName, getAgentServiceDriver } from "../agents/index.js";
export const TOKEN_USAGE_SEMANTICS_VERSION = 1;
// Usage is attributed to the driver's service name, so sessions from the
// retired `codex` exec driver and from `codex-app-server` aggregate together.
export function canonicalUsageProvider(agent) {
    const driver = getAgentServiceDriver(agent);
    return driver ? agentServiceName(driver) : agent;
}
function token(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/**
 * Normalize provider usage without changing the persisted raw provider fields.
 *
 * The driver declares whether its cache counts are disjoint from input
 * (Claude) or a subset of it (Codex); a subset must be subtracted from input
 * when producing mutually exclusive canonical buckets.
 */
export function normalizeTokenUsage(agent, usage, onDiagnostic) {
    const provider = canonicalUsageProvider(agent);
    const cacheIncludedInInput = getAgentServiceDriver(agent)?.tokenUsage.cacheIncludedInInput ?? false;
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
    if (cacheIncludedInInput) {
        const includedCacheRead = cacheRead ?? 0;
        const includedCacheWrite = cacheWrite ?? 0;
        if (input === null || includedCacheRead + includedCacheWrite > input) {
            onDiagnostic?.({
                provider,
                reason: input !== null && includedCacheRead + includedCacheWrite > input
                    ? "overlapping_codex_cache"
                    : "missing_token_usage",
            });
            return null;
        }
        const uncachedInputTokens = input - includedCacheRead - includedCacheWrite;
        const cachedInputTokens = includedCacheRead;
        const outputTokens = output ?? 0;
        return {
            semanticsVersion: TOKEN_USAGE_SEMANTICS_VERSION,
            provider,
            uncachedInputTokens,
            cachedInputTokens,
            cacheWriteInputTokens: includedCacheWrite,
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
