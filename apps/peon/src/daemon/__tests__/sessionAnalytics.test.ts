import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import {
  analyticsForSessions,
  parseSessionAnalyticsQuery,
  SessionAnalyticsQueryError,
} from "../sessions/sessionAnalytics.js";
import { statsForPeriod } from "../sessions/sessionStats.js";
import type { SessionRecord } from "../sessions/sessionTypes.js";

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
        id: "queued", type: "queue", sessionId: "session-2", prompt: "queued", attachments: [], permissionMode: null,
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
  }, NOW, (id) => id === "session-1"
    ? [{ type: "user_message", text: "initial", author: "alice@example.com" }, { type: "user_message", text: "follow-up", author: "alice@example.com" }]
    : id === "session-2" ? [{ type: "user_message", text: "initial", author: "bob@example.com" }] : []);

  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => [row.timeStart, row.user, row.projectId, row.storageBytes]), [
    ["2026-07-16T10:00:00.000Z", "alice@example.com", "project-1", 100],
    ["2026-07-16T10:00:00.000Z", "bob@example.com", "project-2", 200],
  ]);
  assert.equal(result.totals.sessionCount, 2);
  assert.equal(result.totals.promptCount, 3);
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
  assert.equal(result.attribution.user, "transcript_turn_author");
});

test("analytics attributes shared-session prompts to each transcript turn author", () => {
  const shared = record({ followUpPrompts: ["bob", "unsigned"] });
  const transcript = [
    { type: "user_message" as const, text: "initial", author: "alice@example.com" },
    { type: "user_message" as const, text: "follow-up", author: "bob@example.com" },
    { type: "user_message" as const, text: "legacy follow-up" },
  ];
  const byUser = analyticsForSessions(
    [shared],
    parseSessionAnalyticsQuery({ period: "all", groupBy: "user" }, NOW),
    undefined,
    NOW,
    () => transcript,
  );

  assert.deepEqual(byUser.rows.map((row) => [row.user, row.promptCount]), [
    ["alice@example.com", 2],
    ["bob@example.com", 1],
  ]);
  assert.equal(byUser.totals.promptCount, 3);
  const byProject = analyticsForSessions(
    [shared],
    parseSessionAnalyticsQuery({ period: "all", groupBy: "project" }, NOW),
    undefined,
    NOW,
    () => transcript,
  );
  assert.equal(
    byUser.rows.reduce((sum, row) => sum + row.promptCount, 0),
    byProject.rows.reduce((sum, row) => sum + row.promptCount, 0),
  );

  const bob = analyticsForSessions(
    [shared],
    parseSessionAnalyticsQuery({ period: "all", user: "bob@example.com" }, NOW),
    undefined,
    NOW,
    () => transcript,
  );
  assert.equal(bob.totals.promptCount, 1);
  assert.match(bob.attribution.note, /unsigned historical turns fall back to the session initiator/);
});

test("period analytics count prompt activity in sessions that started before the period", () => {
  const priorSession = record({
    id: "prior-session",
    startedAt: Date.parse("2026-07-16T10:15:00.000Z"),
    endedAt: null,
    status: "running",
    outcome: null,
    lastActivityAt: Date.parse("2026-07-17T11:30:00.000Z"),
    lastUserMessageAt: Date.parse("2026-07-17T11:30:00.000Z"),
  });
  const transcript = [
    { type: "user_message" as const, text: "initial", author: "alice@example.com", createdAt: priorSession.startedAt },
    { type: "user_message" as const, text: "today one", author: "bob@example.com", createdAt: Date.parse("2026-07-17T09:00:00.000Z") },
    { type: "user_message" as const, text: "today two", author: "bob@example.com", createdAt: Date.parse("2026-07-17T11:30:00.000Z") },
  ];
  const query = parseSessionAnalyticsQuery({ period: "day", groupBy: "time,user,project", timeBucket: "day" }, NOW);
  const result = analyticsForSessions(
    [priorSession],
    query,
    { totalBytes: 500, bySessionId: new Map([[priorSession.id, 400]]) },
    NOW,
    () => transcript,
  );

  assert.equal(result.totals.promptCount, 2);
  assert.equal(result.totals.sessionCount, 0);
  assert.equal(result.totals.processedTokens, 0);
  assert.equal(result.totals.storageBytes, 0);
  assert.deepEqual(result.rows.map((row) => ({
    user: row.user,
    project: row.projectKey,
    timeStart: row.timeStart,
    prompts: row.promptCount,
    sessions: row.sessionCount,
    tokens: row.processedTokens,
  })), [{
    user: "bob@example.com",
    project: "peon",
    timeStart: "2026-07-17T00:00:00.000Z",
    prompts: 2,
    sessions: 0,
    tokens: 0,
  }]);
  assert.equal(result.attribution.promptTime, "user_message_created_at");
  assert.match(result.attribution.note, /Session counts, wall duration, outcome, and storage remain selected by session start/);
});

test("usage follows the turn that spent it, not the session that started first", () => {
  const yesterday = Date.parse("2026-07-16T10:15:00.000Z");
  const priorSession = record({
    id: "prior-session",
    startedAt: yesterday,
    endedAt: Date.parse("2026-07-17T11:35:00.000Z"),
    lastActivityAt: Date.parse("2026-07-17T11:35:00.000Z"),
    lastUserMessageAt: Date.parse("2026-07-17T11:30:00.000Z"),
    usage: {
      inputTokens: 300,
      outputTokens: 60,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 3_000,
      totalCostUsd: 0.3,
    },
  });
  const turn = (tokens: number, createdAt: number) => ({
    type: "result" as const,
    createdAt,
    duration_ms: 1_000,
    total_cost_usd: 0.1,
    usage: { input_tokens: tokens, output_tokens: tokens / 5 },
  });
  const transcript = [
    { type: "user_message" as const, text: "initial", author: "alice@example.com", createdAt: yesterday },
    turn(100, Date.parse("2026-07-16T10:20:00.000Z")),
    { type: "user_message" as const, text: "today", author: "bob@example.com", createdAt: Date.parse("2026-07-17T11:30:00.000Z") },
    turn(100, Date.parse("2026-07-17T11:32:00.000Z")),
    turn(100, Date.parse("2026-07-17T11:35:00.000Z")),
  ];

  const today = analyticsForSessions(
    [priorSession],
    parseSessionAnalyticsQuery({ period: "day", groupBy: "user" }, NOW),
    undefined,
    NOW,
    () => transcript,
  );
  assert.deepEqual(today.rows.map((row) => [row.user, row.promptCount, row.inputTokens, row.outputTokens]), [
    ["bob@example.com", 1, 200, 40],
  ]);
  assert.equal(today.totals.inputTokens, 200);
  assert.equal(today.totals.sessionCount, 0);
  assert.equal(today.totals.providerDurationMs, 2_000);
  assert.equal(today.totals.usageTurnsAttributed, 2);
  assert.equal(today.totals.usageSessionsEstimated, 0);

  const everything = analyticsForSessions(
    [priorSession],
    parseSessionAnalyticsQuery({ period: "all", groupBy: "user" }, NOW),
    undefined,
    NOW,
    () => transcript,
  );
  assert.deepEqual(everything.rows.map((row) => [row.user, row.inputTokens]), [
    ["alice@example.com", 100],
    ["bob@example.com", 200],
  ]);
  // The record stays authoritative: its totals are reproduced exactly, and the
  // three turns account for all of them, so nothing is left to estimate.
  assert.equal(everything.totals.inputTokens, priorSession.usage!.inputTokens);
  assert.equal(everything.totals.outputTokens, priorSession.usage!.outputTokens);
  assert.equal(everything.totals.attributionQuality, "exact");
  assert.equal(everything.totals.usageSessionsEstimated, 0);
});

test("a branch does not re-charge the inherited turns of the session it came from", () => {
  const inheritedAt = Date.parse("2026-07-17T09:00:00.000Z");
  const ownAt = Date.parse("2026-07-17T10:00:00.000Z");
  const branch = record({
    id: "branch",
    branchedFromSessionId: "session-1",
    initiator: "bob@example.com",
    startedAt: Date.parse("2026-07-17T09:59:00.000Z"),
    endedAt: ownAt,
    lastActivityAt: ownAt,
    lastUserMessageAt: ownAt,
    // Only the branch's own turn — the inherited transcript rows were never
    // folded into this record.
    usage: {
      inputTokens: 30,
      outputTokens: 6,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 500,
      totalCostUsd: 0.05,
    },
  });
  const transcript = [
    { type: "user_message" as const, text: "source turn", author: "alice@example.com", createdAt: inheritedAt },
    { type: "result" as const, createdAt: inheritedAt, usage: { input_tokens: 100, output_tokens: 20 } },
    { type: "user_message" as const, text: "branch turn", author: "bob@example.com", createdAt: ownAt },
    { type: "result" as const, createdAt: ownAt, usage: { input_tokens: 30, output_tokens: 6 } },
  ];
  const result = analyticsForSessions(
    [branch],
    parseSessionAnalyticsQuery({ period: "all", groupBy: "user" }, NOW),
    undefined,
    NOW,
    () => transcript,
  );

  assert.deepEqual(result.rows.map((row) => [row.user, row.inputTokens, row.outputTokens]), [
    ["alice@example.com", 0, 0],
    ["bob@example.com", 30, 6],
  ]);
  assert.equal(result.totals.inputTokens, 30);
  assert.equal(result.totals.attributionQuality, "exact");
});

test("usage a transcript cannot account for is attributed to the initiator at session start", () => {
  const partial = record({
    id: "partial",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 1_000,
      totalCostUsd: 0.25,
    },
  });
  const transcript = [
    { type: "user_message" as const, text: "initial", author: "alice@example.com", createdAt: partial.startedAt },
    { type: "user_message" as const, text: "follow-up", author: "bob@example.com", createdAt: partial.startedAt + 60_000 },
    {
      type: "result" as const,
      createdAt: partial.startedAt + 120_000,
      usage: { input_tokens: 40, output_tokens: 8 },
    },
  ];
  const result = analyticsForSessions(
    [partial],
    parseSessionAnalyticsQuery({ period: "all", groupBy: "user" }, NOW),
    undefined,
    NOW,
    () => transcript,
  );

  assert.deepEqual(result.rows.map((row) => [row.user, row.inputTokens, row.outputTokens]), [
    ["alice@example.com", 60, 12],
    ["bob@example.com", 40, 8],
  ]);
  assert.equal(result.totals.inputTokens, 100);
  assert.equal(result.totals.outputTokens, 20);
  assert.equal(result.totals.usageTurnsAttributed, 1);
  assert.equal(result.totals.usageSessionsEstimated, 1);
  assert.equal(result.totals.attributionQuality, "estimated");
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
