import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../agents/index.js";
import type { TranscriptEntry } from "../sessions/sessionArtifacts.js";
import {
  MAX_TRANSCRIPT_PAGE_LIMIT,
  MAX_TRANSCRIPT_CURSOR_LENGTH,
  MAX_TRANSCRIPT_EVENT_ID_LENGTH,
  TranscriptPaginationError,
  paginateTranscript,
  parseTranscriptPageRequest,
  parseTranscriptResumeEventId,
  transcriptResumeIndex,
} from "../transcriptPagination.js";

function entries(count: number): TranscriptEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `event-${i}`,
    event: { type: "user_message", text: String(i) } as AgentEvent,
  }));
}

test("cursor pages walk backward with the session-pagination response shape", () => {
  const all = entries(10);
  const first = paginateTranscript("session-a", all, { limit: 3 });
  assert.deepEqual(first.events.map((event) => event.text), ["7", "8", "9"]);
  assert.deepEqual(first.events.map((event) => event.eventId), ["event-7", "event-8", "event-9"]);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, "string");

  const second = paginateTranscript("session-a", all, { limit: 3, cursor: first.nextCursor! });
  assert.deepEqual(second.events.map((event) => event.text), ["4", "5", "6"]);

  const third = paginateTranscript("session-a", all, { limit: 10, cursor: second.nextCursor! });
  assert.deepEqual(third.events.map((event) => event.text), ["0", "1", "2", "3"]);
  assert.equal(third.nextCursor, null);
  assert.equal(third.hasMore, false);
});

test("concurrent appends do not move a durable backward cursor", () => {
  const all = entries(5);
  const first = paginateTranscript("session-a", all, { limit: 2 });
  all.push(...entries(2).map((entry, index) => ({ ...entry, id: `new-${index}` })));
  const older = paginateTranscript("session-a", all, { limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(older.events.map((event) => event.text), ["1", "2"]);
});

test("request parsing mirrors session pagination and reports stable error classes", () => {
  assert.equal(parseTranscriptPageRequest(undefined, undefined), null);
  assert.deepEqual(parseTranscriptPageRequest(undefined, "cursor"), { limit: 50, cursor: "cursor" });
  assert.deepEqual(parseTranscriptPageRequest("999999", undefined), { limit: MAX_TRANSCRIPT_PAGE_LIMIT });
  assert.deepEqual(parseTranscriptPageRequest("9".repeat(100_000), undefined), { limit: MAX_TRANSCRIPT_PAGE_LIMIT });
  assert.throws(
    () => parseTranscriptPageRequest("0", undefined),
    (error: unknown) => error instanceof TranscriptPaginationError && error.code === "BAD_REQUEST",
  );
  assert.throws(
    () => parseTranscriptPageRequest(undefined, ""),
    (error: unknown) => error instanceof TranscriptPaginationError && error.code === "BAD_CURSOR",
  );
  assert.throws(
    () => parseTranscriptPageRequest(undefined, "x".repeat(MAX_TRANSCRIPT_CURSOR_LENGTH + 1)),
    (error: unknown) => error instanceof TranscriptPaginationError && error.code === "BAD_CURSOR",
  );
});

test("cursors are session-bound and reject unavailable boundaries", () => {
  const first = paginateTranscript("session-a", entries(4), { limit: 2 });
  assert.throws(
    () => paginateTranscript("session-b", entries(4), { limit: 2, cursor: first.nextCursor! }),
    (error: unknown) => error instanceof TranscriptPaginationError && error.code === "BAD_CURSOR",
  );
  assert.throws(
    () => paginateTranscript("session-a", entries(1), { limit: 2, cursor: first.nextCursor! }),
    (error: unknown) => error instanceof TranscriptPaginationError && error.code === "BAD_CURSOR",
  );
});

test("SSE resume boundaries recover gaps without replaying older entries", () => {
  const all = entries(5);
  assert.equal(transcriptResumeIndex(all, "event-2"), 3);
  assert.equal(transcriptResumeIndex(all, ""), 0);
  assert.equal(transcriptResumeIndex(all, "missing"), 0);
  assert.equal(transcriptResumeIndex(all, "3"), 3);
  assert.equal(parseTranscriptResumeEventId("event-2"), "event-2");
  assert.equal(parseTranscriptResumeEventId(""), "");
  assert.throws(
    () => parseTranscriptResumeEventId("x".repeat(MAX_TRANSCRIPT_EVENT_ID_LENGTH + 1)),
    (error: unknown) => error instanceof TranscriptPaginationError && error.code === "BAD_CURSOR",
  );
});
