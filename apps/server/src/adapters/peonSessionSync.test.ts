import assert from "node:assert/strict";
import { test } from "node:test";
import { PeonCatalogSync, SessionSyncProtocolError } from "./peonSessionSync.js";

interface BufferHarness {
  bufferedEvents: Array<Record<string, unknown>>;
  bufferedEventFingerprints: Map<string, string>;
  bufferedBytes: number;
  bufferEvent(event: Record<string, unknown>, frameBytes: number): void;
}

function bufferHarness(): BufferHarness {
  const harness = Object.create(PeonCatalogSync.prototype) as BufferHarness;
  harness.bufferedEvents = [];
  harness.bufferedEventFingerprints = new Map();
  harness.bufferedBytes = 0;
  return harness;
}

const durableEvent = {
  channel: "session",
  deliveryEpoch: "delivery-1",
  deliveryCursor: "cursor-1",
  messageId: "00000000-0000-4000-8000-000000000001",
  catalogEpoch: "catalog-1",
  seq: 1,
  operation: "upsert",
  session: { id: "session-1", status: "running" },
};

test("snapshot buffering counts a retransmitted durable cursor only once", () => {
  const harness = bufferHarness();

  // Peon retries an unacknowledged durable window every 10 seconds while a
  // catalog snapshot intentionally defers ACKs. Cross the production limit
  // with one unique cursor: retries must not consume the bounded buffer.
  for (let retry = 0; retry <= 1_000; retry += 1) {
    harness.bufferEvent(durableEvent, 512);
  }

  assert.equal(harness.bufferedEvents.length, 1);
  assert.equal(harness.bufferedBytes, 512);
});

test("snapshot buffering rejects changed content under a durable cursor", () => {
  const harness = bufferHarness();
  harness.bufferEvent(durableEvent, 512);

  assert.throws(
    () => harness.bufferEvent({
      ...durableEvent,
      session: { id: "session-1", status: "completed" },
    }, 512),
    (error: unknown) => error instanceof SessionSyncProtocolError
      && error.message === "durable delivery cursor changed during catalog snapshots",
  );
});

test("requeued durable events retain bounded byte accounting", () => {
  const harness = bufferHarness();
  harness.bufferEvent({ ...durableEvent, session: { id: "session-1", status: "running", payload: "x".repeat(1024) } }, 0);

  assert.ok(harness.bufferedBytes >= 1024);
  assert.equal(harness.bufferedEvents.length, 1);
});
