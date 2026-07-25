import assert from "node:assert/strict";
import test from "node:test";
import { applyAttentionEvent, applyLocalSessionRunningChange, applySessionEvent, mergeSessions, sessionDisplayTitle, sessionFromIndex, sessionSidebarCanLoad } from "./sessionList";

test("sessionFromIndex uses the opening preview instead of latest activity", () => {
  assert.deepEqual(sessionFromIndex({
    peonId: "peon-1",
    sessionId: "session-1",
    title: "A session",
    promptPreview: "opening request",
    preview: "latest response",
  }), {
    peonId: "peon-1",
    id: "session-1",
    status: undefined,
    title: "A session",
    promptPreview: "opening request",
    lastMessagePreview: "latest response",
    projectKey: undefined,
    startedAt: undefined,
    endedAt: undefined,
    lastActivityAt: undefined,
    syncedAt: undefined,
  });
});

test("session titles prefer a designated name, then opening preview, then legacy prompt", () => {
  assert.equal(sessionDisplayTitle({ title: "Named", promptPreview: "Opening", prompt: "Legacy" }, "Untitled"), "Named");
  assert.equal(sessionDisplayTitle({ promptPreview: "Opening", prompt: "Legacy" }, "Untitled"), "Opening");
  assert.equal(sessionDisplayTitle({ prompt: "Legacy" }, "Untitled"), "Legacy");
  assert.equal(sessionDisplayTitle({}, "Untitled"), "Untitled");
});

test("session sidebar remains loadable independently of Peon socket state", () => {
  assert.equal(sessionSidebarCanLoad("workspace-1"), true);
  assert.equal(sessionSidebarCanLoad(undefined), false);
});

test("mergeSessions keeps equal session ids from different Peons and rejects stale HTTP summaries", () => {
  assert.deepEqual(mergeSessions(
    [{ peonId: "one", id: "same", title: "live", syncedAt: 20 }],
    [
      { peonId: "one", id: "same", title: "stale", syncedAt: 10 },
      { peonId: "two", id: "same", title: "other", syncedAt: 10 },
    ],
  ), [
    { peonId: "one", id: "same", title: "live", syncedAt: 20 },
    { peonId: "two", id: "same", title: "other", syncedAt: 10 },
  ]);
});

test("mergeSessions deduplicates overlapping pages and applies newer summaries", () => {
  assert.deepEqual(mergeSessions(
    [{ id: "one", title: "old" }, { id: "two" }],
    [{ id: "one", title: "new" }, { id: "three" }],
  ), [
    { id: "one", title: "new" },
    { id: "two" },
    { id: "three" },
  ]);
});

test("applySessionEvent removes a deleted session without touching the same id on another Peon", () => {
  const sessions = [
    { peonId: "one", id: "same", syncedAt: 10 },
    { peonId: "two", id: "same", syncedAt: 10 },
  ];
  assert.deepEqual(applySessionEvent(sessions, { peonId: "one", sessionId: "same", deleted: true, syncedAt: 11 }), [sessions[1]]);
  assert.deepEqual(applySessionEvent(sessions, { peonId: "one", sessionId: "same", deleted: true, syncedAt: 9 }), sessions);
});

test("attention events update only the matching Peon-qualified session", () => {
  const sessions = [
    { peonId: "one", id: "same", attentionUnread: false },
    { peonId: "two", id: "same", attentionUnread: false },
  ];
  assert.deepEqual(applyAttentionEvent(sessions, { peonId: "one", sessionId: "same", unread: true }), [
    { peonId: "one", id: "same", attentionUnread: true },
    sessions[1],
  ]);
});

test("a Peon-qualified live summary is replaced by the indexed refresh instead of duplicated", () => {
  const live = sessionFromIndex({
    peonId: "peon-1",
    sessionId: "session-1",
    status: "running",
    title: null,
    preview: null,
    syncedAt: 10,
  });
  const indexed = sessionFromIndex({
    peonId: "peon-1",
    sessionId: "session-1",
    status: "running",
    title: "Properly named session",
    preview: "opening prompt",
    syncedAt: 20,
  });

  assert.deepEqual(mergeSessions(mergeSessions([], [live]), [indexed]), [{
    peonId: "peon-1",
    id: "session-1",
    status: "running",
    title: "Properly named session",
    promptPreview: "opening prompt",
    lastMessagePreview: "opening prompt",
    projectKey: undefined,
    startedAt: undefined,
    endedAt: undefined,
    lastActivityAt: undefined,
    syncedAt: 20,
  }]);
});

test("local run transitions keep the matching sidebar row active until durable summaries arrive", () => {
  const sessions = [
    { peonId: "one", id: "same", status: "completed", endedAt: 100, lastActivityAt: 100, syncedAt: 7 },
    { peonId: "two", id: "same", status: "completed", endedAt: 100, lastActivityAt: 100, syncedAt: 8 },
  ];
  const running = applyLocalSessionRunningChange(sessions, "one", "same", true, 200);
  assert.deepEqual(running, [
    { peonId: "one", id: "same", status: "running", endedAt: null, lastActivityAt: 200, syncedAt: 7, localRunningSince: 200 },
    sessions[1],
  ]);
  assert.deepEqual(mergeSessions(running, [
    { peonId: "one", id: "same", status: "completed", endedAt: 190, lastActivityAt: 190, syncedAt: 8 },
  ]), [
    { peonId: "one", id: "same", status: "running", endedAt: null, lastActivityAt: 200, syncedAt: 8, localRunningSince: 200 },
    sessions[1],
  ]);
  assert.deepEqual(mergeSessions(running, [
    { peonId: "one", id: "same", status: "running", endedAt: null, lastActivityAt: 210, syncedAt: 8 },
  ]), [
    { peonId: "one", id: "same", status: "running", endedAt: null, lastActivityAt: 210, syncedAt: 8 },
    sessions[1],
  ]);
  assert.deepEqual(applyLocalSessionRunningChange(running, "one", "same", false, 300), [
    { peonId: "one", id: "same", status: "completed", endedAt: 300, lastActivityAt: 300, syncedAt: 7, localRunningSince: undefined },
    sessions[1],
  ]);
  assert.equal(applyLocalSessionRunningChange(running, "one", "same", true, 250), running);
});
