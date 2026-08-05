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
        usageCoveragePercent: 0, usageTurnsAttributed: 0, usageSessionsEstimated: 0,
        attributionQuality: "missing",
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
// Session-shaped metrics — how many sessions ran, for how long, to what end,
// and how much of their usage is readable at all. Selected by session start.
// Token sums are deliberately absent here: they are attributed per turn by
// addUsageMetrics, at the time the turn actually spent them.
function addSessionMetrics(metrics, record, storageBytes, now) {
    metrics.sessionCount += 1;
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
    if (canonical)
        metrics.sessionsWithUsage += 1;
    else
        metrics.sessionsMissingUsage += 1;
}
// One usage occurrence: either a single transcript turn, or the reconciliation
// remainder of a session whose transcript could not account for its record.
function addUsageMetrics(metrics, agent, occurrence) {
    const usage = occurrence.usage;
    const canonical = normalizeTokenUsage(agent, usage);
    // Raw provider fields are only trustworthy alongside a canonical reading;
    // a rejected usage payload was already counted by addSessionMetrics.
    if (!canonical)
        return;
    // A remainder holding only leftover cost or duration is still worth adding,
    // but it is not a token attribution and must not degrade the quality reading.
    if (occurrence.exact)
        metrics.usageTurnsAttributed += 1;
    else if (canonical.processedTokens > 0)
        metrics.usageSessionsEstimated += 1;
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
function addPrompts(metrics, promptCount) {
    metrics.promptCount += promptCount;
}
function finishUsageQuality(metrics) {
    metrics.usageCoveragePercent = metrics.sessionCount === 0
        ? 0
        : (metrics.sessionsWithUsage / metrics.sessionCount) * 100;
    // "exact" means every counted token came from the turn that spent it; a
    // session that had to be attributed as one session-start lump, or one whose
    // usage could not be read at all, degrades the reading.
    metrics.attributionQuality = metrics.sessionsWithUsage === 0
        ? "missing"
        : metrics.sessionsMissingUsage > 0
            ? "mixed"
            : metrics.usageSessionsEstimated === 0 && metrics.usageTurnsAttributed > 0
                ? "exact"
                : "estimated";
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
function promptOccurrences(record, transcript) {
    const userTurns = transcript.filter((event) => event.type === "user_message");
    const fallbackAuthor = record.initiator ?? "unknown";
    if (userTurns.length === 0) {
        return Array.from({ length: 1 + record.followUpPrompts.length + record.queuedFollowUps.length }, () => ({ author: fallbackAuthor, createdAt: record.startedAt }));
    }
    return userTurns.map((turn) => {
        const author = typeof turn.author === "string" && turn.author.trim() ? turn.author.trim() : fallbackAuthor;
        const createdAt = typeof turn.createdAt === "number" && Number.isFinite(turn.createdAt)
            ? turn.createdAt
            : record.startedAt;
        return { author, createdAt };
    });
}
function usageField(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
// Every invocation ends with one result event carrying that invocation's usage
// — the same payload sessions/runtime.ts folds into record.usage. Reading it
// back is what makes per-turn attribution possible; the field names are the
// CLI's, not ours.
function resultEventUsage(event) {
    const raw = event.usage;
    const usage = {
        inputTokens: usageField(raw?.input_tokens),
        outputTokens: usageField(raw?.output_tokens),
        cacheCreationInputTokens: usageField(raw?.cache_creation_input_tokens),
        cacheReadInputTokens: usageField(raw?.cache_read_input_tokens),
        durationMs: usageField(event.duration_ms),
        totalCostUsd: usageField(event.total_cost_usd),
    };
    const hasTokens = usage.inputTokens !== null || usage.outputTokens !== null
        || usage.cacheCreationInputTokens !== null || usage.cacheReadInputTokens !== null;
    return hasTokens ? usage : null;
}
// What record.usage still holds that the transcript did not account for.
// Transcripts can be pruned, predate a field, or be missing entirely, and the
// record is the authoritative total — so the difference is attributed rather
// than dropped. Clamped at zero: a transcript may legitimately hold more than
// the record if the record lost a fold.
function residualUsage(total, counted) {
    if (!total)
        return null;
    const remainder = (pick) => Math.max(0, (pick(total) ?? 0) - counted.reduce((sum, occurrence) => sum + (pick(occurrence.usage) ?? 0), 0));
    const usage = {
        inputTokens: remainder((value) => value.inputTokens),
        outputTokens: remainder((value) => value.outputTokens),
        cacheCreationInputTokens: remainder((value) => value.cacheCreationInputTokens),
        cacheReadInputTokens: remainder((value) => value.cacheReadInputTokens),
        durationMs: remainder((value) => value.durationMs),
        totalCostUsd: remainder((value) => value.totalCostUsd),
    };
    return Object.values(usage).some((value) => (value ?? 0) > 0) ? usage : null;
}
// Usage placed on the timeline: each turn at the moment its result committed
// and against the author of the user message that asked for it, plus at most
// one session-start remainder for whatever the transcript could not explain.
//
// The record's own rollup is the budget, never exceeded. A branched session
// inherits a verbatim copy of its source's transcript — including that
// source's result events — while starting with no usage of its own, so turns
// are counted newest-first and only while the record can still account for
// them. Inherited turns fall outside the budget and stay charged to the
// session that actually ran them.
function usageOccurrences(record, transcript) {
    const fallbackAuthor = record.initiator ?? "unknown";
    let author = fallbackAuthor;
    const candidates = [];
    for (const event of transcript) {
        if (event.type === "user_message") {
            author = typeof event.author === "string" && event.author.trim() ? event.author.trim() : fallbackAuthor;
            continue;
        }
        if (event.type !== "result")
            continue;
        const usage = resultEventUsage(event);
        if (!usage)
            continue;
        const canonical = normalizeTokenUsage(record.agent, usage);
        if (!canonical)
            continue;
        const createdAt = typeof event.createdAt === "number" && Number.isFinite(event.createdAt)
            ? event.createdAt
            : record.startedAt;
        candidates.push({
            occurrence: { author, createdAt, usage, exact: true },
            processedTokens: canonical.processedTokens,
        });
    }
    let remaining = record.usage ? normalizeTokenUsage(record.agent, record.usage)?.processedTokens ?? 0 : 0;
    const occurrences = [];
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const candidate = candidates[index];
        if (candidate.processedTokens > remaining)
            break;
        remaining -= candidate.processedTokens;
        occurrences.unshift(candidate.occurrence);
    }
    const residual = residualUsage(record.usage, occurrences);
    if (residual)
        occurrences.push({ author: fallbackAuthor, createdAt: record.startedAt, usage: residual, exact: false });
    return occurrences;
}
export function analyticsForSessions(records, query, storage = { totalBytes: 0, bySessionId: new Map() }, now = Date.now(), transcriptReader = readTranscript) {
    const allRecords = [...records];
    const knownStorageBytes = allRecords.reduce((sum, record) => sum + (storage.bySessionId.get(record.id) ?? 0), 0);
    const totals = emptyMetrics();
    const grouped = new Map();
    const groupedRow = (record, author, timestamp) => {
        const parts = [];
        const dimensions = {};
        for (const dimension of query.groupBy) {
            if (dimension === "user") {
                dimensions.user = author;
                parts.push(`user:${author}`);
            }
            else if (dimension === "project") {
                dimensions.projectId = record.projectId;
                dimensions.projectKey = record.projectKey;
                parts.push(`project:${record.projectId ?? (record.projectKey ? `key:${record.projectKey}` : "unknown")}`);
            }
            else if (dimension === "time") {
                const range = bucketRange(timestamp, query.timeBucket);
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
        grouped.set(key, row);
        return row;
    };
    for (const record of allRecords) {
        if (!matches(record, query.filters) || record.startedAt >= query.to)
            continue;
        // A turn can commit its usage after the last user message — take the
        // record's whole activity span as the widest thing the period can touch.
        const lastPossibleActivityAt = Math.max(record.lastActivityAt, record.lastUserMessageAt ?? 0, record.startedAt);
        if (lastPossibleActivityAt < query.from)
            continue;
        const transcript = transcriptReader(record.id, record.agent);
        const inPeriod = (occurrence) => occurrence.createdAt >= query.from
            && occurrence.createdAt < query.to
            && (!query.filters.user || query.filters.user.includes(occurrence.author));
        const selectedPrompts = promptOccurrences(record, transcript).filter(inPeriod);
        const selectedUsage = usageOccurrences(record, transcript).filter(inPeriod);
        if (selectedPrompts.length === 0 && selectedUsage.length === 0)
            continue;
        const sessionInRange = record.startedAt >= query.from;
        const bytes = storage.bySessionId.get(record.id) ?? 0;
        addPrompts(totals, selectedPrompts.length);
        for (const usage of selectedUsage)
            addUsageMetrics(totals, record.agent, usage);
        if (sessionInRange)
            addSessionMetrics(totals, record, bytes, now);
        const periodAuthors = [...new Set([...selectedPrompts, ...selectedUsage].map((occurrence) => occurrence.author))];
        if (sessionInRange) {
            const sessionAuthors = query.groupBy.includes("user") ? periodAuthors : [""];
            for (const author of sessionAuthors)
                addSessionMetrics(groupedRow(record, author, record.startedAt), record, bytes, now);
        }
        for (const prompt of selectedPrompts) {
            addPrompts(groupedRow(record, query.groupBy.includes("user") ? prompt.author : "", prompt.createdAt), 1);
        }
        for (const usage of selectedUsage) {
            addUsageMetrics(groupedRow(record, query.groupBy.includes("user") ? usage.author : "", usage.createdAt), record.agent, usage);
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
            promptTime: "user_message_created_at",
            usageTime: "transcript_result_created_at",
            user: "transcript_turn_author",
            project: "session_project_id",
            note: "Prompt counts use each transcript turn's author and Peon-recorded creation time; unsigned historical turns fall back to the session initiator, and undated turns fall back to the session start. Token, cost, and provider duration figures use each turn's own result event, attributed to the author of the user message that asked for it; whatever a session's transcript cannot account for is attributed to its initiator at session start, which is where every session with no readable transcript lands. Session counts, wall duration, outcome, and storage remain selected by session start and are repeated for each participating author in that period.",
        },
        filters: query.filters,
        totals,
        rows,
        storage: { totalBytes: storage.totalBytes, unattributedBytes: Math.max(0, storage.totalBytes - knownStorageBytes) },
    };
}
