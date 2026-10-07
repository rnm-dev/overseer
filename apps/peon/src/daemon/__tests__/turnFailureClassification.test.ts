import assert from "node:assert/strict";
import test from "node:test";

import {
  explicitFailureReason,
  isTransientTurnFailure,
  resultFailureReason,
} from "../sessions/turnFailure.js";

test("a failure reason prefers errors[], then result, and falls back to the raw event", () => {
  assert.equal(resultFailureReason({ type: "result", errors: ["first", "second"] }), "first; second");
  assert.equal(resultFailureReason({ type: "result", errors: [], result: "the reason" }), "the reason");
  assert.equal(explicitFailureReason({ type: "result", result: "   " }), null);
  assert.equal(
    resultFailureReason({ type: "result", subtype: "error_during_execution" }),
    JSON.stringify({ type: "result", subtype: "error_during_execution" }),
  );
});

test("provider and transport faults are transient", () => {
  for (const reason of [
    "API Error: 500 Internal Server Error",
    "API Error: 529 {\"type\":\"overloaded_error\"}",
    "Bad gateway",
    "fetch failed: ECONNRESET",
    "socket hang up",
    "Stream disconnected before completion",
    "The request timed out, try again",
  ]) {
    assert.equal(isTransientTurnFailure({ reason, hasOutput: false }), true, reason);
  }
});

test("failures that need an operator are never retried", () => {
  for (const reason of [
    "API Error: 401 invalid api key",
    "Your credit balance is too low",
    "API Error: 429 rate_limit_error",
    "No conversation found with session ID: abc",
    "Exceeded max turns (1000) without concluding",
    "prompt is too long: 250000 tokens",
    "API Error: 400 invalid request",
  ]) {
    assert.equal(isTransientTurnFailure({ reason, hasOutput: false }), false, reason);
  }
});

test("a turn that already produced output is never replayed", () => {
  const reason = "API Error: 500 Internal Server Error";
  assert.equal(isTransientTurnFailure({ reason, hasOutput: false }), true);
  assert.equal(isTransientTurnFailure({ reason, hasOutput: true }), false);
});

test("a permanent signal anywhere in the text beats a transient one", () => {
  assert.equal(
    isTransientTurnFailure({
      subtype: "error_during_execution",
      reason: "Connection reset after 401 unauthorized",
      hasOutput: false,
    }),
    false,
  );
});
