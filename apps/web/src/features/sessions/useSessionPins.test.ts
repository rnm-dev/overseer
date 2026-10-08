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
