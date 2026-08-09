import test from "node:test";
import assert from "node:assert/strict";
import {
  combineVisibleTranscriptEvents,
  numericTailId,
  orderLiveEvents,
  reconcileAuthoritativeSnapshot,
  reconcileDurableSnapshot,
} from "./transcriptMerge";
import type { Ev } from "./parsing";

test("numeric SSE ids remain stable identities across timestamp enrichment", () => {
  assert.equal(numericTailId("17"), 17);
  assert.equal(numericTailId("0"), null);
  assert.equal(numericTailId("event-17"), null);
});

test("late replay fills an SSE gap without breaking visible order", () => {
  const sixth: Ev = { type: "assistant", text: "sixth", _tailId: 6 };
  const fifth: Ev = { type: "assistant", text: "fifth", _tailId: 5 };
  assert.deepEqual(orderLiveEvents([sixth, fifth]), [fifth, sixth]);
});

test("durable opaque-ID rows keep the order the tail delivered them in", () => {
  const first: Ev = { type: "user_message", text: "ask", _tailEventId: "event-11" };
  const second: Ev = { type: "assistant", text: "answer", _tailEventId: "event-12" };
  assert.deepEqual(orderLiveEvents([first, second]), [first, second]);
});

test("authoritative history hides the live row it has just taken over", () => {
  const history: Ev[] = [
    { type: "user_message", eventId: "event-7", commandId: "derived-1", text: "send once" },
    { type: "assistant", eventId: "event-8", text: "durable overlap" },
  ];
  const live: Ev[] = [
    { type: "user_message", text: "send once", _tailEventId: "event-7" },
    { type: "assistant", text: "still only live", _tailEventId: "event-9" },
  ];

  assert.deepEqual(combineVisibleTranscriptEvents(history, live), [...history, live[1]]);
});

test("a legacy snapshot supersedes every live row up to its length", () => {
  const events: Ev[] = [
    { type: "user_message", text: "again", createdAt: 100 },
    { type: "user_message", text: "again", createdAt: 200 },
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
  ];
  const fresher: Ev = { type: "assistant", text: "not in the snapshot yet", _tailId: 4 };
  const live: Ev[] = [
    { type: "user_message", text: "again", createdAt: 190, _tailId: 2 },
    fresher,
  ];

  assert.deepEqual(reconcileAuthoritativeSnapshot(events, live), [fresher]);
});

test("durable snapshot IDs remove only overlapping live frames", () => {
  const events: Ev[] = [{ type: "assistant", eventId: "event-b", text: "same" }];
  const live: Ev[] = [
    { type: "assistant", text: "same", _tailEventId: "event-a" },
    { type: "assistant", text: "same", _tailEventId: "event-b" },
    { type: "assistant", text: "same", _tailEventId: "event-c" },
  ];
  assert.deepEqual(reconcileDurableSnapshot(events, live).map((event) => event._tailEventId), ["event-a", "event-c"]);
});

test("repeating the same message stays two rows through both reconcilers", () => {
  // Nothing is matched by payload any more, so identical text cannot collapse.
  const durable: Ev[] = [
    { type: "user_message", eventId: "event-a", text: "again", createdAt: 10_000 },
    { type: "user_message", eventId: "event-b", text: "again", createdAt: 10_100 },
  ];
  assert.deepEqual(reconcileDurableSnapshot(durable, []), []);
  assert.equal(combineVisibleTranscriptEvents(durable, []).length, 2);
});
