import assert from "node:assert/strict";
import test from "node:test";
import {
  cachedTranscriptSnapshot,
  clearTranscriptSnapshotCache,
  clearTranscriptSnapshotCacheForTests,
  prefetchTranscriptSnapshot,
  preparedTranscriptSnapshot,
  readAuthoritativeTranscriptSnapshot,
  rememberTranscriptSnapshot,
  StaleTranscriptSnapshotError,
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
  assert.equal(preparedTranscriptSnapshot("/peon", "session-1", true), first);

  resolveRequest({
    events: [{ type: "assistant", eventId: "event-1", text: "ready" }],
    nextCursor: "older",
    hasMore: true,
  });
  assert.equal(await first, await second);
  assert.equal(preparedTranscriptSnapshot("/peon", "session-1", true), null);
  assert.equal(cachedTranscriptSnapshot("/peon", "session-1", true)?.events[0]?.eventId, "event-1");
});

test("a completed prefetch remains paint-only so opening revalidates before tailing", async () => {
  clearTranscriptSnapshotCacheForTests();
  let requests = 0;
  const request = async (): Promise<TranscriptResponse> => {
    requests += 1;
    return {
      events: [{ type: "assistant", eventId: `event-${requests}`, text: requests === 1 ? "cached" : "authoritative" }],
      nextCursor: null,
      hasMore: false,
    };
  };

  await prefetchTranscriptSnapshot("/peon", "session-1", true, request, 100);

  assert.equal(requests, 1);
  assert.equal(preparedTranscriptSnapshot("/peon", "session-1", true), null);
  assert.equal(cachedTranscriptSnapshot("/peon", "session-1", true)?.events[0]?.eventId, "event-1");
  const opened = await readAuthoritativeTranscriptSnapshot("/peon", "session-1", true, request);
  assert.equal(requests, 2);
  assert.equal(opened.events[0]?.eventId, "event-2");
  assert.equal(opened.events[0]?.text, "authoritative");
});

test("concurrent authoritative readers share one transcript request", async () => {
  clearTranscriptSnapshotCacheForTests();
  let requests = 0;
  let resolveRequest!: (value: TranscriptResponse) => void;
  const request = () => {
    requests += 1;
    return new Promise<TranscriptResponse>((resolve) => {
      resolveRequest = resolve;
    });
  };

  const first = readAuthoritativeTranscriptSnapshot("/peon", "session-1", true, request);
  const second = readAuthoritativeTranscriptSnapshot("/peon", "session-1", true, request);
  assert.equal(requests, 1);
  resolveRequest({ events: [], nextCursor: null, hasMore: false });
  assert.equal(await first, await second);
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

test("sign-out clearing drops cached pages and pending resume candidates", async () => {
  clearTranscriptSnapshotCacheForTests();
  let resolveRequest!: (value: TranscriptResponse) => void;
  const pending = prefetchTranscriptSnapshot("/peon", "session-pending", true, () =>
    new Promise<TranscriptResponse>((resolve) => {
      resolveRequest = resolve;
    }),
  );
  rememberTranscriptSnapshot("/peon", "session-cached", true, {
    events: [{ type: "assistant", eventId: "event-private" }],
    nextCursor: null,
    hasMore: false,
    paginated: true,
  });

  clearTranscriptSnapshotCache();

  assert.equal(cachedTranscriptSnapshot("/peon", "session-cached", true), null);
  assert.equal(preparedTranscriptSnapshot("/peon", "session-pending", true), null);
  resolveRequest({ events: [], nextCursor: null, hasMore: false });
  await assert.rejects(pending, StaleTranscriptSnapshotError);
  assert.equal(cachedTranscriptSnapshot("/peon", "session-pending", true), null);
});
