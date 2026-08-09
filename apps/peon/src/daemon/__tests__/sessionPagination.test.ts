import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import type { SessionRecord } from "../sessions/sessionTypes.js";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-pagination-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-pagination-state-"));

const {
  MAX_SESSION_PAGE_LIMIT,
  SessionPaginationError,
  paginateSessions,
  parseSessionPageRequest,
} = await import("../sessions/sessionPagination.js");
const { settings } = await import("../settings/index.js");
const { createAgentRouter } = await import("../agentApi.js");

function record(id: string, lastActivityAt: number | undefined, startedAt: number): SessionRecord {
  return {
    id,
    prompt: id,
    title: null,
    followUpPrompts: [],
    queuedFollowUps: [],
    pendingSystemPrompts: [],
    dir: os.tmpdir(),
    agent: "codex",
    backendSessionId: null,
    model: null,
    reasoningEffort: null,
    projectKey: null,
    candidateProjectKeys: [],
    taskKey: null,
    taskTitle: null,
    initiator: null,
    expectsOutcome: false,
    status: "completed",
    outcome: null,
    startedAt,
    endedAt: startedAt,
    turnCount: 0,
    turnBudget: 0,
    usage: null,
    usageByModel: {},
    autoResumeAttempts: 0,
    lastActivityAt: lastActivityAt as number,
    lastUserMessageAt: startedAt,
    lastMessagePreview: null,
    eventCount: 0,
  };
}

function ids(page: { sessions: SessionRecord[] }): string[] {
  return page.sessions.map((session) => session.id);
}

test("keyset pages use activity order, deterministic id ties, and visit an unchanged dataset exactly once", () => {
  const records = [
    record("old", 100, 100),
    record("tie-a", 300, 300),
    record("newest", 400, 400),
    record("tie-b", 300, 300),
    record("fallback", undefined, 200),
  ];

  const first = paginateSessions(records, { limit: 2 });
  assert.deepEqual(ids(first), ["newest", "tie-b"]);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, "string");

  const second = paginateSessions(records, { limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(ids(second), ["tie-a", "fallback"]);
  assert.equal(second.hasMore, true);

  const final = paginateSessions(records, { limit: 2, cursor: second.nextCursor! });
  assert.deepEqual(ids(final), ["old"]);
  assert.equal(final.nextCursor, null);
  assert.equal(final.hasMore, false);

  assert.deepEqual([...ids(first), ...ids(second), ...ids(final)], ["newest", "tie-b", "tie-a", "fallback", "old"]);
});

test("new inserts ahead of a cursor do not skip older sessions", () => {
  const records = [record("four", 400, 400), record("three", 300, 300), record("two", 200, 200), record("one", 100, 100)];
  const first = paginateSessions(records, { limit: 2 });
  records.push(record("five", 500, 500));

  const second = paginateSessions(records, { limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(ids(first), ["four", "three"]);
  assert.deepEqual(ids(second), ["two", "one"]);
  assert.equal(second.hasMore, false);
});

test("moving a session ahead of a cursor does not skip untouched older sessions", () => {
  const records = [record("four", 400, 400), record("three", 300, 300), record("two", 200, 200), record("one", 100, 100)];
  const first = paginateSessions(records, { limit: 2 });
  records.find((session) => session.id === "two")!.lastActivityAt = 500;

  const second = paginateSessions(records, { limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(ids(second), ["one"]);
  assert.equal(second.hasMore, false);
});

test("pagination request validation defaults, clamps, and rejects invalid input", () => {
  assert.equal(parseSessionPageRequest(undefined, undefined), null);
  assert.deepEqual(parseSessionPageRequest(undefined, "cursor"), { limit: 50, cursor: "cursor" });
  assert.deepEqual(parseSessionPageRequest("999", undefined), { limit: MAX_SESSION_PAGE_LIMIT });
  assert.deepEqual(parseSessionPageRequest("999999999999999999999999", undefined), { limit: MAX_SESSION_PAGE_LIMIT });

  for (const value of ["0", "-1", "1.5", "abc", ["2"]]) {
    assert.throws(
      () => parseSessionPageRequest(value, undefined),
      (error: unknown) => error instanceof SessionPaginationError && error.code === "BAD_REQUEST",
    );
  }
  assert.throws(
    () => parseSessionPageRequest(undefined, ""),
    (error: unknown) => error instanceof SessionPaginationError && error.code === "BAD_CURSOR",
  );
});

const token = "pagination-test-token";
settings.update({ overseerToken: token });
const app = express();
app.use(express.json());
app.use("/api/v1", createAgentRouter());
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const headers = { Authorization: `Bearer ${token}`, "Peon-Actor": "owner@example.com" };

test.after(() => server.close());

test("fleet endpoint preserves legacy shape and returns the paginated envelope", async () => {
  const legacy = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, { headers });
  assert.equal(legacy.status, 200);
  assert.deepEqual(await legacy.json(), { sessions: [] });

  const paginated = await fetch(`http://127.0.0.1:${port}/api/v1/sessions?limit=999`, { headers });
  assert.equal(paginated.status, 200);
  assert.deepEqual(await paginated.json(), { sessions: [], nextCursor: null, hasMore: false });
});

test("fleet endpoint returns stable codes for invalid limits and cursors without changing authentication", async () => {
  const badLimit = await fetch(`http://127.0.0.1:${port}/api/v1/sessions?limit=0`, { headers });
  assert.equal(badLimit.status, 400);
  assert.deepEqual(await badLimit.json(), { error: "limit must be a positive integer", code: "BAD_REQUEST" });

  const badCursor = await fetch(`http://127.0.0.1:${port}/api/v1/sessions?cursor=not-a-cursor`, { headers });
  assert.equal(badCursor.status, 400);
  assert.deepEqual(await badCursor.json(), { error: "invalid session cursor", code: "BAD_CURSOR" });

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/v1/sessions?limit=1`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(((await unauthenticated.json()) as { code: string }).code, "UNAUTHENTICATED");
});
