import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import {
  analyticsForSessions,
  parseSessionAnalyticsQuery,
  SessionAnalyticsQueryError,
} from "../sessionAnalytics.js";
import { statsForPeriod } from "../sessionStats.js";
import type { SessionRecord } from "../sessionTypes.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-07-17T12:00:00.000Z");

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session-1",
    prompt: "initial",
    title: null,
    followUpPrompts: ["follow-up"],
    queuedFollowUps: [],
    pendingSystemPrompts: [],
    dir: os.tmpdir(),
    agent: "codex",
    backendSessionId: null,
    model: null,
    reasoningEffort: null,
    projectId: "project-1",
    projectKey: "peon",
    candidateProjectKeys: [],
    taskKey: null,
    taskTitle: null,
    initiator: "alice@example.com",
    expectsOutcome: false,
    status: "completed",
    outcome: { result: "success", summary: "done" },
    startedAt: Date.parse("2026-07-16T10:15:00.000Z"),
    endedAt: Date.parse("2026-07-16T11:15:00.000Z"),
    turnCount: 3,
    turnBudget: 4,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 50,
      durationMs: 1_000,
      totalCostUsd: 0.25,
    },
    usageByModel: {},
    autoResumeAttempts: 0,
    lastActivityAt: Date.parse("2026-07-16T11:15:00.000Z"),
    lastUserMessageAt: Date.parse("2026-07-16T10:15:00.000Z"),
    lastMessagePreview: null,
    eventCount: 0,
    ...overrides,
  };
}

test("query parser supports explicit ranges, combined dimensions, filters, and UTC time buckets", () => {
  const parsed = parseSessionAnalyticsQuery({
    from: "2026-07-01T00:00:00Z",
    to: String(NOW),
    groupBy: "user,project,time",
    timeBucket: "hour",
    user: ["alice@example.com,bob@example.com"],
    project: "project-1,peon",
  }, NOW);
  assert.deepEqual(parsed, {
    from: Date.parse("2026-07-01T00:00:00Z"),
    to: NOW,
    period: null,
    groupBy: ["user", "project", "time"],
    timeBucket: "hour",
    filters: {
      user: ["alice@example.com", "bob@example.com"],
      project: ["project-1", "peon"],
    },
  });
});

test("query parser defaults to the UTC month and validates incompatible input", () => {
  const parsed = parseSessionAnalyticsQuery({}, NOW);
  assert.equal(parsed.from, Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(parsed.to, NOW);
  assert.equal(parsed.period, "month");
  assert.deepEqual(parsed.groupBy, []);

  for (const query of [
    { from: "2026-07-02", to: "2026-07-01" },
    { period: "month", from: "0" },
    { groupBy: "banana" },
    { timeBucket: "day" },
    { groupBy: "time", timeBucket: "minute" },
    { from: "999999999999999999999", to: String(NOW) },
  ]) {
    assert.throws(
      () => parseSessionAnalyticsQuery(query, NOW),
      (error: unknown) => error instanceof SessionAnalyticsQueryError && error.code === "BAD_ANALYTICS_QUERY",
    );
  }
});

test("analytics combines user, stable project identity, and time while preserving totals", () => {
  const records = [
    record(),
    record({
      id: "session-2",
      initiator: "bob@example.com",
      projectId: "project-2",
      projectKey: "armory",
      status: "running",
      outcome: null,
      startedAt: Date.parse("2026-07-16T10:45:00.000Z"),
      endedAt: null,
      followUpPrompts: [],
      queuedFollowUps: [{
        id: "queued", sessionId: "session-2", prompt: "queued", attachments: [], permissionMode: null,
        author: "bob@example.com", model: null, reasoningEffort: null, commandId: null, queuedAt: NOW,
      }],
      pendingSystemPrompts: [],
      usage: null,
    }),
    record({ id: "outside", startedAt: Date.parse("2026-06-01T00:00:00.000Z") }),
  ];
  const query = parseSessionAnalyticsQuery({
    from: "2026-07-01T00:00:00Z", to: String(NOW), groupBy: "time,user,project", timeBucket: "hour",
  }, NOW);
  const result = analyticsForSessions(records, query, {
    totalBytes: 1_000,
    bySessionId: new Map([["session-1", 100], ["session-2", 200], ["outside", 300]]),
  }, NOW);

  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => [row.timeStart, row.user, row.projectId, row.storageBytes]), [
    ["2026-07-16T10:00:00.000Z", "alice@example.com", "project-1", 100],
    ["2026-07-16T10:00:00.000Z", "bob@example.com", "project-2", 200],
  ]);
  assert.equal(result.totals.sessionCount, 2);
  assert.equal(result.totals.promptCount, 4);
  assert.equal(result.totals.totalTokens, 120);
  assert.equal(result.totals.processedTokens, 120);
  assert.equal(result.totals.cachedInputTokens, 50);
  assert.equal(result.totals.uncachedInputTokens, 50);
  assert.equal(result.totals.providerDurationMs, 1_000);
  assert.equal(result.totals.wallDurationMs, HOUR + (NOW - Date.parse("2026-07-16T10:45:00.000Z")));
  assert.equal(result.totals.sessionsWithUsage, 1);
  assert.equal(result.totals.sessionsMissingUsage, 1);
  assert.equal(result.totals.usageCoveragePercent, 50);
  assert.equal(result.totals.attributionQuality, "mixed");
  assert.equal(result.totals.runningCount, 1);
  assert.equal(result.storage.unattributedBytes, 400);
  assert.equal(result.attribution.user, "session_initiator");
});

test("stats and analytics use identical canonical totals and expose provider/model filtering", () => {
  const records = [
    record({
      model: "gpt-5.4",
      startedAt: Date.now() - 1_000,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 80,
        durationMs: 1,
        totalCostUsd: null,
      },
    }),
  ];
  const stats = statsForPeriod(records, "day");
  const analytics = analyticsForSessions(
    records,
    parseSessionAnalyticsQuery({ period: "all", groupBy: "agent,model", model: "gpt-5.4" }),
  );

  assert.equal(stats.processedTokens, 120);
  assert.equal(analytics.totals.processedTokens, stats.processedTokens);
  assert.equal(analytics.rows[0]?.agent, "codex");
  assert.equal(analytics.rows[0]?.model, "gpt-5.4");
  assert.equal(analytics.totals.attributionQuality, "estimated");
  assert.equal(analytics.semanticsVersion, 1);
  assert.ok(analytics.peonId);
});

test("analytics filters unknown identities and projects by either stable id or key", () => {
  const records = [
    record(),
    record({ id: "legacy", initiator: null, projectId: null, projectKey: null }),
  ];
  const unknown = analyticsForSessions(records, parseSessionAnalyticsQuery({ period: "all", user: "unknown", project: "unknown" }, NOW), undefined, NOW);
  assert.equal(unknown.totals.sessionCount, 1);
  const byKey = analyticsForSessions(records, parseSessionAnalyticsQuery({ period: "all", project: "peon" }, NOW), undefined, NOW);
  const byId = analyticsForSessions(records, parseSessionAnalyticsQuery({ period: "all", project: "project-1" }, NOW), undefined, NOW);
  assert.equal(byKey.totals.sessionCount, 1);
  assert.equal(byId.totals.sessionCount, 1);
});
