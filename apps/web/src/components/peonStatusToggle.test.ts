import assert from "node:assert/strict";
import test from "node:test";
import { beginToggle, failToggle, finishToggle } from "./peonStatusToggle";

test("status toggle models loading, success, and rollback on error", () => {
  const loading = beginToggle(false);
  assert.deepEqual(loading, { paused: true, previous: false, loading: true, error: null });
  assert.deepEqual(finishToggle(loading), { paused: true, previous: false, loading: false, error: null });
  assert.deepEqual(failToggle(loading, "network failed"), {
    paused: false, previous: false, loading: false, error: "network failed",
  });
});
