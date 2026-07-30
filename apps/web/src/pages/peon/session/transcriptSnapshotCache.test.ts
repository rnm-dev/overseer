import assert from "node:assert/strict";
import test from "node:test";
import {
  cachedTranscriptSnapshot,
  clearTranscriptSnapshotCacheForTests,
  prefetchTranscriptSnapshot,
  preparedTranscriptSnapshot,
  rememberTranscriptSnapshot,
} from "./transcriptSnapshotCache";
import type { TranscriptResponse } from "./transcriptPagination";

test("prefetch deduplicates intent and leaves a snapshot for immediate opening", async () => {
  clearTranscriptSnapshotCacheForTests();
  let requests = 0;
  let resolveRequest!: (value: TranscriptResponse) => void;
  const request = () => {
    requests += 1;
    return new Promise<TranscriptResponse>((resolve) => {
      resolveRequest = resolve;
    });
  };

  const first = prefetchTranscriptSnapshot("/peon", "session-1", true, request, 100);
  const second = prefetchTranscriptSnapshot("/peon", "session-1", true, request, 100);
  assert.equal(requests, 1);
  assert.equal(preparedTranscriptSnapshot("/peon", "session-1", true, 100), first);

  resolveRequest({
    events: [{ type: "assistant", eventId: "event-1", text: "ready" }],
    nextCursor: "older",
    hasMore: true,
  });
  assert.equal(await first, await second);
  assert.ok(preparedTranscriptSnapshot("/peon", "session-1", true, Date.now()));
  assert.equal(cachedTranscriptSnapshot("/peon", "session-1", true)?.events[0]?.eventId, "event-1");
});

test("cache is bounded and keeps recently read transcripts", () => {
  clearTranscriptSnapshotCacheForTests();
  for (let index = 0; index < 13; index += 1) {
    rememberTranscriptSnapshot("/peon", `session-${index}`, true, {
      events: [{ type: "assistant", eventId: `event-${index}` }],
      paginated: true,
      nextCursor: null,
      hasMore: false,
    });
  }
  assert.equal(cachedTranscriptSnapshot("/peon", "session-0", true), null);
  assert.equal(cachedTranscriptSnapshot("/peon", "session-12", true)?.events[0]?.eventId, "event-12");
});
