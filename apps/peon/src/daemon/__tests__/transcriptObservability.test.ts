import assert from "node:assert/strict";
import test from "node:test";
import {
  observeOutboxPending,
  observeTranscriptAdmission,
  peonTranscriptObservabilitySnapshot,
  resetPeonTranscriptObservabilityForTest,
} from "../overseer/socket/transcriptObservability.js";

test("transcript outbox metrics aggregate fixed capability buckets without payloads or identifiers", () => {
  resetPeonTranscriptObservabilityForTest();
  const secret = "credential-secret /private/transcript.jsonl actor@example.com";
  observeTranscriptAdmission({ capability: "transcript-sync-v1", elapsedMs: 4, result: "accepted" });
  observeOutboxPending([
    { capability: "transcript-sync-v1", payloadBytes: 12, createdAt: 90 },
    { capability: `${secret}-one`, payloadBytes: 8, createdAt: 80 },
    { capability: `${secret}-two`, payloadBytes: 4, createdAt: 95 },
  ], 100);
  const serialized = JSON.stringify(peonTranscriptObservabilitySnapshot());
  assert.equal(serialized.includes(secret), false);
  assert.deepEqual(JSON.parse(serialized).pending, {
    "transcript-sync-v1": { count: 1, bytes: 12, oldestAgeMs: 10 },
    other: { count: 2, bytes: 12, oldestAgeMs: 20 },
  });
});

