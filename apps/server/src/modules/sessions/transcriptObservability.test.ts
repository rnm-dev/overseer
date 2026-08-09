import assert from "node:assert/strict";
import test from "node:test";
import {
  observeTranscriptDemand,
  observeTranscriptDuration,
  observeTranscriptEvent,
  resetTranscriptObservabilityForTest,
  transcriptObservabilitySnapshot,
} from "./transcriptObservability.js";

test("transcript observability has bounded cardinality and contains no supplied identifiers or payload", () => {
  resetTranscriptObservabilityForTest();
  const secret = "prompt-secret /private/attachment.txt actor@example.com";
  for (let index = 0; index < 1_000; index += 1) {
    observeTranscriptEvent(`${secret}-${index}`);
    observeTranscriptDuration("snapshot", `${secret}-${index}`, index);
  }
  observeTranscriptDemand([1, 3, 2]);
  const snapshot = transcriptObservabilitySnapshot() as {
    counters: Record<string, number>; durations: Record<string, unknown>;
    demand: { sessions: number; consumers: number; sharedConsumers: number };
  };
  assert.deepEqual(Object.keys(snapshot.counters), ["other"]);
  assert.deepEqual(Object.keys(snapshot.durations), ["snapshot:protocol_error"]);
  assert.deepEqual(
    Object.keys((snapshot.durations["snapshot:protocol_error"] as { buckets: Record<string, number> }).buckets),
    ["le_100", "le_250", "le_500", "le_1000", "le_2000", "le_5000", "le_10000", "le_30000", "le_60000", "overflow"],
  );
  assert.deepEqual(snapshot.demand, { sessions: 3, consumers: 6, sharedConsumers: 3 });
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
});
