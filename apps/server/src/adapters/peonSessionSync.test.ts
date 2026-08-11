import assert from "node:assert/strict";
import { test } from "node:test";
import { TranscriptProjectionError } from "../modules/sessions/index.js";
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

test("a transcript projection mismatch requests repair and buffers the durable cursor", async () => {
  const repaired: string[] = [];
  const harness = Object.create(PeonCatalogSync.prototype) as BufferHarness & {
    checkpoint: null;
    transcriptSync: {
      commitDurable(): Promise<never>;
      repairDurable(event: { sessionId: string }): Promise<void>;
    };
    applyEvent(event: Record<string, unknown>): Promise<void>;
  };
  harness.checkpoint = null;
  harness.bufferedEvents = [];
  harness.bufferedEventFingerprints = new Map();
  harness.bufferedBytes = 0;
  harness.transcriptSync = {
    commitDurable: async () => {
      throw new TranscriptProjectionError("REPLAY_MISMATCH", "event sequence changed");
    },
    repairDurable: async (event) => { repaired.push(event.sessionId); },
  };
  const event = {
    channel: "transcript",
    deliveryEpoch: "delivery-1",
    deliveryCursor: "cursor-1",
    messageId: "00000000-0000-4000-8000-000000000001",
    sessionId: "session-1",
  };

  await harness.applyEvent(event);

  assert.deepEqual(repaired, ["session-1"]);
  assert.equal(harness.bufferedEvents.length, 1);
  assert.equal(harness.bufferedEvents[0]?.deliveryCursor, "cursor-1");
});

test("selective scheduling preserves one session order while draining unrelated durable work", async () => {
  const applied: string[] = [];
  const harness = Object.create(PeonCatalogSync.prototype) as BufferHarness & {
    snapshot: null;
    projectSnapshot: null;
    selectiveAcks: boolean;
    transcriptSync: {
      hasActiveSnapshots(): boolean;
      prepareDurable(event: { sessionId: string }): Promise<boolean>;
    };
    applyEvent(event: { deliveryCursor: string }): Promise<void>;
    maybeDrainBuffered(): Promise<void>;
  };
  harness.snapshot = null;
  harness.projectSnapshot = null;
  harness.selectiveAcks = true;
  harness.bufferedEventFingerprints = new Map();
  harness.bufferedBytes = 0;
  harness.transcriptSync = {
    hasActiveSnapshots: () => true,
    prepareDurable: async (event) => event.sessionId !== "blocked",
  };
  harness.applyEvent = async (event) => { applied.push(event.deliveryCursor); };
  const transcript = (deliveryCursor: string, sessionId: string) => ({
    channel: "transcript",
    deliveryEpoch: "delivery",
    deliveryCursor,
    messageId: `00000000-0000-4000-8000-${deliveryCursor.padStart(12, "0")}`,
    sessionId,
    transcriptEpoch: "transcript",
    seq: 1,
    revision: 1,
    eventId: `event-${deliveryCursor}`,
    event: { type: "assistant", text: deliveryCursor },
  });
  harness.bufferedEvents = [
    transcript("1", "blocked"),
    transcript("2", "ready"),
    { ...transcript("3", "blocked"), deleted: true },
  ];

  await harness.maybeDrainBuffered();

  assert.deepEqual(applied, ["2"]);
  assert.deepEqual(harness.bufferedEvents.map((event) => event.deliveryCursor), ["1", "3"]);
});
