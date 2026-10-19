import assert from "node:assert/strict";
import test from "node:test";
import { activeRunReducer, initialActiveRun, type ActiveRun } from "./sessionRunState";

const running: ActiveRun = { sessionKey: "a", running: true, model: "m", reasoningEffort: "high", assumedAt: 5 };

test("initial state trusts the indexed summary as an assumption", () => {
  assert.deepEqual(initialActiveRun("a", "running", 10), { sessionKey: "a", running: true, model: null, reasoningEffort: null, assumedAt: 10 });
  assert.deepEqual(initialActiveRun("a", "idle", 10), { sessionKey: "a", running: false, model: null, reasoningEffort: null, assumedAt: null });
});

test("set-running keeps the selection only while the same session stays running", () => {
  assert.deepEqual(activeRunReducer(running, { type: "set-running", sessionKey: "a", running: true }), { ...running, assumedAt: null });
  assert.deepEqual(activeRunReducer(running, { type: "set-running", sessionKey: "a", running: false }), { sessionKey: "a", running: false, model: null, reasoningEffort: null, assumedAt: null });
  assert.deepEqual(activeRunReducer(running, { type: "set-running", sessionKey: "b", running: true }), { sessionKey: "b", running: true, model: null, reasoningEffort: null, assumedAt: null });
});

test("set-selection never carries another session's run", () => {
  assert.deepEqual(activeRunReducer(running, { type: "set-selection", sessionKey: "a", model: "x", reasoningEffort: null }), { ...running, model: "x", reasoningEffort: null });
  assert.deepEqual(activeRunReducer(running, { type: "set-selection", sessionKey: "b", model: "x", reasoningEffort: "low" }), { sessionKey: "b", running: false, model: "x", reasoningEffort: "low", assumedAt: null });
});

test("seed-indexed leaves an already running session untouched", () => {
  assert.equal(activeRunReducer(running, { type: "seed-indexed", sessionKey: "a", now: 99 }), running);
  assert.deepEqual(activeRunReducer({ ...running, running: false }, { type: "seed-indexed", sessionKey: "a", now: 99 }), { sessionKey: "a", running: true, model: null, reasoningEffort: null, assumedAt: 99 });
});

test("snapshot-running preserves same-session details", () => {
  const idle = { ...running, running: false };
  assert.deepEqual(activeRunReducer(idle, { type: "snapshot-running", sessionKey: "a" }), running);
  assert.deepEqual(activeRunReducer(idle, { type: "snapshot-running", sessionKey: "b" }), { sessionKey: "b", running: true, model: null, reasoningEffort: null, assumedAt: null });
});

test("retire-assumed only retires an unconfirmed assumption", () => {
  assert.deepEqual(activeRunReducer(running, { type: "retire-assumed", sessionKey: "a" }), { sessionKey: "a", running: false, model: null, reasoningEffort: null, assumedAt: null });
  const confirmed = { ...running, assumedAt: null };
  assert.equal(activeRunReducer(confirmed, { type: "retire-assumed", sessionKey: "a" }), confirmed);
  assert.equal(activeRunReducer(running, { type: "retire-assumed", sessionKey: "b" }), running);
});
