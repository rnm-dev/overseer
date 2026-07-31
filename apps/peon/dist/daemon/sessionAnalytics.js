import { listAgentDrivers } from "./agents/index.js";
import { ensurePeonId } from "./peonIdentity.js";
import { normalizeTokenUsage, TOKEN_USAGE_SEMANTICS_VERSION } from "./tokenUsage.js";
import { readTranscript } from "./sessions/index.js";
export const ANALYTICS_DIMENSIONS = ["user", "project", "time", "agent", "model", "status", "outcome"];
export const ANALYTICS_TIME_BUCKETS = ["hour", "day", "week", "month"];
export const ANALYTICS_PERIODS = ["day", "yesterday", "week", "month", "all"];
export class SessionAnalyticsQueryError extends Error {
    code = "BAD_ANALYTICS_QUERY";
}
function one(value, name) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !value.trim())
        throw new SessionAnalyticsQueryError(`${name} must be a non-empty string`);
    return value.trim();
}
function values(value, name) {
    if (value === undefined)
        return undefined;
    const raw = Array.isArray(value) ? value : [value];
    if (raw.some((item) => typeof item !== "string"))
        throw new SessionAnalyticsQueryError(`${name} must contain strings`);
    const parsed = raw.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
    if (parsed.length === 0)
        throw new SessionAnalyticsQueryError(`${name} must contain at least one value`);
    return [...new Set(parsed)];
}
function enumValues(value, name, allowed) {
    const parsed = values(value, name);
    if (!parsed)
        return undefined;
    for (const item of parsed) {
        if (!allowed.includes(item))
            throw new SessionAnalyticsQueryError(`${name} contains invalid value "${item}" (expected ${allowed.join(", ")})`);
    }
    return parsed;
}
function timestamp(value, name) {
    const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isFinite(new Date(parsed).getTime())) {
        throw new SessionAnalyticsQueryError(`${name} must be an ISO timestamp or non-negative epoch milliseconds`);
    }
    return parsed;
}
function periodRange(period, now) {
    if (period === "all")
        return { from: 0, to: now };
    const date = new Date(now);
    const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    if (period === "day")
        return { from: today, to: now };
    if (period === "yesterday")
        return { from: today - 86_400_000, to: today };
    if (period === "week") {
        const mondayOffset = (new Date(today).getUTCDay() + 6) % 7;
        return { from: today - mondayOffset * 86_400_000, to: now };
    }
    return { from: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), to: now };
}
export function parseSessionAnalyticsQuery(query, now = Date.now()) {
    const fromRaw = one(query.from, "from");
    const toRaw = one(query.to, "to");
    const periodRaw = one(query.period, "period");
    if ((fromRaw || toRaw) && periodRaw)
        throw new SessionAnalyticsQueryError("period cannot be combined with from or to");
    const period = periodRaw ?? (!fromRaw && !toRaw ? "month" : null);
    if (period && !ANALYTICS_PERIODS.includes(period)) {
        throw new SessionAnalyticsQueryError(`period must be one of ${ANALYTICS_PERIODS.join(", ")}`);
    }
    const range = period ? periodRange(period, now) : {
        from: fromRaw ? timestamp(fromRaw, "from") : 0,
        to: toRaw ? timestamp(toRaw, "to") : now,
    };
    if (range.from >= range.to)
        throw new SessionAnalyticsQueryError("from must be earlier than to");
    const groupBy = enumValues(query.groupBy, "groupBy", ANALYTICS_DIMENSIONS) ?? [];
    const bucketRaw = one(query.timeBucket, "timeBucket");
    if (bucketRaw && !ANALYTICS_TIME_BUCKETS.includes(bucketRaw)) {
        throw new SessionAnalyticsQueryError(`timeBucket must be one of ${ANALYTICS_TIME_BUCKETS.join(", ")}`);
    }
    if (bucketRaw && !groupBy.includes("time"))
        throw new SessionAnalyticsQueryError("timeBucket requires groupBy=time");
    const timeBucket = groupBy.includes("time") ? bucketRaw ?? "day" : null;
    const filters = {};
    const user = values(query.user, "user");
    const project = values(query.project, "project");
    const agent = enumValues(query.agent, "agent", listAgentDrivers().map((driver) => driver.id));
    const model = values(query.model, "model");
    const status = enumValues(query.status, "status", ["running", "completed"]);
    const outcome = enumValues(query.outcome, "outcome", ["success", "failure", "needs_human", "none"]);
    if (user)
        filters.user = user;
    if (project)
        filters.project = project;
    if (agent)
        filters.agent = agent;
    if (model)
        filters.model = model;
    if (status)
        filters.status = status;
    if (outcome)
        filters.outcome = outcome;
    return { from: range.from, to: range.to, period: period, groupBy, timeBucket, filters };
}
function emptyMetrics() {
    return {
        sessionCount: 0, promptCount: 0, turnCount: 0,
        inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0,
        processedTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
        providerDurationMs: 0, wallDurationMs: 0, totalCostUsd: 0, storageBytes: 0,
        sessionsWithUsage: 0, sessionsMissingUsage: 0,
        usageCoveragePercent: 0, attributionQuality: "missing",
        usageRejections: {},
        runningCount: 0, successCount: 0, failureCount: 0, needsHumanCount: 0, noOutcomeCount: 0,
    };
}
function outcomeOf(record) {
    return record.outcome?.result ?? "none";
}
function bucketRange(timestamp, bucket) {
    const date = new Date(timestamp);
    let start;
    if (bucket === "hour")
        start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours());
    else if (bucket === "day")
        start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    else if (bucket === "week") {
        const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
        start = day - ((date.getUTCDay() + 6) % 7) * 86_400_000;
    }
    else
        start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const startDate = new Date(start);
    const end = bucket === "hour" ? start + 3_600_000
        : bucket === "day" ? start + 86_400_000
            : bucket === "week" ? start + 7 * 86_400_000
                : Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 1);
    return { start, end };
}
function addRecord(metrics, record, storageBytes, now, promptCount) {
    metrics.sessionCount += 1;
    metrics.promptCount += promptCount;
    metrics.turnCount += record.turnCount;
    metrics.storageBytes += storageBytes;
    metrics.wallDurationMs += Math.max(0, (record.endedAt ?? now) - record.startedAt);
    if (record.status === "running")
        metrics.runningCount += 1;
    const outcome = outcomeOf(record);
    if (outcome === "success")
        metrics.successCount += 1;
    else if (outcome === "failure")
        metrics.failureCount += 1;
    else if (outcome === "needs_human")
        metrics.needsHumanCount += 1;
    else
        metrics.noOutcomeCount += 1;
    const canonical = normalizeTokenUsage(record.agent, record.usage, ({ reason }) => {
        metrics.usageRejections[reason] = (metrics.usageRejections[reason] ?? 0) + 1;
    });
    if (!canonical) {
        metrics.sessionsMissingUsage += 1;
        return;
    }
    metrics.sessionsWithUsage += 1;
    const usage = record.usage;
    metrics.inputTokens += usage.inputTokens ?? 0;
    metrics.outputTokens += usage.outputTokens ?? 0;
    metrics.cacheCreationTokens += usage.cacheCreationInputTokens ?? 0;
    metrics.cacheReadTokens += usage.cacheReadInputTokens ?? 0;
    metrics.uncachedInputTokens += canonical.uncachedInputTokens;
    metrics.cachedInputTokens += canonical.cachedInputTokens;
    metrics.cacheWriteInputTokens += canonical.cacheWriteInputTokens;
    metrics.processedTokens += canonical.processedTokens;
    metrics.totalTokens += canonical.processedTokens;
    metrics.providerDurationMs += usage.durationMs ?? 0;
    metrics.totalCostUsd += usage.totalCostUsd ?? 0;
}
function finishUsageQuality(metrics) {
    metrics.usageCoveragePercent = metrics.sessionCount === 0
        ? 0
        : (metrics.sessionsWithUsage / metrics.sessionCount) * 100;
    metrics.attributionQuality = metrics.sessionsWithUsage === 0
        ? "missing"
        : metrics.sessionsMissingUsage > 0 ? "mixed" : "estimated";
}
function matches(record, filters) {
    const outcome = outcomeOf(record);
    if (filters.project && !filters.project.some((value) => value === (record.projectId ?? "unknown") || value === (record.projectKey ?? "unknown")))
        return false;
    if (filters.agent && !filters.agent.includes(record.agent))
        return false;
    if (filters.model && !filters.model.includes(record.model ?? "unknown"))
        return false;
    if (filters.status && !filters.status.includes(record.status))
        return false;
    if (filters.outcome && !filters.outcome.includes(outcome))
        return false;
    return true;
}
function promptCountsByAuthor(record, transcript) {
    const userTurns = transcript.filter((event) => event.type === "user_message");
    const fallbackAuthor = record.initiator ?? "unknown";
    if (userTurns.length === 0) {
        return new Map([[fallbackAuthor, 1 + record.followUpPrompts.length + record.queuedFollowUps.length]]);
    }
    const counts = new Map();
    for (const turn of userTurns) {
        const author = typeof turn.author === "string" && turn.author.trim() ? turn.author.trim() : fallbackAuthor;
        counts.set(author, (counts.get(author) ?? 0) + 1);
    }
    return counts;
}
export function analyticsForSessions(records, query, storage = { totalBytes: 0, bySessionId: new Map() }, now = Date.now(), transcriptReader = readTranscript) {
    const allRecords = [...records];
    const knownStorageBytes = allRecords.reduce((sum, record) => sum + (storage.bySessionId.get(record.id) ?? 0), 0);
    const totals = emptyMetrics();
    const grouped = new Map();
    for (const record of allRecords) {
        if (record.startedAt < query.from || record.startedAt >= query.to || !matches(record, query.filters))
            continue;
        const authorCounts = promptCountsByAuthor(record, transcriptReader(record.id, record.agent));
        const selectedAuthorCounts = query.filters.user
            ? new Map([...authorCounts].filter(([author]) => query.filters.user.includes(author)))
            : authorCounts;
        if (selectedAuthorCounts.size === 0)
            continue;
        const selectedPromptCount = [...selectedAuthorCounts.values()].reduce((sum, count) => sum + count, 0);
        const bytes = storage.bySessionId.get(record.id) ?? 0;
        addRecord(totals, record, bytes, now, selectedPromptCount);
        const groupedAuthors = query.groupBy.includes("user") ? selectedAuthorCounts : new Map([["", selectedPromptCount]]);
        for (const [groupedAuthor, groupedPromptCount] of groupedAuthors) {
            const parts = [];
            const dimensions = {};
            for (const dimension of query.groupBy) {
                if (dimension === "user") {
                    dimensions.user = groupedAuthor;
                    parts.push(`user:${dimensions.user}`);
                }
                else if (dimension === "project") {
                    dimensions.projectId = record.projectId;
                    dimensions.projectKey = record.projectKey;
                    parts.push(`project:${record.projectId ?? (record.projectKey ? `key:${record.projectKey}` : "unknown")}`);
                }
                else if (dimension === "time") {
                    const range = bucketRange(record.startedAt, query.timeBucket);
                    dimensions.timeStart = new Date(range.start).toISOString();
                    dimensions.timeEnd = new Date(range.end).toISOString();
                    parts.push(`time:${range.start}`);
                }
                else if (dimension === "agent") {
                    dimensions.agent = record.agent;
                    parts.push(`agent:${record.agent}`);
                }
                else if (dimension === "model") {
                    dimensions.model = record.model ?? "unknown";
                    parts.push(`model:${dimensions.model}`);
                }
                else if (dimension === "status") {
                    dimensions.status = record.status;
                    parts.push(`status:${record.status}`);
                }
                else {
                    dimensions.outcome = outcomeOf(record);
                    parts.push(`outcome:${dimensions.outcome}`);
                }
            }
            const key = parts.join("\0");
            const row = grouped.get(key) ?? Object.assign(emptyMetrics(), dimensions);
            addRecord(row, record, bytes, now, groupedPromptCount);
            grouped.set(key, row);
        }
    }
    const rows = [...grouped.values()].sort((a, b) => {
        const aKey = query.groupBy.map((dimension) => dimension === "project" ? `${a.projectKey ?? ""}\0${a.projectId ?? ""}` : String(a[dimension === "time" ? "timeStart" : dimension] ?? "")).join("\0");
        const bKey = query.groupBy.map((dimension) => dimension === "project" ? `${b.projectKey ?? ""}\0${b.projectId ?? ""}` : String(b[dimension === "time" ? "timeStart" : dimension] ?? "")).join("\0");
        return aKey.localeCompare(bKey);
    });
    finishUsageQuality(totals);
    for (const row of rows)
        finishUsageQuality(row);
    return {
        peonId: ensurePeonId(),
        semanticsVersion: TOKEN_USAGE_SEMANTICS_VERSION,
        range: { from: query.from, to: query.to, fromIso: new Date(query.from).toISOString(), toIso: new Date(query.to).toISOString(), period: query.period },
        groupBy: query.groupBy,
        timeBucket: query.timeBucket,
        timeZone: "UTC",
        attribution: {
            time: "session_started_at",
            user: "transcript_turn_author",
            project: "session_project_id",
            note: "Prompt counts use each transcript turn's author; unsigned historical turns fall back to the session initiator. Session-level usage, duration, outcome, and storage are repeated for each participating author because exact per-message usage is unavailable.",
        },
        filters: query.filters,
        totals,
        rows,
        storage: { totalBytes: storage.totalBytes, unattributedBytes: Math.max(0, storage.totalBytes - knownStorageBytes) },
    };
}
