import type { SessionRecord, SessionStats, StatsPeriod } from "./sessionTypes.js";
import { canonicalUsageProvider } from "./tokenUsage.js";
import { analyticsForSessions, parseSessionAnalyticsQuery } from "./sessionAnalytics.js";

// One time authority and accounting path for headline, provider and user/project
// panels. Session-shaped metrics still describe sessions started in this window.
export function statsForPeriod(
  records: Iterable<SessionRecord>,
  period: StatsPeriod,
  sessionsSizeBytes = 0,
  now = Date.now(),
  transcriptReader?: Parameters<typeof analyticsForSessions>[4],
): SessionStats {
  const query = parseSessionAnalyticsQuery({ period, groupBy: "agent,model" }, now);
  const analytics = analyticsForSessions(records, query, { totalBytes: sessionsSizeBytes, bySessionId: new Map() }, now, transcriptReader);
  const totals = analytics.totals;
  return {
    semanticsVersion: analytics.semanticsVersion, period,
    rangeStart: query.from, rangeEnd: query.to, timeZone: "UTC",
    sessionsSizeBytes, sessionCount: totals.sessionCount,
    outcomeCounts: { success: totals.successCount, failure: totals.failureCount,
      needs_human: totals.needsHumanCount, none: Math.max(0, totals.noOutcomeCount - totals.runningCount), running: totals.runningCount },
    totalInputTokens: totals.uncachedInputTokens,
    totalOutputTokens: totals.outputTokens, totalCacheCreationTokens: totals.cacheWriteInputTokens,
    totalCacheReadTokens: totals.cachedInputTokens,
    processedTokens: totals.processedTokens, totalTokens: totals.processedTokens,
    totalDurationMs: totals.providerDurationMs, totalCostUsd: totals.totalCostUsd,
    sessionsWithUsage: totals.sessionsWithUsage, sessionsMissingUsage: totals.sessionsMissingUsage,
    usageCoveragePercent: totals.usageCoveragePercent, usageRejections: totals.usageRejections,
    usagePartialTurns: totals.usagePartialTurns, usageLegacyTurns: totals.usageLegacyTurns,
    attributionQuality: totals.attributionQuality,
    byModel: analytics.rows.filter((row) => row.sessionCount > 0 || row.processedTokens > 0 || row.providerDurationMs > 0 || row.totalCostUsd > 0).map((row) => ({
      agent: canonicalUsageProvider(row.agent!), model: row.model ?? "unknown", sessionCount: row.sessionCount,
      inputTokens: row.uncachedInputTokens, outputTokens: row.outputTokens,
      cacheCreationTokens: row.cacheWriteInputTokens, cacheReadTokens: row.cachedInputTokens,
      totalTokens: row.processedTokens, processedTokens: row.processedTokens,
      totalDurationMs: row.providerDurationMs, totalCostUsd: row.totalCostUsd,
      usagePartialTurns: row.usagePartialTurns, usageLegacyTurns: row.usageLegacyTurns,
      cacheBreakdownComplete: row.cacheBreakdownComplete, reasoningOutputTokens: row.reasoningOutputTokens,
    })).sort((a, b) => b.totalTokens - a.totalTokens),
  };
}
