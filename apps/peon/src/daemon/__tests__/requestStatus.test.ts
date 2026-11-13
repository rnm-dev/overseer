import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../agents/index.js";
import { INITIAL_REQUEST, requestStatus } from "../sessions/requestStatus.js";
import type { SessionRecord } from "../sessions/sessionTypes.js";

// A request is the turn its create or follow-up opened; its status comes from
// the queue and the transcript, never from the session as a whole.

const record = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({ id: "s1", status: "completed", queuedFollowUps: [], settledState: null, ...over }) as unknown as SessionRecord;
const user = (commandId?: string): AgentEvent => ({ type: "user_message", text: "do it", ...(commandId ? { commandId } : {}) }) as AgentEvent;
const say = (text: string, extra: Record<string, unknown> = {}): AgentEvent =>
  ({ type: "assistant", message: { content: [{ type: "text", text }] }, ...extra }) as AgentEvent;
const result = (isError = false, errors: string[] = []): AgentEvent => ({ type: "result", is_error: isError, errors }) as AgentEvent;

test("the initial request is the first turn, with its last top-level text", () => {
  const events = [user(), say("working"), say("sub", { parent_tool_use_id: "t1" }), say("done: PR #4"), result(), user("f1"), say("later")];
  const status = requestStatus(record(), events, INITIAL_REQUEST);
  assert.equal(status.status, "completed");
  assert.equal(status.text, "done: PR #4");
  assert.equal(status.awaitingSignoff, false);
});

test("a follow-up still in the queue is queued, with its place", () => {
  const status = requestStatus(record({
    status: "running",
    queuedFollowUps: [{ commandId: "other" }, { commandId: "f2" }] as SessionRecord["queuedFollowUps"],
  }), [user()], "f2");
  assert.deepEqual([status.status, status.queuePosition], ["queued", 2]);
});

test("the last turn of a running session is running; an earlier one is finished", () => {
  const events = [user(), say("a"), result(), user("f1"), say("b")];
  assert.equal(requestStatus(record({ status: "running" }), events, "f1").status, "running");
  assert.equal(requestStatus(record({ status: "running" }), events, INITIAL_REQUEST).status, "completed");
});

test("a failed turn reports its error; a sign-off wait is reported on the last turn only", () => {
  const failed = requestStatus(record(), [user("f1"), result(true, ["boom"])], "f1");
  assert.deepEqual([failed.status, failed.error], ["failed", "boom"]);
  const waiting = requestStatus(record({ settledState: "awaiting_signoff" }), [user(), result(), user("f1"), say("asked"), result()], "f1");
  assert.equal(waiting.awaitingSignoff, true);
  assert.equal(requestStatus(record({ settledState: "awaiting_signoff" }), [user(), result(), user("f1"), result()], INITIAL_REQUEST).awaitingSignoff, false);
});

test("an unknown request id is unknown", () => {
  assert.equal(requestStatus(record(), [user()], "nope").status, "unknown");
});
