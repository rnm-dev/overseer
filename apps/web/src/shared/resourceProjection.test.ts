import assert from "node:assert/strict";
import test from "node:test";
import { mergeResourceProjection, projectionIsStale } from "./resourceProjection.js";

test("resource projection core preserves qualified identities and monotonic versions", () => {
  const current = [{ id: "a", version: 2, value: "live" }, { id: "b", version: 1, value: "old" }];
  const merged = mergeResourceProjection(current, [
    { id: "a", version: 1, value: "stale" },
    { id: "b", version: 3, value: "new" },
  ], (item) => item.id, (item) => item.version);
  assert.deepEqual(merged, [{ id: "a", version: 2, value: "live" }, { id: "b", version: 3, value: "new" }]);
  assert.equal(projectionIsStale(2, 1), true);
  assert.equal(projectionIsStale(undefined, 1), false);
});
