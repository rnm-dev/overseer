import assert from "node:assert/strict";
import test from "node:test";
import { orderPinnedSessions } from "./useSessionPins";
test("old pins outside loaded pages stay first and live metadata wins", () => {
  const pins = [{ peonId: "p", id: "old", title: "stale", lastActivityAt: 1 }];
  const current = [{ id: "new", lastActivityAt: 100 }, { id: "old", title: "fresh", lastActivityAt: 2 }];
  const sorted = orderPinnedSessions(current, pins, "p");
  assert.deepEqual(sorted.map((s) => s.id), ["old", "new"]);
  assert.equal(sorted[0].title, "fresh");
  assert.deepEqual(orderPinnedSessions(current.slice(0,1), pins, "p").map((s) => s.id), ["old", "new"]);
  assert.deepEqual(orderPinnedSessions(current, [], "p").map((s) => s.id), ["new", "old"]);
});
test("same session ids on different peons remain distinct", () => {
  const rows = orderPinnedSessions([{ peonId: "q", id: "same", lastActivityAt: 10 }], [{ peonId: "p", id: "same", lastActivityAt: 1 }]);
  assert.deepEqual(rows.map((row) => row.peonId), ["p", "q"]);
});
test("unread sessions rank above read ones and keep that rank after being read", () => {
  const rows = [{ peonId: "u", id: "fresh", lastActivityAt: 100 }, { peonId: "u", id: "waiting", lastActivityAt: 1, attentionUnread: true }];
  assert.deepEqual(orderPinnedSessions(rows, []).map((s) => s.id), ["waiting", "fresh"]);
  const read = rows.map((row) => ({ ...row, attentionUnread: false }));
  assert.deepEqual(orderPinnedSessions(read, []).map((s) => s.id), ["waiting", "fresh"]);
});
test("unread rows outside loaded pages are listed first", () => {
  const rows = orderPinnedSessions([{ peonId: "v", id: "loaded", lastActivityAt: 100 }], [], "v", [{ peonId: "v", id: "old", lastActivityAt: 1, attentionUnread: true }]);
  assert.deepEqual(rows.map((s) => s.id), ["old", "loaded"]);
});
