import assert from "node:assert/strict";
import test from "node:test";
import { applySessionEvent, mergeSessions, sessionDisplayTitle, sessionFromIndex } from "./sessionList";

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
