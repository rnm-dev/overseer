import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { WebSocket } from "ws";
import { initDb } from "./db.js";
import { claimSessionSyncGeneration } from "./sessionIndex.js";
import {
  getTranscriptState,
  readTranscriptAfter,
} from "./modules/sessions/index.js";
import {
  MAX_TRANSCRIPT_SUBSCRIPTIONS,
  PeonTranscriptSync,
  SESSION_TRANSCRIPT_CAPABILITY,
  TRANSCRIPT_CHANNEL_HELLO,
  type DurableTranscriptEvent,
} from "./peonTranscriptSync.js";
import type { PeonRecord } from "./registry.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  frames: Record<string, unknown>[] = [];
  closeCode: number | null = null;

  send(raw: string): void {
    this.frames.push(JSON.parse(raw) as Record<string, unknown>);
  }

  close(code: number): void {
    this.closeCode = code;
    this.readyState = WebSocket.CLOSED;
  }
}

function record(peonId = "p1"): PeonRecord {
  return {
    peonId,
    credentialId: "credential",
    workspaceId: "ws",
    name: "Peon",
    hostname: null,
    address: "127.0.0.1",
    controlPort: 4570,
    publicUrl: null,
    addressSource: "advertised",
    protocol: 1,
    capabilities: [],
    token: "token",
    connectionPinned: false,
    registeredAt: 1,
    lastSeen: 1,
    load: null,
  };
}

function published(seq: number): Record<string, unknown> {
  return {
    sessionId: "s1",
    epoch: "epoch-1",
    revision: seq,
    seq,
    eventId: `event-${seq}`,
    createdAt: 1_000 + seq,
    eventType: seq === 3 ? "result" : "assistant",
    author: null,
    usage: seq === 3 ? { output_tokens: 5 } : null,
    event: { type: seq === 3 ? "result" : "assistant", text: `event ${seq}` },
    artifactRefs: [],
  };
}

function durable(seq: number): DurableTranscriptEvent {
  return {
    channel: "transcript",
    deliveryEpoch: "delivery",
    deliveryCursor: `cursor-${seq}`,
    messageId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    sessionId: "s1",
    transcriptEpoch: "epoch-1",
    seq,
    revision: seq,
    eventId: `event-${seq}`,
    event: {
      type: seq === 3 ? "result" : "assistant",
      text: `event ${seq}`,
      eventId: `event-${seq}`,
      createdAt: 1_000 + seq,
      ...(seq === 3 ? { usage: { output_tokens: 5 } } : {}),
      reverseTranscript: {
        epoch: "epoch-1",
        revision: seq,
        seq,
        eventType: seq === 3 ? "result" : "assistant",
        createdAt: 1_000 + seq,
        author: null,
        usage: seq === 3 ? { output_tokens: 5 } : null,
        artifactRefs: [],
      },
    },
  };
}

async function setup(options: ConstructorParameters<typeof PeonTranscriptSync>[3] = {}) {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  const socket = new FakeSocket();
  const sync = new PeonTranscriptSync(
    record(),
    socket as unknown as WebSocket,
    "generation-1",
    options,
  );
  await claimSessionSyncGeneration("p1", sync.generation);
  sync.start();
  return { socket, sync };
}

async function waitForFrame(
  socket: FakeSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = socket.frames.find(predicate);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for frame; received ${JSON.stringify(socket.frames)}`);
}

test("snapshot demand is shared across browser consumers and preserves the Peon publication envelope", async () => {
  const { socket, sync } = await setup();
  const first = sync.acquire("s1");
  const second = sync.acquire("s1");
  await waitForFrame(socket, (frame) => frame.type === "transcript_snapshot_request");
  const requests = socket.frames.filter((frame) => frame.type === "transcript_snapshot_request");
  assert.equal(requests.length, 1, "one session demand must create one Peon snapshot");
  assert.equal(requests[0]?.subscribe, true);
  assert.equal(requests[0]?.limit, 100);

  await sync.handle({
    type: "transcript_snapshot_page",
    requestId: requests[0]!.requestId,
    sessionId: "s1",
    epoch: "epoch-1",
    revision: 2,
    barrierSeq: 2,
    events: [published(1), published(2)],
    nextCursor: null,
    hasMore: false,
  }, 1_024);
  const [releaseFirst, releaseSecond] = await Promise.all([first, second]);
  assert.equal(socket.frames.filter((frame) => frame.type === "transcript_snapshot_cancel").length, 1);
  assert.deepEqual(
    (await readTranscriptAfter({ peonId: "p1", sessionId: "s1" })).map((event) => [
      event.eventId,
      (event.reverseTranscript as { seq?: number }).seq,
    ]),
    [["event-1", 1], ["event-2", 2]],
  );

  releaseFirst();
  assert.equal(socket.frames.some((frame) => frame.type === "transcript_unsubscribe"), false);
  releaseSecond();
  const unsubscribe = socket.frames.find((frame) => frame.type === "transcript_unsubscribe");
  assert.equal(unsubscribe?.sessionId, "s1");
  assert.equal(typeof unsubscribe?.requestId, "string");
  sync.dispose();
});

test("restart resume uses epoch/afterSeq, live commits dedupe, and a sequence gap requests a fenced rebuild", async () => {
  const { socket, sync } = await setup();
  const initial = sync.acquire("s1");
  const snapshot = await waitForFrame(socket, (frame) => frame.type === "transcript_snapshot_request");
  await sync.handle({
    type: "transcript_snapshot_page",
    requestId: snapshot.requestId,
    sessionId: "s1",
    epoch: "epoch-1",
    revision: 2,
    barrierSeq: 2,
    events: [published(1), published(2)],
    nextCursor: null,
    hasMore: false,
  }, 512);
  (await initial)();

  const resumed = sync.acquire("s1");
  const subscribe = await waitForFrame(socket, (frame) => frame.type === "transcript_subscribe");
  assert.equal(subscribe.epoch, "epoch-1");
  assert.equal(subscribe.afterSeq, 2);
  assert.equal(typeof subscribe.requestId, "string");
  await sync.handle({
    type: "transcript_subscribed",
    requestId: subscribe.requestId,
    sessionId: "s1",
    epoch: "epoch-1",
    afterSeq: 2,
    expiresAt: Date.now() + 60_000,
  }, 100);
  const release = await resumed;

  assert.equal(await sync.prepareDurable(durable(3)), true);
  await sync.commitDurable(durable(3));
  await sync.commitDurable(durable(3));
  assert.deepEqual(
    (await readTranscriptAfter({ peonId: "p1", sessionId: "s1", lastEventId: "event-2" }))
      .map((event) => event.eventId),
    ["event-3"],
  );

  assert.equal(await sync.prepareDurable(durable(5)), false);
  const recovery = socket.frames.filter((frame) => frame.type === "transcript_snapshot_request").at(-1)!;
  assert.equal(recovery.sessionId, "s1");
  assert.equal((await getTranscriptState("p1", "s1"))?.status, "gap");
  await sync.handle({
    type: "transcript_snapshot_page",
    requestId: recovery.requestId,
    sessionId: "s1",
    epoch: "epoch-1",
    revision: 5,
    barrierSeq: 5,
    events: [published(1), published(2), published(3), published(4), published(5)],
    nextCursor: null,
    hasMore: false,
  }, 2_048);
  await sync.commitDurable(durable(5));
  assert.equal((await getTranscriptState("p1", "s1"))?.acknowledgedSeq, 5);
  assert.equal(SESSION_TRANSCRIPT_CAPABILITY, "transcript-sync-v1");
  release();
  sync.dispose();
});

test("unique active and pending transcript subscriptions obey the per-Peon cap", async () => {
  assert.equal(MAX_TRANSCRIPT_SUBSCRIPTIONS, 64);
  assert.equal(TRANSCRIPT_CHANNEL_HELLO.subscriptions, MAX_TRANSCRIPT_SUBSCRIPTIONS);
  const { socket, sync } = await setup({
    subscriptionLimit: 2,
    readyWaitMs: 500,
    subscriptionResponseMs: 500,
  });
  const first = sync.acquire("s1");
  const firstSnapshot = await waitForFrame(socket, (frame) =>
    frame.type === "transcript_snapshot_request" && frame.sessionId === "s1");
  await sync.handle({
    type: "transcript_snapshot_page",
    requestId: firstSnapshot.requestId,
    sessionId: "s1",
    epoch: "epoch-1",
    revision: 1,
    barrierSeq: 1,
    events: [{ ...published(1), sessionId: "s1" }],
    nextCursor: null,
    hasMore: false,
  }, 512);
  const releaseFirst = await first;
  const second = sync.acquire("s2");
  await waitForFrame(socket, (frame) =>
    frame.type === "transcript_snapshot_request" && frame.sessionId === "s2");
  assert.deepEqual(sync.subscriptionStats(), {
    activeOrPending: 2,
    pendingResponses: 0,
  });
  await assert.rejects(sync.acquire("s3"), /transcript subscription limit exceeded/);
  assert.equal(socket.frames.filter((frame) =>
    frame.type === "transcript_snapshot_request" && frame.sessionId === "s3").length, 0);
  const secondRejected = assert.rejects(second, /reverse transcript connection closed/);
  releaseFirst();
  sync.dispose();
  await secondRejected;
  assert.deepEqual(sync.subscriptionStats(), {
    activeOrPending: 0,
    pendingResponses: 0,
  });
});

test("release clears a correlated renewal that is still awaiting its Peon response", async () => {
  const { socket, sync } = await setup({ subscriptionResponseMs: 5_000 });
  const initial = sync.acquire("s1");
  const snapshot = await waitForFrame(socket, (frame) => frame.type === "transcript_snapshot_request");
  await sync.handle({
    type: "transcript_snapshot_page",
    requestId: snapshot.requestId,
    sessionId: "s1",
    epoch: "epoch-1",
    revision: 1,
    barrierSeq: 1,
    events: [published(1)],
    nextCursor: null,
    hasMore: false,
  }, 512);
  (await initial)();

  const acquired = sync.acquire("s1");
  const subscribed = await waitForFrame(
    socket,
    (frame) => frame.type === "transcript_subscribe" && frame.sessionId === "s1",
  );
  await sync.handle({
    type: "transcript_subscribed",
    requestId: subscribed.requestId,
    sessionId: "s1",
    epoch: "epoch-1",
    afterSeq: 1,
    expiresAt: Date.now() + 30_001,
  }, 128);
  const release = await acquired;
  await waitForFrame(
    socket,
    (frame) =>
      frame.type === "transcript_subscribe"
      && frame.sessionId === "s1"
      && frame.requestId !== subscribed.requestId,
  );
  assert.equal(sync.subscriptionStats().pendingResponses, 1);
  release();
  assert.deepEqual(sync.subscriptionStats(), {
    activeOrPending: 0,
    pendingResponses: 0,
  });
  sync.dispose();
});

test("a silent Peon cannot leak correlated pending subscription state", async () => {
  const { socket, sync } = await setup({
    // Initial projection setup performs real pg-mem migration/commit work and
    // may share a saturated parallel test runner. Keep that readiness budget
    // independent from the deliberately short unanswered-subscribe deadline.
    readyWaitMs: 5_000,
    subscriptionResponseMs: 250,
  });
  const initial = sync.acquire("s1");
  const snapshot = await waitForFrame(socket, (frame) => frame.type === "transcript_snapshot_request");
  await sync.handle({
    type: "transcript_snapshot_page",
    requestId: snapshot.requestId,
    sessionId: "s1",
    epoch: "epoch-1",
    revision: 1,
    barrierSeq: 1,
    events: [published(1)],
    nextCursor: null,
    hasMore: false,
  }, 512);
  (await initial)();

  const unanswered = sync.acquire("s1");
  await waitForFrame(socket, (frame) => frame.type === "transcript_subscribe");
  assert.deepEqual(sync.subscriptionStats(), {
    activeOrPending: 1,
    pendingResponses: 1,
  });
  await assert.rejects(unanswered, /reverse transcript connection closed|subscription timed out/);
  assert.equal(socket.closeCode, 1011);
  assert.deepEqual(sync.subscriptionStats(), {
    activeOrPending: 0,
    pendingResponses: 0,
  });
});

test("CURSOR_UNAVAILABLE and RESYNC_REQUIRED rebuild the same bounded demand", async () => {
  const { socket, sync } = await setup();
  const initial = sync.acquire("s1");
  const initialSnapshot = await waitForFrame(socket, (frame) =>
    frame.type === "transcript_snapshot_request");
  await sync.handle({
    type: "transcript_snapshot_page",
    requestId: initialSnapshot.requestId,
    sessionId: "s1",
    epoch: "epoch-1",
    revision: 1,
    barrierSeq: 1,
    events: [published(1)],
    nextCursor: null,
    hasMore: false,
  }, 512);
  (await initial)();

  const resumed = sync.acquire("s1");
  const subscribe = await waitForFrame(socket, (frame) => frame.type === "transcript_subscribe");
  await sync.handle({
    type: "transcript_error",
    requestId: subscribe.requestId,
    sessionId: "s1",
    code: "CURSOR_UNAVAILABLE",
  }, 128);
  const cursorRecovery = await waitForFrame(socket, (frame) =>
    frame.type === "transcript_snapshot_request"
    && frame.requestId !== initialSnapshot.requestId);
  assert.equal((await getTranscriptState("p1", "s1"))?.status, "gap");
  await sync.handle({
    type: "transcript_snapshot_page",
    requestId: cursorRecovery.requestId,
    sessionId: "s1",
    epoch: "epoch-1",
    revision: 2,
    barrierSeq: 2,
    events: [published(1), published(2)],
    nextCursor: null,
    hasMore: false,
  }, 768);
  const release = await resumed;

  await sync.handle({
    type: "transcript_error",
    requestId: "00000000-0000-4000-8000-000000000099",
    sessionId: "s1",
    code: "RESYNC_REQUIRED",
  }, 128);
  const resyncRecovery = socket.frames
    .filter((frame) => frame.type === "transcript_snapshot_request")
    .at(-1)!;
  assert.notEqual(resyncRecovery.requestId, cursorRecovery.requestId);
  assert.equal((await getTranscriptState("p1", "s1"))?.status, "gap");
  await sync.handle({
    type: "transcript_snapshot_page",
    requestId: resyncRecovery.requestId,
    sessionId: "s1",
    epoch: "epoch-1",
    revision: 3,
    barrierSeq: 3,
    events: [published(1), published(2), published(3)],
    nextCursor: null,
    hasMore: false,
  }, 1_024);
  assert.equal((await getTranscriptState("p1", "s1"))?.status, "ready");
  assert.deepEqual(sync.subscriptionStats(), {
    activeOrPending: 1,
    pendingResponses: 0,
  });
  release();
  sync.dispose();
});
