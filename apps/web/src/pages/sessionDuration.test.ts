import assert from "node:assert/strict";
import test from "node:test";
import { formatStepDuration } from "./peon/session/messageParts";

test("current-step duration uses compact clock formatting", () => {
  assert.equal(formatStepDuration(-1), "0:00");
  assert.equal(formatStepDuration(999), "0:00");
  assert.equal(formatStepDuration(1_000), "0:01");
  assert.equal(formatStepDuration(65_000), "1:05");
  assert.equal(formatStepDuration(3_661_000), "1:01:01");
});
