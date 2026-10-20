import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TRANSCRIPT_PAGE_LIMIT,
  MAX_TRANSCRIPT_CURSOR_LENGTH,
  MAX_TRANSCRIPT_EVENT_ID_LENGTH,
  TranscriptPaginationError,
  decodeTranscriptCursor,
  encodeIndexedTranscriptCursor,
  parseTranscriptPageRequest,
  parseTranscriptResumeEventId,
} from "../sessions/transcriptPagination.js";

const badCursor = (error: unknown) => error instanceof TranscriptPaginationError && error.code === "BAD_CURSOR";

test("request parsing mirrors session pagination and reports stable error classes", () => {
  assert.equal(parseTranscriptPageRequest(undefined, undefined), null);
  assert.deepEqual(parseTranscriptPageRequest(undefined, "cursor"), { limit: 50, cursor: "cursor" });
  assert.deepEqual(parseTranscriptPageRequest("999999", undefined), { limit: MAX_TRANSCRIPT_PAGE_LIMIT });
  assert.deepEqual(parseTranscriptPageRequest("9".repeat(100_000), undefined), { limit: MAX_TRANSCRIPT_PAGE_LIMIT });
  assert.throws(
    () => parseTranscriptPageRequest("0", undefined),
    (error: unknown) => error instanceof TranscriptPaginationError && error.code === "BAD_REQUEST",
  );
  assert.throws(() => parseTranscriptPageRequest(undefined, ""), badCursor);
  assert.throws(() => parseTranscriptPageRequest(undefined, "x".repeat(MAX_TRANSCRIPT_CURSOR_LENGTH + 1)), badCursor);
});

test("cursors are session-bound and round-trip their index boundary", () => {
  const cursor = encodeIndexedTranscriptCursor("session-a", "event-7", 1_234);
  assert.deepEqual(decodeTranscriptCursor(cursor, "session-a"), { beforeEventId: "event-7", beforeIndexOffset: 1_234 });
  assert.throws(() => decodeTranscriptCursor(cursor, "session-b"), badCursor);
  assert.throws(() => decodeTranscriptCursor("not a cursor!", "session-a"), badCursor);
});

test("SSE resume event ids are bounded and charset-checked", () => {
  assert.equal(parseTranscriptResumeEventId("event-2"), "event-2");
  assert.equal(parseTranscriptResumeEventId(""), "");
  assert.equal(parseTranscriptResumeEventId(undefined), undefined);
  assert.throws(() => parseTranscriptResumeEventId("x".repeat(MAX_TRANSCRIPT_EVENT_ID_LENGTH + 1)), badCursor);
  assert.throws(() => parseTranscriptResumeEventId("bad id"), badCursor);
});
