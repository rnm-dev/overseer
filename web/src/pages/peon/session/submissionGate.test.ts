import test from "node:test";
import assert from "node:assert/strict";
import { createSubmissionGate } from "./submissionGate";

test("submission gate rejects same-tick duplicate submits", () => {
  const gate = createSubmissionGate();
  const first = gate.begin("peon:session");
  assert.ok(first);
  assert.equal(gate.begin("peon:session"), null);
  assert.equal(gate.finish(first), true);
  assert.ok(gate.begin("peon:session"));
});

test("a new session supersedes stale in-flight completion", () => {
  const gate = createSubmissionGate();
  const oldRequest = gate.begin("peon:old");
  const newRequest = gate.begin("peon:new");
  assert.ok(oldRequest);
  assert.ok(newRequest);
  assert.equal(gate.finish(oldRequest), false);
  assert.equal(gate.begin("peon:new"), null);
  assert.equal(gate.finish(newRequest), true);
});
