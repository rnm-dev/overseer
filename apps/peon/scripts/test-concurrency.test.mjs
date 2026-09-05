import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AUTO_TEST_CONCURRENCY,
  defaultTestConcurrency,
  resolveTestConcurrency,
} from "./test-concurrency.mjs";

test("automatic test concurrency reserves capacity and remains bounded", () => {
  assert.equal(defaultTestConcurrency(1), 1);
  assert.equal(defaultTestConcurrency(2), 1);
  assert.equal(defaultTestConcurrency(4), 2);
  assert.equal(defaultTestConcurrency(10), 8);
  assert.equal(defaultTestConcurrency(64), MAX_AUTO_TEST_CONCURRENCY);
});

test("an explicit test concurrency overrides the automatic policy", () => {
  assert.equal(resolveTestConcurrency("3", 64), 3);
  assert.equal(resolveTestConcurrency("12", 2), 12);
});

test("invalid explicit test concurrency fails instead of silently changing the schedule", () => {
  for (const value of ["0", "-1", "1.5", "four", " 4", "9007199254740992"]) {
    assert.throws(() => resolveTestConcurrency(value, 10), /PEON_TEST_CONCURRENCY/);
  }
});
