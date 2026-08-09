import assert from "node:assert/strict";
import test from "node:test";
import {
  observeSessionCatalogDuration,
  observeSessionCatalogEvent,
  resetSessionCatalogObservabilityForTest,
  sessionCatalogObservabilitySnapshot,
} from "./sessionCatalogObservability.js";

test("session catalog observability is bounded and payload-free", () => {
  resetSessionCatalogObservabilityForTest();
  const secret = "private prompt /secret/path actor@example.com";
  for (let index = 0; index < 1_000; index += 1) {
    observeSessionCatalogEvent(`${secret}-${index}`);
    observeSessionCatalogDuration(`${secret}-${index}`, `${secret}-${index}`, index);
  }
  observeSessionCatalogDuration("client_apply", "success", 1_250);
  const snapshot = sessionCatalogObservabilitySnapshot() as { counters: Record<string, number>; durations: Record<string, { buckets: Record<string, number> }> };
  assert.deepEqual(Object.keys(snapshot.counters), ["other"]);
  assert.deepEqual(Object.keys(snapshot.durations), ["other:protocol_error", "client_apply:success"]);
  assert.deepEqual(Object.keys(snapshot.durations["client_apply:success"]!.buckets), [
    "le_100", "le_250", "le_500", "le_1000", "le_2000", "le_5000", "le_10000", "le_30000", "le_60000", "overflow",
  ]);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
});
