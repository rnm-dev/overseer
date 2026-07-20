import test from "node:test";
import assert from "node:assert/strict";
import {
  canTailCommitPending,
  canLiveCommitPending,
  numericTailId,
  orderLiveEvents,
  reconcileAuthoritativeSnapshot,
  reconcileDurableSnapshot,
  sameUserMessage,
  type PendingEcho,
} from "./transcriptMerge";
import type { Ev } from "./parsing";

test("numeric SSE ids remain stable identities across timestamp enrichment", () => {
  assert.equal(numericTailId("17"), 17);
  assert.equal(numericTailId("0"), null);
  assert.equal(numericTailId("event-17"), null);
});

test("identical messages at different SSE positions are both accepted", () => {
  const pending: PendingEcho = { clientId: "local", text: "again", author: "a@test", createdAt: 500, baselineTailId: 4 };
  assert.equal(canTailCommitPending(4, pending), false);
  assert.equal(canTailCommitPending(5, pending), true);
  assert.equal(canTailCommitPending(6, pending), true);
});

test("author display aliases do not break live echo matching", () => {
  const pending: PendingEcho = { clientId: "command-1", text: "test", author: "viktor.ten@me.com", createdAt: 500, baselineTailId: 4 };
  assert.equal(sameUserMessage({ type: "user_message", text: "test", author: "vibze" }, pending), true);
});

test("authoritative command ID wins over text and author heuristics", () => {
  const pending: PendingEcho = { clientId: "command-1", text: "test", author: "viktor.ten@me.com", createdAt: 500, baselineTailId: 4 };
  assert.equal(sameUserMessage({ type: "user_message", text: "test", author: "vibze", commandId: "command-1" }, pending), true);
  assert.equal(sameUserMessage({ type: "user_message", text: "test", author: "viktor.ten@me.com", commandId: "command-2" }, pending), false);
});

test("a durable user tail without a command ID immediately commits its optimistic echo", () => {
  const pending: PendingEcho = { clientId: "command-1", text: "test", author: "a@test", createdAt: 500, baselineTailId: null };
  assert.equal(canLiveCommitPending({ type: "user_message", text: "test" }, pending, null, "event-7"), true);
  assert.equal(canLiveCommitPending({ type: "user_message", text: "test", commandId: "other" }, pending, null, "event-7"), false);
  assert.equal(canLiveCommitPending({ type: "user_message", text: "different" }, pending, null, "event-7"), false);
});

test("late replay fills an SSE gap without breaking visible order", () => {
  const sixth: Ev = { type: "assistant", text: "sixth", _tailId: 6 };
  const fifth: Ev = { type: "assistant", text: "fifth", _tailId: 5 };
  const pending: Ev = { type: "user_message", text: "pending", _baselineTailId: 4, _optimistic: true };
  assert.deepEqual(orderLiveEvents([sixth, fifth, pending]), [pending, fifth, sixth]);
});

test("an optimistic row stays after every tail position already observed", () => {
  const optimistic: Ev = { type: "user_message", text: "next", _baselineTailId: 12, _optimistic: true };
  const delayedTenth: Ev = { type: "assistant", text: "tenth", _tailId: 10 };
  const twelfth: Ev = { type: "assistant", text: "twelfth", _tailId: 12 };
  assert.deepEqual(orderLiveEvents([optimistic, twelfth, delayedTenth]), [delayedTenth, twelfth, optimistic]);
});

test("an optimistic row with no numeric baseline stays after durable live events", () => {
  const latestAgent: Ev = { type: "assistant", text: "latest", _tailEventId: "event-12" };
  const optimistic: Ev = { type: "user_message", text: "next", _baselineTailId: 0, _optimistic: true };
  assert.deepEqual(orderLiveEvents([latestAgent, optimistic]), [latestAgent, optimistic]);
});

test("authoritative history replaces replayed and optimistic live rows", () => {
  const history: Ev[] = [
    { type: "user_message", text: "again", author: "a@test", createdAt: 100 },
    { type: "user_message", text: "again", author: "a@test", createdAt: 200 },
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
  ];
  const live: Ev[] = [
    { type: "user_message", text: "again", author: "a@test", createdAt: 190, _tailId: 2 },
    { type: "assistant", message: { content: [{ type: "text", text: "new" }] }, _tailId: 4 },
    { type: "user_message", text: "later", _clientId: "local", _optimistic: true },
  ];
  const pending: PendingEcho[] = [{ clientId: "local", text: "later", createdAt: 300, baselineTailId: 3 }];

  const result = reconcileAuthoritativeSnapshot(
    [...history, { type: "assistant", message: { content: [{ type: "text", text: "new" }] } }, { type: "user_message", text: "later", createdAt: 305 }],
    live,
    pending,
  );

  assert.deepEqual(result.live, []);
  assert.deepEqual(result.pending, []);
  assert.deepEqual([...result.matchedClientIds], ["local"]);
});

test("a pre-history optimistic echo never consumes an old identical message", () => {
  const echo: PendingEcho = { clientId: "local", text: "same", author: "a@test", createdAt: 10_000, baselineTailId: null };
  const events: Ev[] = [
    { type: "user_message", text: "same", author: "a@test", createdAt: 1_000 },
    { type: "user_message", text: "same", author: "a@test", createdAt: 10_005 },
  ];
  const result = reconcileAuthoritativeSnapshot(events, [{ type: "user_message", text: "same", _clientId: "local", _optimistic: true }], [echo]);
  assert.deepEqual(result.pending, []);
  assert.deepEqual([...result.matchedClientIds], ["local"]);
});

test("a later same-length snapshot can enrich and replace a pre-history echo", () => {
  const echo: PendingEcho = { clientId: "local", text: "same", createdAt: 10_000, baselineTailId: null };
  const live: Ev[] = [{ type: "user_message", text: "same", createdAt: 10_000, _clientId: "local", _optimistic: true }];

  const early = reconcileAuthoritativeSnapshot([{ type: "user_message", text: "same" }], live, [echo]);
  assert.equal(early.pending.length, 1);
  assert.equal(early.live.length, 1);

  const enriched = reconcileAuthoritativeSnapshot([{ type: "user_message", text: "same", createdAt: 10_005 }], early.live, early.pending);
  assert.deepEqual(enriched.pending, []);
  assert.deepEqual(enriched.live, []);
});

test("durable snapshot IDs remove only overlapping live frames", () => {
  const events: Ev[] = [{ type: "assistant", eventId: "event-b", text: "same" }];
  const live: Ev[] = [
    { type: "assistant", text: "same", _tailEventId: "event-a" },
    { type: "assistant", text: "same", _tailEventId: "event-b" },
    { type: "assistant", text: "same", _tailEventId: "event-c" },
  ];
  assert.deepEqual(reconcileDurableSnapshot(events, live, []).live.map((event) => event._tailEventId), ["event-a", "event-c"]);
});

test("durable snapshots reconcile optimistic echoes by command ID", () => {
  const echo: PendingEcho = { clientId: "command-1", text: "same", createdAt: 10_000, baselineTailId: null };
  const result = reconcileDurableSnapshot(
    [{ type: "user_message", eventId: "event-b", text: "same", commandId: "command-1" }],
    [{ type: "user_message", text: "same", _clientId: "command-1", _optimistic: true }],
    [echo],
  );
  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.live, []);
});
