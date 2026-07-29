import { canonicalUsageProvider, normalizeTokenUsage, TOKEN_USAGE_SEMANTICS_VERSION, } from "./tokenUsage.js";
// Calendar windows in local server time: day/yesterday are midnight-bounded,
// week starts Monday, and month starts on the first.
function periodRange(period) {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const todayStart = midnight.getTime();
    switch (period) {
        case "day": return { start: todayStart, end: now.getTime() };
        case "yesterday": return { start: todayStart - 86_400_000, end: todayStart };
        case "week": {
            const mondayOffset = (midnight.getDay() + 6) % 7;
            return { start: todayStart - mondayOffset * 86_400_000, end: now.getTime() };
        }
        case "month":
            return { start: new Date(midnight.getFullYear(), midnight.getMonth(), 1).getTime(), end: now.getTime() };
    }
}
export function statsForPeriod(records, period, sessionsSizeBytes = 0) {
    const { start, end } = periodRange(period);
    const stats = {
        semanticsVersion: TOKEN_USAGE_SEMANTICS_VERSION,
        period,
        rangeStart: start,
        rangeEnd: end,
        sessionsSizeBytes,
        sessionCount: 0,
        outcomeCounts: { success: 0, failure: 0, needs_human: 0, none: 0, running: 0 },
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalTokens: 0,
        processedTokens: 0,
        totalDurationMs: 0,
        totalCostUsd: 0,
        sessionsWithUsage: 0,
        sessionsMissingUsage: 0,
        usageCoveragePercent: 0,
        usageRejections: {},
        byModel: [],
    };
    const byModel = new Map();
    for (const record of records) {
        if (record.startedAt < start || record.startedAt >= end)
            continue;
        stats.sessionCount += 1;
        for (const [model, usage] of Object.entries(record.usageByModel ?? {})) {
            const agent = canonicalUsageProvider(record.agent);
            const key = `${agent}\0${model}`;
            const row = byModel.get(key) ?? {
                agent,
                model,
                sessionCount: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                totalTokens: 0,
                processedTokens: 0,
                totalDurationMs: 0,
                totalCostUsd: 0,
            };
            row.sessionCount += 1;
            row.inputTokens += usage.inputTokens ?? 0;
            row.outputTokens += usage.outputTokens ?? 0;
            row.cacheCreationTokens += usage.cacheCreationInputTokens ?? 0;
            row.cacheReadTokens += usage.cacheReadInputTokens ?? 0;
            const canonical = normalizeTokenUsage(record.agent, usage);
            if (canonical) {
                row.totalTokens += canonical.processedTokens;
                row.processedTokens += canonical.processedTokens;
            }
            row.totalDurationMs += usage.durationMs ?? 0;
            row.totalCostUsd += usage.totalCostUsd ?? 0;
            byModel.set(key, row);
        }
        if (record.status === "running")
            stats.outcomeCounts.running += 1;
        else if (record.outcome === null)
            stats.outcomeCounts.none += 1;
        else
            stats.outcomeCounts[record.outcome.result] += 1;
        const canonical = normalizeTokenUsage(record.agent, record.usage, ({ reason }) => {
            stats.usageRejections[reason] = (stats.usageRejections[reason] ?? 0) + 1;
        });
        if (!canonical) {
            stats.sessionsMissingUsage += 1;
            continue;
        }
        stats.sessionsWithUsage += 1;
        const usage = record.usage;
        if (usage.inputTokens !== null) {
            stats.totalInputTokens += usage.inputTokens;
        }
        if (usage.outputTokens !== null) {
            stats.totalOutputTokens += usage.outputTokens;
        }
        if (usage.cacheCreationInputTokens !== null) {
            stats.totalCacheCreationTokens += usage.cacheCreationInputTokens;
        }
        if (usage.cacheReadInputTokens !== null) {
            stats.totalCacheReadTokens += usage.cacheReadInputTokens;
        }
        if (usage.durationMs !== null)
            stats.totalDurationMs += usage.durationMs;
        if (usage.totalCostUsd !== null)
            stats.totalCostUsd += usage.totalCostUsd;
        stats.processedTokens += canonical.processedTokens;
        stats.totalTokens += canonical.processedTokens;
    }
    stats.usageCoveragePercent = stats.sessionCount === 0
        ? 0
        : (stats.sessionsWithUsage / stats.sessionCount) * 100;
    stats.byModel = [...byModel.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.totalTokens - a.totalTokens);
    return stats;
}
