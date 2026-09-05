export const usageNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export function usageFromEvent(event) {
    const raw = event.usage;
    return {
        totalCostUsd: usageNumber(event.total_cost_usd), durationMs: usageNumber(event.duration_ms),
        inputTokens: usageNumber(raw?.input_tokens), outputTokens: usageNumber(raw?.output_tokens),
        cacheCreationInputTokens: usageNumber(raw?.cache_creation_input_tokens),
        cacheReadInputTokens: usageNumber(raw?.cache_read_input_tokens),
        reasoningOutputTokens: usageNumber(raw?.reasoning_output_tokens),
        quality: event.usage_quality === "reported" ? "reported" : event.usage_quality === "partial" ? "partial" : "legacy",
        source: typeof event.usage_source === "string" ? event.usage_source : "legacy-result",
    };
}
export function usageModelsFromEvent(event) {
    if (!event.usage_by_model || typeof event.usage_by_model !== "object")
        return undefined;
    const rows = Object.entries(event.usage_by_model).filter(([, value]) => value && typeof value === "object");
    if (!rows.length)
        return undefined;
    return Object.fromEntries(rows.map(([model, raw]) => [model, usageFromEvent({
            type: "result", usage: raw, usage_quality: event.usage_quality, usage_source: event.usage_source,
            total_cost_usd: raw.cost_usd,
        })]));
}
export function addUsage(acc, add) {
    const sum = (a, b) => a == null && b == null ? null : (a ?? 0) + (b ?? 0);
    return {
        totalCostUsd: sum(acc?.totalCostUsd, add.totalCostUsd), durationMs: sum(acc?.durationMs, add.durationMs),
        inputTokens: sum(acc?.inputTokens, add.inputTokens), outputTokens: sum(acc?.outputTokens, add.outputTokens),
        cacheCreationInputTokens: sum(acc?.cacheCreationInputTokens, add.cacheCreationInputTokens),
        cacheReadInputTokens: sum(acc?.cacheReadInputTokens, add.cacheReadInputTokens),
        reasoningOutputTokens: sum(acc?.reasoningOutputTokens, add.reasoningOutputTokens),
        quality: add.quality === "partial" || acc?.quality === "partial" ? "partial"
            : add.quality === "reported" && (!acc || acc.quality === "reported") ? "reported" : "legacy",
        source: acc && acc.source !== add.source ? "mixed" : add.source,
    };
}
export function accumulateUsage(record, usage, model, models) {
    record.usage = addUsage(record.usage, usage);
    record.usageByModel ??= {};
    for (const [key, value] of Object.entries(models ?? { [model || "unknown"]: usage })) {
        record.usageByModel[key] = addUsage(record.usageByModel[key], value);
    }
}
