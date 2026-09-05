import type { CodingAgent } from "../providers/modelCatalog.js";
import { listAgentDrivers } from "../agents/index.js";
import type { SessionRecord, SessionStatus, SessionUsage } from "./sessionTypes.js";
import { ensurePeonId } from "../identity/peonIdentity.js";
import { canonicalUsageProvider, normalizeTokenUsage, TOKEN_USAGE_SEMANTICS_VERSION } from "./tokenUsage.js";
import { readTranscript } from "./index.js";
import type { AgentEvent } from "../agents/index.js";
import { usageFromEvent, usageModelsFromEvent } from "./usageAccounting.js";

export const ANALYTICS_DIMENSIONS = ["user", "project", "time", "agent", "model", "status", "outcome"] as const;
export type AnalyticsDimension = typeof ANALYTICS_DIMENSIONS[number];
export const ANALYTICS_TIME_BUCKETS = ["hour", "day", "week", "month"] as const;
export type AnalyticsTimeBucket = typeof ANALYTICS_TIME_BUCKETS[number];
export const ANALYTICS_PERIODS = ["day", "yesterday", "week", "month", "all"] as const;
export type AnalyticsPeriod = typeof ANALYTICS_PERIODS[number];

type AnalyticsFilter = "user" | "project" | "agent" | "model" | "status" | "outcome";

export interface AnalyticsQuery {
  from: number;
  to: number;
  period: AnalyticsPeriod | null;
  groupBy: AnalyticsDimension[];
  timeBucket: AnalyticsTimeBucket | null;
  filters: Partial<Record<AnalyticsFilter, string[]>>;
}

export interface AnalyticsMetrics {
  sessionCount: number;
  promptCount: number;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  processedTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  providerDurationMs: number;
  wallDurationMs: number;
  totalCostUsd: number;
  storageBytes: number;
  sessionsWithUsage: number;
  sessionsMissingUsage: number;
  usageCoveragePercent: number;
  // Turns whose usage was read from their own transcript result event, and
  // sessions whose usage could only be attributed as one session-start lump.
  usageTurnsAttributed: number;
  usagePartialTurns: number;
  usageLegacyTurns: number;
  cacheBreakdownComplete: boolean;
  reasoningOutputTokens: number | null;
  usageSessionsEstimated: number;
  attributionQuality: "exact" | "estimated" | "mixed" | "missing";
  usageRejections: Partial<Record<import("./tokenUsage.js").TokenUsageRejectionReason, number>>;
  runningCount: number;
  successCount: number;
  failureCount: number;
  needsHumanCount: number;
  noOutcomeCount: number;
}

export interface AnalyticsRow extends AnalyticsMetrics {
  user?: string;
  projectId?: string | null;
  projectKey?: string | null;
  timeStart?: string;
  timeEnd?: string;
  agent?: CodingAgent;
  model?: string;
  status?: SessionStatus;
  outcome?: "success" | "failure" | "needs_human" | "none";
}

export interface SessionAnalytics {
  peonId: string;
  semanticsVersion: number;
  range: { from: number; to: number; fromIso: string; toIso: string; period: AnalyticsPeriod | null };
  groupBy: AnalyticsDimension[];
  timeBucket: AnalyticsTimeBucket | null;
  timeZone: "UTC";
  attribution: {
    time: "session_started_at";
    promptTime: "user_message_created_at";
    usageTime: "transcript_result_created_at";
    user: "transcript_turn_author";
    project: "session_project_id";
    note: string;
  };
  filters: Partial<Record<AnalyticsFilter, string[]>>;
  totals: AnalyticsMetrics;
  rows: AnalyticsRow[];
  storage: { totalBytes: number; unattributedBytes: number };
}

export class SessionAnalyticsQueryError extends Error {
  readonly code = "BAD_ANALYTICS_QUERY";
}

function one(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new SessionAnalyticsQueryError(`${name} must be a non-empty string`);
  return value.trim();
}

function values(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  if (raw.some((item) => typeof item !== "string")) throw new SessionAnalyticsQueryError(`${name} must contain strings`);
  const parsed = raw.flatMap((item) => (item as string).split(",")).map((item) => item.trim()).filter(Boolean);
  if (parsed.length === 0) throw new SessionAnalyticsQueryError(`${name} must contain at least one value`);
  return [...new Set(parsed)];
}

function enumValues<T extends string>(value: unknown, name: string, allowed: readonly T[]): T[] | undefined {
  const parsed = values(value, name);
  if (!parsed) return undefined;
  for (const item of parsed) {
    if (!allowed.includes(item as T)) throw new SessionAnalyticsQueryError(`${name} contains invalid value "${item}" (expected ${allowed.join(", ")})`);
  }
  return parsed as T[];
}

function timestamp(value: string, name: string): number {
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isFinite(new Date(parsed).getTime())) {
    throw new SessionAnalyticsQueryError(`${name} must be an ISO timestamp or non-negative epoch milliseconds`);
  }
  return parsed;
}

function periodRange(period: AnalyticsPeriod, now: number): { from: number; to: number } {
  if (period === "all") return { from: 0, to: now };
  const date = new Date(now);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (period === "day") return { from: today, to: now };
  if (period === "yesterday") return { from: today - 86_400_000, to: today };
  if (period === "week") {
    const mondayOffset = (new Date(today).getUTCDay() + 6) % 7;
    return { from: today - mondayOffset * 86_400_000, to: now };
  }
  return { from: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), to: now };
}

export function parseSessionAnalyticsQuery(query: Record<string, unknown>, now = Date.now()): AnalyticsQuery {
  const fromRaw = one(query.from, "from");
  const toRaw = one(query.to, "to");
  const periodRaw = one(query.period, "period");
  if ((fromRaw || toRaw) && periodRaw) throw new SessionAnalyticsQueryError("period cannot be combined with from or to");
  const period = periodRaw ?? (!fromRaw && !toRaw ? "month" : null);
  if (period && !ANALYTICS_PERIODS.includes(period as AnalyticsPeriod)) {
    throw new SessionAnalyticsQueryError(`period must be one of ${ANALYTICS_PERIODS.join(", ")}`);
  }
  const range = period ? periodRange(period as AnalyticsPeriod, now) : {
    from: fromRaw ? timestamp(fromRaw, "from") : 0,
    to: toRaw ? timestamp(toRaw, "to") : now,
  };
  if (range.from >= range.to) throw new SessionAnalyticsQueryError("from must be earlier than to");

  const groupBy = enumValues(query.groupBy, "groupBy", ANALYTICS_DIMENSIONS) ?? [];
  const bucketRaw = one(query.timeBucket, "timeBucket");
  if (bucketRaw && !ANALYTICS_TIME_BUCKETS.includes(bucketRaw as AnalyticsTimeBucket)) {
    throw new SessionAnalyticsQueryError(`timeBucket must be one of ${ANALYTICS_TIME_BUCKETS.join(", ")}`);
  }
  if (bucketRaw && !groupBy.includes("time")) throw new SessionAnalyticsQueryError("timeBucket requires groupBy=time");
  const timeBucket = groupBy.includes("time") ? (bucketRaw as AnalyticsTimeBucket | undefined) ?? "day" : null;

  const filters: AnalyticsQuery["filters"] = {};
  const user = values(query.user, "user");
  const project = values(query.project, "project");
  const agent = enumValues(query.agent, "agent", listAgentDrivers().map((driver) => driver.id));
  const model = values(query.model, "model");
  const status = enumValues(query.status, "status", ["running", "completed"] as const);
  const outcome = enumValues(query.outcome, "outcome", ["success", "failure", "needs_human", "none"] as const);
  if (user) filters.user = user;
  if (project) filters.project = project;
  if (agent) filters.agent = agent;
  if (model) filters.model = model;
  if (status) filters.status = status;
  if (outcome) filters.outcome = outcome;
  return { from: range.from, to: range.to, period: period as AnalyticsPeriod | null, groupBy, timeBucket, filters };
}

function emptyMetrics(): AnalyticsMetrics {
  return {
    sessionCount: 0, promptCount: 0, turnCount: 0,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0,
    processedTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    providerDurationMs: 0, wallDurationMs: 0, totalCostUsd: 0, storageBytes: 0,
    sessionsWithUsage: 0, sessionsMissingUsage: 0,
    usageCoveragePercent: 0, usageTurnsAttributed: 0, usageSessionsEstimated: 0,
    usagePartialTurns: 0, usageLegacyTurns: 0,
    cacheBreakdownComplete: true, reasoningOutputTokens: null,
    attributionQuality: "missing",
    usageRejections: {},
    runningCount: 0, successCount: 0, failureCount: 0, needsHumanCount: 0, noOutcomeCount: 0,
  };
}

function outcomeOf(record: SessionRecord): "success" | "failure" | "needs_human" | "none" {
  return record.outcome?.result ?? "none";
}

function bucketRange(timestamp: number, bucket: AnalyticsTimeBucket): { start: number; end: number } {
  const date = new Date(timestamp);
  let start: number;
  if (bucket === "hour") start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours());
  else if (bucket === "day") start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  else if (bucket === "week") {
    const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    start = day - ((date.getUTCDay() + 6) % 7) * 86_400_000;
  } else start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
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
function addSessionMetrics(metrics: AnalyticsMetrics, record: SessionRecord, storageBytes: number, now: number): void {
  metrics.sessionCount += 1;
  metrics.turnCount += record.turnCount;
  metrics.storageBytes += storageBytes;
  metrics.wallDurationMs += Math.max(0, (record.endedAt ?? now) - record.startedAt);
  if (record.status === "running") metrics.runningCount += 1;
  const outcome = outcomeOf(record);
  if (outcome === "success") metrics.successCount += 1;
  else if (outcome === "failure") metrics.failureCount += 1;
  else if (outcome === "needs_human") metrics.needsHumanCount += 1;
  else metrics.noOutcomeCount += 1;
  const canonical = normalizeTokenUsage(record.agent, record.usage, ({ reason }) => {
    metrics.usageRejections[reason] = (metrics.usageRejections[reason] ?? 0) + 1;
  });
  if (canonical) metrics.sessionsWithUsage += 1;
  else metrics.sessionsMissingUsage += 1;
}

// One usage occurrence: either a single transcript turn, or the reconciliation
// remainder of a session whose transcript could not account for its record.
function addUsageMetrics(metrics: AnalyticsMetrics, agent: CodingAgent, occurrence: UsageOccurrence): void {
  const usage = occurrence.usage;
  metrics.providerDurationMs += usage.durationMs ?? 0;
  metrics.totalCostUsd += usage.totalCostUsd ?? 0;
  const canonical = normalizeTokenUsage(agent, usage);
  // Raw provider fields are only trustworthy alongside a canonical reading;
  // a rejected usage payload was already counted by addSessionMetrics.
  if (!canonical) return;
  // A remainder holding only leftover cost or duration is still worth adding,
  // but it is not a token attribution and must not degrade the quality reading.
  if (occurrence.exact && canonical.processedTokens > 0) metrics.usageTurnsAttributed += 1;
  else if (canonical.processedTokens > 0) metrics.usageSessionsEstimated += 1;
  if (canonical.processedTokens > 0) {
    if (usage.quality === "partial") metrics.usagePartialTurns += 1;
    else if (usage.quality !== "reported") metrics.usageLegacyTurns += 1;
  }
  metrics.inputTokens += canonical.uncachedInputTokens;
  if (usage.cacheCreationInputTokens == null || usage.cacheReadInputTokens == null) metrics.cacheBreakdownComplete = false;
  if (usage.reasoningOutputTokens != null) metrics.reasoningOutputTokens = (metrics.reasoningOutputTokens ?? 0) + usage.reasoningOutputTokens;
  metrics.outputTokens += usage.outputTokens ?? 0;
  metrics.cacheCreationTokens += usage.cacheCreationInputTokens ?? 0;
  metrics.cacheReadTokens += usage.cacheReadInputTokens ?? 0;
  metrics.uncachedInputTokens += canonical.uncachedInputTokens;
  metrics.cachedInputTokens += canonical.cachedInputTokens;
  metrics.cacheWriteInputTokens += canonical.cacheWriteInputTokens;
  metrics.processedTokens += canonical.processedTokens;
  metrics.totalTokens += canonical.processedTokens;
}

function addPrompts(metrics: AnalyticsMetrics, promptCount: number): void {
  metrics.promptCount += promptCount;
}

function finishUsageQuality(metrics: AnalyticsMetrics): void {
  metrics.usageCoveragePercent = metrics.sessionCount === 0
    ? 0
    : (metrics.sessionsWithUsage / metrics.sessionCount) * 100;
  // "exact" means every counted token came from the turn that spent it; a
  // session that had to be attributed as one session-start lump, or one whose
  // usage could not be read at all, degrades the reading.
  metrics.attributionQuality = metrics.sessionsWithUsage === 0 && metrics.usageTurnsAttributed === 0 && metrics.usageSessionsEstimated === 0
    ? "missing"
    : metrics.sessionsMissingUsage > 0
      ? "mixed"
      : metrics.usageSessionsEstimated === 0 && metrics.usageTurnsAttributed > 0
        ? "exact"
        : "estimated";
}

function matches(record: SessionRecord, filters: AnalyticsQuery["filters"]): boolean {
  const outcome = outcomeOf(record);
  if (filters.project && !filters.project.some((value) => value === (record.projectId ?? "unknown") || value === (record.projectKey ?? "unknown"))) return false;
  if (filters.agent && !filters.agent.includes(record.agent)) return false;
  if (filters.status && !filters.status.includes(record.status)) return false;
  if (filters.outcome && !filters.outcome.includes(outcome)) return false;
  return true;
}

interface PromptOccurrence {
  author: string;
  createdAt: number;
}

function promptOccurrences(record: SessionRecord, transcript: readonly AgentEvent[]): PromptOccurrence[] {
  const userTurns = transcript.filter((event) => event.type === "user_message");
  const fallbackAuthor = record.initiator ?? "unknown";
  if (userTurns.length === 0) {
    return Array.from(
      { length: 1 + (record.followUpPrompts?.length ?? 0) + (record.queuedFollowUps?.length ?? 0) },
      () => ({ author: fallbackAuthor, createdAt: record.startedAt }),
    );
  }
  return userTurns.map((turn) => {
    const author = typeof turn.author === "string" && turn.author.trim() ? turn.author.trim() : fallbackAuthor;
    const createdAt = typeof turn.createdAt === "number" && Number.isFinite(turn.createdAt)
      ? turn.createdAt
      : record.startedAt;
    return { author, createdAt };
  });
}

interface UsageOccurrence {
  model?: string;
  models?: Record<string, SessionUsage>;
  author: string;
  createdAt: number;
  usage: SessionUsage;
  // True when the usage came from the turn's own result event, false for the
  // session-start remainder described in usageOccurrences().
  exact: boolean;
}

// Every invocation ends with one result event carrying that invocation's usage
// — the same payload sessions/runtime.ts folds into record.usage. Reading it
// back is what makes per-turn attribution possible; the field names are the
// CLI's, not ours.
function resultEventUsage(event: AgentEvent): SessionUsage | null {
  const usage = usageFromEvent(event);
  const hasTokens = usage.inputTokens !== null || usage.outputTokens !== null
    || usage.cacheCreationInputTokens !== null || usage.cacheReadInputTokens !== null;
  return hasTokens || usage.durationMs !== null || usage.totalCostUsd !== null ? usage : null;
}

// What record.usage still holds that the transcript did not account for.
// Transcripts can be pruned, predate a field, or be missing entirely, and the
// record is the authoritative total — so the difference is attributed rather
// than dropped. Clamped at zero: a transcript may legitimately hold more than
// the record if the record lost a fold.
function residualUsage(total: SessionUsage | null | undefined, counted: readonly UsageOccurrence[]): SessionUsage | null {
  if (!total) return null;
  const remainder = (pick: (usage: SessionUsage) => number | null | undefined): number | null => pick(total) == null ? null : Math.max(
    0,
    (pick(total) ?? 0) - counted.reduce((sum, occurrence) => sum + (pick(occurrence.usage) ?? 0), 0),
  );
  const usage: SessionUsage = {
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
function usageOccurrences(record: SessionRecord, transcript: readonly AgentEvent[]): UsageOccurrence[] {
  const fallbackAuthor = record.initiator ?? "unknown";
  let author = fallbackAuthor;
  const candidates: { occurrence: UsageOccurrence; processedTokens: number }[] = [];
  const owned = new Map<string, UsageOccurrence>();
  const seenLegacy = new Set<string>();
  let model = record.model ?? "unknown";
  for (const event of transcript) {
    if (event.type === "user_message") {
      author = typeof event.author === "string" && event.author.trim() ? event.author.trim() : fallbackAuthor;
      continue;
    }
    const message = event.message as Record<string, unknown> | undefined;
    if (typeof event.model === "string") model = event.model;
    else if (typeof message?.model === "string") model = message.model;
    if (event.type !== "result" && !(event.type === "system" && event.subtype === "usage")) continue;
    if (typeof event.usage_session_id === "string" && event.usage_session_id !== record.id) continue;
    if (typeof event.id === "string" && !event.usage_run_id) {
      if (seenLegacy.has(event.id)) continue;
      seenLegacy.add(event.id);
    }
    const usage = resultEventUsage(event);
    if (!usage) continue;
    const canonical = normalizeTokenUsage(record.agent, usage);
    if (!canonical && usage.durationMs === null && usage.totalCostUsd === null) continue;
    const createdAt = typeof event.createdAt === "number" && Number.isFinite(event.createdAt)
      ? event.createdAt
      : record.startedAt;
    const occurrence: UsageOccurrence = { author: typeof event.usage_author === "string" ? event.usage_author : author,
      createdAt, usage, exact: typeof event.createdAt === "number", model, models: usageModelsFromEvent(event) };
    if (typeof event.usage_run_id === "string" && event.usage_session_id === record.id) {
      owned.set(event.usage_run_id, occurrence);
      continue;
    }
    candidates.push({
      occurrence,
      processedTokens: canonical?.processedTokens ?? 0,
    });
  }

  let remaining = record.usage ? normalizeTokenUsage(record.agent, record.usage)?.processedTokens ?? 0 : 0;
  const occurrences: UsageOccurrence[] = [...owned.values()];
  remaining = Math.max(0, remaining - occurrences.reduce((sum, item) => sum + (normalizeTokenUsage(record.agent, item.usage)?.processedTokens ?? 0), 0));
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    if (candidate.processedTokens > remaining) break;
    remaining -= candidate.processedTokens;
    occurrences.unshift(candidate.occurrence);
  }
  const residual = residualUsage(record.usage, occurrences);
  if (residual) occurrences.push({ author: fallbackAuthor, createdAt: record.startedAt,
    usage: { ...residual, quality: record.usage?.quality, source: record.usage?.source }, exact: false,
    model: record.model ?? "unknown", models: occurrences.length === 0 ? record.usageByModel : undefined });
  return occurrences;
}

function splitUsageModels(occurrence: UsageOccurrence, agent: CodingAgent): UsageOccurrence[] {
    const models = Object.entries(occurrence.models ?? {});
    const expected = normalizeTokenUsage(agent, occurrence.usage)?.processedTokens;
    const actual = models.reduce((sum, [, value]) => sum + (normalizeTokenUsage(agent, value)?.processedTokens ?? 0), 0);
    if (!models.length || actual !== expected) return [occurrence];
    const rows = models.map(([model, usage]) => ({ ...occurrence, model, models: undefined, usage: {
      ...usage, quality: occurrence.usage.quality, durationMs: models.length === 1 ? occurrence.usage.durationMs : usage.durationMs,
    } }));
    // Provider wall duration has no truthful per-model split for concurrent
    // work. Keep the unallocated amount visible, rather than multiply it.
    const rest = residualUsage(occurrence.usage, rows);
    if (rest) rows.push({ ...occurrence, model: "unknown", models: undefined, usage: { ...rest, quality: occurrence.usage.quality } });
    return rows;
}

export function analyticsForSessions(
  records: Iterable<SessionRecord>,
  query: AnalyticsQuery,
  storage: { totalBytes: number; bySessionId: ReadonlyMap<string, number> } = { totalBytes: 0, bySessionId: new Map() },
  now = Date.now(),
  transcriptReader: (id: string, agent: CodingAgent) => readonly AgentEvent[] = readTranscript,
): SessionAnalytics {
  const allRecords = [...records];
  const knownStorageBytes = allRecords.reduce((sum, record) => sum + (storage.bySessionId.get(record.id) ?? 0), 0);
  const totals = emptyMetrics();
  const grouped = new Map<string, AnalyticsRow>();

  const groupedRow = (record: SessionRecord, author: string, timestamp: number, model?: string): AnalyticsRow => {
    const parts: string[] = [];
    const dimensions: Partial<AnalyticsRow> = {};
    for (const dimension of query.groupBy) {
      if (dimension === "user") {
        dimensions.user = author;
        parts.push(`user:${author}`);
      } else if (dimension === "project") {
        dimensions.projectId = record.projectId;
        dimensions.projectKey = record.projectKey;
        parts.push(`project:${record.projectId ?? (record.projectKey ? `key:${record.projectKey}` : "unknown")}`);
      } else if (dimension === "time") {
        const range = bucketRange(timestamp, query.timeBucket!);
        dimensions.timeStart = new Date(range.start).toISOString();
        dimensions.timeEnd = new Date(range.end).toISOString();
        parts.push(`time:${range.start}`);
      } else if (dimension === "agent") {
        dimensions.agent = canonicalUsageProvider(record.agent);
        parts.push(`agent:${dimensions.agent}`);
      } else if (dimension === "model") {
        dimensions.model = model ?? record.model ?? "unknown";
        parts.push(`model:${dimensions.model}`);
      } else if (dimension === "status") {
        dimensions.status = record.status;
        parts.push(`status:${record.status}`);
      } else {
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
    if (!matches(record, query.filters) || record.startedAt >= query.to) continue;
    // A turn can commit its usage after the last user message — take the
    // record's whole activity span as the widest thing the period can touch.
    const lastPossibleActivityAt = Math.max(record.lastActivityAt, record.lastUserMessageAt ?? 0, record.startedAt);
    if (lastPossibleActivityAt < query.from) continue;
    const transcript = transcriptReader(record.id, record.agent);
    const inPeriod = (occurrence: { author: string; createdAt: number }): boolean =>
      occurrence.createdAt >= query.from
      && occurrence.createdAt < query.to
      && (!query.filters.user || query.filters.user.includes(occurrence.author));
    const selectedPrompts = promptOccurrences(record, transcript).filter(inPeriod);
    const periodUsage = usageOccurrences(record, transcript).filter(inPeriod);
    const selectedUsage = query.filters.model
      ? periodUsage.flatMap((item) => splitUsageModels(item, record.agent)).filter((item) => query.filters.model!.includes(item.model ?? "unknown"))
      : periodUsage;
    const modelUsage = query.groupBy.includes("model") ? selectedUsage.flatMap((item) => splitUsageModels(item, record.agent)) : selectedUsage;
    if (selectedPrompts.length === 0 && selectedUsage.length === 0) continue;
    const sessionInRange = record.startedAt >= query.from;
    const bytes = storage.bySessionId.get(record.id) ?? 0;
    addPrompts(totals, selectedPrompts.length);
    for (const usage of selectedUsage) addUsageMetrics(totals, record.agent, usage);
    if (sessionInRange) addSessionMetrics(totals, record, bytes, now);

    const periodAuthors = [...new Set([...selectedPrompts, ...selectedUsage].map((occurrence) => occurrence.author))];
    if (sessionInRange) {
      const sessionAuthors = query.groupBy.includes("user") ? periodAuthors : [""];
      const models = query.groupBy.includes("model") && modelUsage.length
        ? [...new Set(modelUsage.map((item) => item.model ?? "unknown"))] : [record.model ?? "unknown"];
      for (const author of sessionAuthors) for (const model of models) {
        addSessionMetrics(groupedRow(record, author, record.startedAt, model), record, bytes, now);
      }
    }
    for (const prompt of selectedPrompts) {
      addPrompts(groupedRow(record, query.groupBy.includes("user") ? prompt.author : "", prompt.createdAt), 1);
    }
    for (const usage of modelUsage) {
      addUsageMetrics(groupedRow(record, query.groupBy.includes("user") ? usage.author : "", usage.createdAt, usage.model), record.agent, usage);
    }
  }

  const rows = [...grouped.values()].sort((a, b) => {
    const aKey = query.groupBy.map((dimension) => dimension === "project" ? `${a.projectKey ?? ""}\0${a.projectId ?? ""}` : String(a[dimension === "time" ? "timeStart" : dimension] ?? "")).join("\0");
    const bKey = query.groupBy.map((dimension) => dimension === "project" ? `${b.projectKey ?? ""}\0${b.projectId ?? ""}` : String(b[dimension === "time" ? "timeStart" : dimension] ?? "")).join("\0");
    return aKey.localeCompare(bKey);
  });
  finishUsageQuality(totals);
  for (const row of rows) finishUsageQuality(row);
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
