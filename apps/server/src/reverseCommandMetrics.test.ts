import assert from "node:assert/strict";
import test from "node:test";
import {
  countReverseCommandMetric,
  resetReverseCommandMetricsForTest,
  reverseCommandMetricsSnapshot,
} from "./modules/reverseCommands/index.js";

test("reverse command metrics use bounded redacted labels", () => {
  resetReverseCommandMetricsForTest();
  countReverseCommandMetric("completed", "session.delete", "SESSION_NOT_RUNNING");
  countReverseCommandMetric("error", "attacker-operation-with-/private/path", "token-secret-value");
  assert.deepEqual(reverseCommandMetricsSnapshot(), {
    "completed:session.delete:SESSION_NOT_RUNNING": 1,
    "error:other:other": 1,
  });
  const encoded = JSON.stringify(reverseCommandMetricsSnapshot());
  for (const forbidden of ["/private/path", "token-secret-value", "prompt", "credential", "payload"]) {
    assert.equal(encoded.includes(forbidden), false);
  }
});
