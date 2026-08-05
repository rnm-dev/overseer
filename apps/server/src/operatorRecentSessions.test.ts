import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query, setPool } from "./infrastructure/db/index.js";
import { replaceMemberAccess } from "./access.js";
import { clampRecentSessionsLimit, listOperatorRecentSessions } from "./sessionIndex.js";
import { completeNextSessionAttention, markSessionAttentionRead, recordSessionRequest } from "./modules/sessions/index.js";

async function setup(): Promise<{ queries: () => number }> {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool() as unknown as pg.Pool;
  await initDb(pool);
  // Counting wrapper installed after migrations so only test traffic is counted.
  let count = 0;
  const inner = pool.query.bind(pool) as pg.Pool["query"];
  (pool as { query: unknown }).query = (...args: unknown[]) => {
    count += 1;
    return (inner as (...a: unknown[]) => unknown)(...args);
  };
  setPool(pool);
  return { queries: () => count };
}

async function indexSession(input: {
  peonId: string;
  sessionId: string;
  status?: string;
  title?: string | null;
  promptPreview?: string | null;
  preview?: string | null;
  projectKey?: string | null;
  projectId?: string | null;
  startedAt?: number | null;
  lastActivityAt?: number | null;
  syncedAt?: number;
  author?: string;
}): Promise<void> {
  await query(
    `INSERT INTO sessions (peon_id, session_id, status, project_key, project_id, title, prompt_preview, preview, author, started_at, last_activity_at, raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{}',$12)`,
    [
      input.peonId, input.sessionId, input.status ?? "running",
      input.projectKey ?? null, input.projectId ?? null, input.title ?? null,
      input.promptPreview ?? null, input.preview ?? null,
      input.author ?? "someone@example.com", input.startedAt ?? null, input.lastActivityAt ?? null,
      input.syncedAt ?? 1,
    ],
  );
}

const listFor = (userId: string, peonIds: string[], limit = 10) =>
  listOperatorRecentSessions({ workspaceId: "ws", userId, peonIds, limit });

test("recent sessions follow the operator's own requests, including follow-ups into another operator's session", async () => {
  await setup();
  await indexSession({ peonId: "p1", sessionId: "mine", lastActivityAt: 30 });
  await indexSession({ peonId: "p1", sessionId: "theirs-with-my-followup", lastActivityAt: 20, author: "other@example.com" });
  await indexSession({ peonId: "p1", sessionId: "theirs", lastActivityAt: 10, author: "other@example.com" });

  await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "p1", sessionId: "mine", occurrenceKey: "create:1", requestedAt: 5 });
  await recordSessionRequest({ workspaceId: "ws", userId: "user-2", peonId: "p1", sessionId: "theirs-with-my-followup", occurrenceKey: "create:2", requestedAt: 6 });
  await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "p1", sessionId: "theirs-with-my-followup", occurrenceKey: "followup:3", requestedAt: 7 });
  await recordSessionRequest({ workspaceId: "ws", userId: "user-2", peonId: "p1", sessionId: "theirs", occurrenceKey: "create:4", requestedAt: 8 });

  const mine = await listFor("user-1", ["p1"]);
  assert.deepEqual(mine.get("p1")?.map((session) => session.sessionId), ["mine", "theirs-with-my-followup"]);
  const theirs = await listFor("user-2", ["p1"]);
  assert.deepEqual(theirs.get("p1")?.map((session) => session.sessionId), ["theirs-with-my-followup", "theirs"]);
});

test("each Peon returns a bounded page in deterministic activity order", async () => {
  await setup();
  await indexSession({ peonId: "p1", sessionId: "b", lastActivityAt: 50, startedAt: 1 });
  await indexSession({ peonId: "p1", sessionId: "a", lastActivityAt: 50, startedAt: 2 });
  await indexSession({ peonId: "p1", sessionId: "older", lastActivityAt: 40 });
  await indexSession({ peonId: "p1", sessionId: "never-active", lastActivityAt: null, startedAt: 3 });
  await indexSession({ peonId: "p2", sessionId: "elsewhere", lastActivityAt: 60 });
  for (const [index, sessionId] of ["b", "a", "older", "never-active"].entries()) {
    await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "p1", sessionId, occurrenceKey: `create:${index}`, requestedAt: index });
  }
  await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "p2", sessionId: "elsewhere", occurrenceKey: "create:9", requestedAt: 9 });

  const all = await listFor("user-1", ["p1", "p2"]);
  assert.deepEqual(all.get("p1")?.map((session) => session.sessionId), ["a", "b", "older", "never-active"]);
  assert.deepEqual(all.get("p2")?.map((session) => session.sessionId), ["elsewhere"]);

  // The bound is per Peon — a busy Peon never crowds out a quiet one.
  const bounded = await listFor("user-1", ["p1", "p2"], 2);
  assert.deepEqual(bounded.get("p1")?.map((session) => session.sessionId), ["a", "b"]);
  assert.deepEqual(bounded.get("p2")?.map((session) => session.sessionId), ["elsewhere"]);
});

// The bug this projection was widened for: a row carrying only identity and
// attention state gives a client nothing to render, so every session showed as
// "Untitled session". Title, prompt and last-message previews all travel here.
test("every row carries the display fields a client needs to name a session", async () => {
  await setup();
  await indexSession({ peonId: "p1", sessionId: "titled", title: "Ship the fleet projection", promptPreview: "Ship it", preview: "Shipped", lastActivityAt: 30 });
  await indexSession({ peonId: "p1", sessionId: "prompted", title: null, promptPreview: "Investigate the flaky reconcile", preview: null, lastActivityAt: 20 });
  await indexSession({ peonId: "p1", sessionId: "previewed", title: null, promptPreview: null, preview: "Working on it", lastActivityAt: 10 });
  await indexSession({ peonId: "p1", sessionId: "long-prompt", promptPreview: "x".repeat(500), lastActivityAt: 5 });
  for (const [index, sessionId] of ["titled", "prompted", "previewed", "long-prompt"].entries()) {
    await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "p1", sessionId, occurrenceKey: `create:${index}`, requestedAt: index });
  }

  const rows = (await listFor("user-1", ["p1"])).get("p1") ?? [];
  const byId = new Map(rows.map((session) => [session.sessionId, session]));
  assert.equal(byId.get("titled")?.title, "Ship the fleet projection");
  assert.equal(byId.get("prompted")?.promptPreview, "Investigate the flaky reconcile");
  assert.equal(byId.get("previewed")?.preview, "Working on it");
  // Nothing displayable is ever null across all three fields at once.
  for (const session of rows) {
    assert.ok(session.title ?? session.promptPreview ?? session.preview, `${session.sessionId} has no display text`);
    assert.equal(session.peonId, "p1");
    assert.equal(session.syncedAt, 1);
  }
  assert.equal(byId.get("long-prompt")?.promptPreview?.length, 200, "the prompt preview is trimmed exactly like the canonical session list");
});

test("the limit is clamped to a small bounded range", () => {
  assert.equal(clampRecentSessionsLimit("3"), 3);
  assert.equal(clampRecentSessionsLimit("0"), 1);
  assert.equal(clampRecentSessionsLimit("-4"), 1);
  assert.equal(clampRecentSessionsLimit("999"), 10);
  assert.equal(clampRecentSessionsLimit("banana"), 5);
  assert.equal(clampRecentSessionsLimit(undefined), 5);
});

test("outstanding and unread projections track acceptance, completion and read acknowledgement", async () => {
  await setup();
  await indexSession({
    peonId: "p1", sessionId: "s1", lastActivityAt: 10, title: "Implement recent chats",
    promptPreview: "Implement the recent chats list", preview: "Done — the list renders",
    projectKey: "overseer-mobile", projectId: "project-1", startedAt: 5, syncedAt: 77,
  });
  await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "p1", sessionId: "s1", occurrenceKey: "create:1", requestedAt: 6 });

  const accepted = (await listFor("user-1", ["p1"])).get("p1")?.[0];
  assert.deepEqual(accepted, {
    peonId: "p1",
    sessionId: "s1",
    status: "running",
    title: "Implement recent chats",
    promptPreview: "Implement the recent chats list",
    preview: "Done — the list renders",
    projectId: "project-1",
    projectKey: "overseer-mobile",
    startedAt: 5,
    lastActivityAt: 10,
    syncedAt: 77,
    lastRequestedAt: 6,
    hasOutstandingRequest: true,
    attentionUnread: false,
    attentionUpdatedAt: 6,
  });

  await completeNextSessionAttention("ws", "p1", "s1", 20);
  const completed = (await listFor("user-1", ["p1"])).get("p1")?.[0];
  assert.equal(completed?.hasOutstandingRequest, false);
  assert.equal(completed?.attentionUnread, true);
  assert.equal(completed?.attentionUpdatedAt, 20);

  await markSessionAttentionRead("ws", "user-1", "p1", "s1");
  const read = (await listFor("user-1", ["p1"])).get("p1")?.[0];
  assert.equal(read?.hasOutstandingRequest, false);
  assert.equal(read?.attentionUnread, false);
  assert.ok((read?.attentionUpdatedAt ?? 0) >= 20, "the read acknowledgement is the newest attention timestamp");
  // Reading does not remove the session from the list: the UI decides how to
  // present an already-seen row.
  assert.equal(read?.sessionId, "s1");
});

// The trap this projection exists to avoid: opening a still-running session
// retires its occurrence to `read`, which must not strand the request as
// outstanding forever, and must not make a later run's completion vanish.
test("opening a still-running session leaves request lifecycle tracking intact", async () => {
  await setup();
  await indexSession({ peonId: "p1", sessionId: "s1", lastActivityAt: 10 });
  await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "p1", sessionId: "s1", occurrenceKey: "create:1", requestedAt: 5 });
  await markSessionAttentionRead("ws", "user-1", "p1", "s1");

  const watching = (await listFor("user-1", ["p1"])).get("p1")?.[0];
  assert.equal(watching?.hasOutstandingRequest, true, "reading acknowledges the answer, it does not finish the run");
  assert.equal(watching?.attentionUnread, false);

  await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "p1", sessionId: "s1", occurrenceKey: "followup:2", requestedAt: 15 });
  await completeNextSessionAttention("ws", "p1", "s1", 20);
  const firstDone = (await listFor("user-1", ["p1"])).get("p1")?.[0];
  assert.equal(firstDone?.hasOutstandingRequest, true, "the follow-up is still running");
  assert.equal(firstDone?.lastRequestedAt, 15);

  await completeNextSessionAttention("ws", "p1", "s1", 30);
  const allDone = (await listFor("user-1", ["p1"])).get("p1")?.[0];
  assert.equal(allDone?.hasOutstandingRequest, false);
  assert.equal(allDone?.attentionUnread, true);
});

test("requests from several operators in one session are attributed to their own requester", async () => {
  await setup();
  await indexSession({ peonId: "p1", sessionId: "s1", lastActivityAt: 10 });
  await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "p1", sessionId: "s1", occurrenceKey: "create:1", requestedAt: 5 });
  await recordSessionRequest({ workspaceId: "ws", userId: "user-2", peonId: "p1", sessionId: "s1", occurrenceKey: "followup:2", requestedAt: 6 });

  await completeNextSessionAttention("ws", "p1", "s1", 20);
  const first = (await listFor("user-1", ["p1"])).get("p1")?.[0];
  const second = (await listFor("user-2", ["p1"])).get("p1")?.[0];
  assert.equal(first?.hasOutstandingRequest, false, "the first request in the queue is the one that completed");
  assert.equal(first?.attentionUnread, true);
  assert.equal(second?.hasOutstandingRequest, true);
  assert.equal(second?.attentionUnread, false);

  await completeNextSessionAttention("ws", "p1", "s1", 30);
  assert.equal((await listFor("user-2", ["p1"])).get("p1")?.[0]?.hasOutstandingRequest, false);
  assert.equal((await listFor("user-2", ["p1"])).get("p1")?.[0]?.attentionUnread, true);
});

test("a member never receives sessions from a project they cannot open", async () => {
  await setup();
  await indexSession({ peonId: "p1", sessionId: "shared-session", projectKey: "shared", lastActivityAt: 20 });
  await indexSession({ peonId: "p1", sessionId: "secret-session", projectKey: "secret", lastActivityAt: 30 });
  await indexSession({ peonId: "p2", sessionId: "ungranted-peon-session", projectKey: "shared", lastActivityAt: 40 });
  for (const [index, session] of [["p1", "shared-session"], ["p1", "secret-session"], ["p2", "ungranted-peon-session"]].entries()) {
    await recordSessionRequest({ workspaceId: "ws", userId: "member", peonId: session[0], sessionId: session[1], occurrenceKey: `create:${index}`, requestedAt: index });
  }
  await replaceMemberAccess("ws", "member", { peonIds: ["p1"], projects: [{ peonId: "p1", projectKey: "shared" }] }, "owner");

  const scoped = await listOperatorRecentSessions({
    workspaceId: "ws", userId: "member", peonIds: ["p1", "p2"], limit: 10, access: { userId: "member" },
  });
  assert.deepEqual(scoped.get("p1")?.map((session) => session.sessionId), ["shared-session"]);
  assert.equal(scoped.get("p2"), undefined);

  // The same operator as an owner (no access scoping) still sees everything.
  const unscoped = await listFor("member", ["p1", "p2"]);
  assert.deepEqual(unscoped.get("p1")?.map((session) => session.sessionId), ["secret-session", "shared-session"]);
  assert.deepEqual(unscoped.get("p2")?.map((session) => session.sessionId), ["ungranted-peon-session"]);
});

test("the whole fleet's recent sessions cost one query, not one per Peon", async () => {
  const { queries } = await setup();
  const peonIds = ["p1", "p2", "p3", "p4", "p5"];
  for (const [index, peonId] of peonIds.entries()) {
    await indexSession({ peonId, sessionId: `s-${peonId}`, lastActivityAt: 10 + index });
    await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId, sessionId: `s-${peonId}`, occurrenceKey: "create:1", requestedAt: index });
  }

  const before = queries();
  const grouped = await listFor("user-1", peonIds);
  assert.equal(queries() - before, 1);
  assert.equal(grouped.size, peonIds.length);
});
