import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeNewestPage,
  parseTranscriptPage,
  prependOlderPage,
  shouldAutoLoadOlder,
  tailResumeBoundary,
  transcriptPageUrl,
} from "./transcriptPagination";
import type { Ev } from "./parsing";

const ev = (eventId: string, text: string): Ev => ({ type: "assistant", eventId, text });

test("capability gating leaves legacy Peon requests and responses unchanged", () => {
  assert.equal(transcriptPageUrl("/peon", "a/b", false), "/peon/sessions/a%2Fb/transcript");
  assert.deepEqual(parseTranscriptPage({ events: [ev("ignored", "legacy")] }), {
    events: [ev("ignored", "legacy")], paginated: false, nextCursor: null, hasMore: false,
  });
});

test("new Peons use opaque server cursors without deriving offsets", () => {
  assert.equal(transcriptPageUrl("/peon", "a/b", true), "/peon/sessions/a%2Fb/transcript?limit=50");
  assert.equal(transcriptPageUrl("/peon", "a/b", true, "opaque+/="), "/peon/sessions/a%2Fb/transcript?limit=50&cursor=opaque%2B%2F%3D");
  assert.deepEqual(parseTranscriptPage({ events: [ev("2", "two")], nextCursor: "before-2", hasMore: true }), {
    events: [ev("2", "two")], paginated: true, nextCursor: "before-2", hasMore: true,
  });
});

test("newest snapshots update overlap and append durable unseen events", () => {
  const current = parseTranscriptPage({ events: [ev("1", "one"), ev("2", "old")], nextCursor: "older", hasMore: true });
  const newest = parseTranscriptPage({ events: [ev("2", "enriched"), ev("3", "three")], nextCursor: "between", hasMore: true });
  const merged = mergeNewestPage(current, newest);
  assert.deepEqual(merged.events.map((event) => [event.eventId, event.text]), [["1", "one"], ["2", "enriched"], ["3", "three"]]);
  assert.equal(merged.nextCursor, "older");
});

test("older pages prepend once and advance only to their server cursor", () => {
  const current = parseTranscriptPage({ events: [ev("3", "three"), ev("4", "four")], nextCursor: "before-3", hasMore: true });
  const older = parseTranscriptPage({ events: [ev("1", "one"), ev("2", "two"), ev("3", "three")], nextCursor: null, hasMore: false });
  const merged = prependOlderPage(current, older);
  assert.deepEqual(merged.events.map((event) => event.eventId), ["1", "2", "3", "4"]);
  assert.equal(merged.hasMore, false);
  assert.equal(merged.nextCursor, null);
});

test("a tail never resumes from another session's boundary", () => {
  assert.deepEqual(tailResumeBoundary(null, "peon:a"), { subscribe: false });
  assert.deepEqual(tailResumeBoundary({ sessionKey: "peon:a", id: "ev-9" }, "peon:b"), { subscribe: false });
  assert.deepEqual(tailResumeBoundary({ sessionKey: "peon:a", id: "ev-9" }, "peon:a"), { subscribe: true, lastEventId: "ev-9" });
  // A snapshot with no durable boundary still subscribes; it just cannot resume.
  assert.deepEqual(tailResumeBoundary({ sessionKey: "peon:a", id: null }, "peon:a"), { subscribe: true, lastEventId: null });
});

test("older history is prefetched only for an operator who left the live end", () => {
  assert.equal(shouldAutoLoadOlder({ intersecting: true, pinnedToBottom: false }), true);
  // A transcript shorter than the window keeps the sentinel in view forever.
  assert.equal(shouldAutoLoadOlder({ intersecting: true, pinnedToBottom: true }), false);
  assert.equal(shouldAutoLoadOlder({ intersecting: false, pinnedToBottom: false }), false);
});
