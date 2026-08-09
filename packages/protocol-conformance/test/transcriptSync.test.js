import assert from "node:assert/strict";
import test from "node:test";
import {
  executeGoldenFrames,
  loadFixture,
  TranscriptHarnessError,
  TranscriptSyncHarness,
} from "../src/index.js";

const fixture = loadFixture("transcript-sync-v1.json");
const requestFrame = fixture.frames[0].frame;
const page = fixture.frames[1].frame;
const live = fixture.frames[2].frame;
const deletion = fixture.frames[3].frame;

function ready(options = {}) {
  const harness = new TranscriptSyncHarness(options);
  const demand = harness.acquire("session-a");
  assert.equal(harness.receiveSnapshot({ ...page, requestId: demand.requestId }), true);
  return harness;
}

test("shared transcript-sync-v1 golden frames match the released wire contract", () => {
  const report = executeGoldenFrames(fixture);
  assert.equal(report.failed, 0, report.cases.filter((entry) => !entry.passed).map((entry) => entry.errors).join("\n"));
  assert.equal(report.passed, fixture.frames.length);
});

test("snapshot barrier and live delivery converge across drop, duplicate, restart, and ACK loss", () => {
  for (const side of ["peon", "overseer"]) {
    const harness = new TranscriptSyncHarness();
    const first = harness.acquire("session-a");
    assert.equal(first.type, requestFrame.type);
    assert.equal(harness.acquire("session-a"), null, "many consumers share one Peon demand");
    assert.equal(harness.receiveSnapshot({ ...page, requestId: first.requestId }), true);
    assert.equal(harness.release("session-a"), null);

    assert.deepEqual(harness.transport.send(live, { fault: "drop" }), []);
    const duplicated = harness.transport.send(live, { fault: "duplicate" });
    assert.equal(harness.commitDurable(duplicated[0].frame, duplicated[0].generation, { crashAfterCommit: true }), true);
    assert.equal(harness.commitDurable(duplicated[1].frame, duplicated[1].generation), true);
    harness.restart(side);
    assert.equal(harness.commitDurable(live), true, "duplicate durable replay is one effect");
    assert.equal(harness.acknowledgeReplay(live), true);
    assert.equal(harness.projections.get("session-a").events.length, 3);
    assert.equal(harness.inbox.size, 1);
    assert.equal(harness.browserEvents.size, 1);
    assert.equal(harness.acknowledged.size, 1);
    assert.equal(harness.release("session-a").type, "transcript_unsubscribe");
  }
});

test("reordered live events, epoch mismatch, stale generations, cancellation and corrupt input fail closed", () => {
  const harness = new TranscriptSyncHarness({ maxEvents: 3, maxBytes: 4096 });
  const initial = harness.acquire("session-a");
  assert.equal(harness.receiveSnapshot({ ...page, requestId: initial.requestId }), true);
  const generation = harness.transport.generation;
  harness.restart("overseer");
  assert.equal(harness.commitDurable(live, generation), false, "old generation cannot write or ACK");

  assert.throws(
    () => harness.commitDurable({ ...live, payload: { ...live.payload, epoch: "wrong" } }),
    (error) => error instanceof TranscriptHarnessError && error.code === "EPOCH_MISMATCH",
  );
  assert.throws(
    () => harness.commitDurable({ ...live, payload: { ...live.payload, seq: 4, revision: 4 } }),
    (error) => error instanceof TranscriptHarnessError && error.code === "TRANSCRIPT_GAP",
  );

  const cancelled = new TranscriptSyncHarness();
  const demand = cancelled.acquire("session-a");
  assert.equal(cancelled.release("session-a").type, "transcript_snapshot_cancel");
  assert.equal(cancelled.receiveSnapshot({ ...page, requestId: demand.requestId }), false);

  const corrupt = new TranscriptSyncHarness({ maxEvents: 2 });
  const corruptDemand = corrupt.acquire("session-a");
  assert.throws(
    () => corrupt.receiveSnapshot({ ...page, requestId: corruptDemand.requestId, events: [...page.events, { ...page.events[1], seq: 3, revision: 3 }] }),
    (error) => error instanceof TranscriptHarnessError && error.code === "SNAPSHOT_TOO_LARGE",
  );
  const sparse = new TranscriptSyncHarness();
  const sparseDemand = sparse.acquire("session-a");
  assert.throws(
    () => sparse.receiveSnapshot({ ...page, requestId: sparseDemand.requestId, events: [{ ...page.events[0], seq: 2, revision: 2 }] }),
    (error) => error instanceof TranscriptHarnessError && error.code === "CORRUPT_SNAPSHOT",
  );
});

test("crash boundaries commit one effect and never ACK an uncommitted event", () => {
  const before = ready();
  assert.equal(before.commitDurable(live, before.transport.generation, { crashBeforeCommit: true }), false);
  assert.deepEqual(before.state("session-a"), {
    freshness: "fresh", epoch: "te_fixture", seq: 2, effects: 2, deleted: false,
    inbox: 0, acknowledged: 0, browserEffects: 0,
  });
  before.restart("overseer");
  assert.equal(before.commitDurable(live), true);

  const after = ready();
  assert.equal(after.commitDurable(live, after.transport.generation, { crashAfterCommit: true }), true);
  assert.equal(after.state("session-a").acknowledged, 0);
  after.restart("peon");
  assert.equal(after.acknowledgeReplay(live), true);
  assert.equal(after.state("session-a").effects, 3);
  assert.equal(after.state("session-a").browserEffects, 1);
  assert.equal(after.state("session-a").acknowledged, 1);
});

test("snapshot/live race accepts covered identical delivery and rejects payload reuse", () => {
  const harness = ready();
  const covered = {
    ...live,
    cursor: "2",
    messageId: "00000000-0000-4000-8000-000000000152",
    payload: structuredClone(page.events[1]),
  };
  assert.equal(harness.commitDurable(covered), true);
  assert.equal(harness.state("session-a").effects, 2);
  const changed = structuredClone(covered);
  changed.payload.event.message = "different canonical truth";
  assert.throws(() => harness.commitDurable(changed), (error) => error.code === "REPLAY_MISMATCH");
});

test("gap, cursor loss, epoch rollover, eviction and rebuild converge without ACK across a gap", () => {
  const harness = ready();
  const gap = { ...live, payload: { ...live.payload, seq: 5, revision: 5 } };
  assert.throws(() => harness.commitDurable(gap), (error) => error.code === "TRANSCRIPT_GAP");
  assert.equal(harness.state("session-a").freshness, "gap");
  assert.equal(harness.state("session-a").acknowledged, 0);

  const resync = harness.syncFailure("session-a", "CURSOR_UNAVAILABLE");
  const rolled = { ...page, requestId: resync.requestId, epoch: "te_rolled", events: page.events.map((event) => ({ ...event, epoch: "te_rolled" })) };
  assert.equal(harness.receiveSnapshot(rolled), true);
  assert.equal(harness.state("session-a").freshness, "fresh");
  assert.equal(harness.state("session-a").epoch, "te_rolled");

  harness.evict("session-a");
  assert.equal(harness.state("session-a").freshness, "evicted");
  const rebuild = harness.syncFailure("session-a", "RESYNC_REQUIRED");
  assert.equal(harness.receiveSnapshot({ ...page, requestId: rebuild.requestId }), true);
  assert.equal(harness.state("session-a").effects, 2);
});

test("reorder, disconnect, stale generation and deletion are deterministic", () => {
  const harness = ready();
  const fourth = structuredClone(live);
  fourth.cursor = "4";
  fourth.messageId = "00000000-0000-4000-8000-000000000154";
  fourth.payload = { ...fourth.payload, seq: 4, revision: 4, eventId: "event-4" };
  harness.transport.send(live, { fault: "hold", durable: true });
  harness.transport.send(fourth, { fault: "hold", durable: true });
  const reversed = harness.transport.releaseHeld("reverse");
  assert.throws(() => harness.commitDurable(reversed[0].frame, reversed[0].generation), (error) => error.code === "TRANSCRIPT_GAP");
  assert.equal(harness.commitDurable(reversed[1].frame, reversed[1].generation), true);
  assert.equal(harness.commitDurable(fourth), true);
  assert.equal(harness.commitDurable(deletion), true);
  assert.equal(harness.state("session-a").deleted, true);

  harness.transport.disconnect();
  assert.deepEqual(harness.transport.send(live), []);
  const oldGeneration = harness.transport.generation;
  harness.transport.reconnect();
  assert.equal(harness.commitDurable(live, oldGeneration), false);
});

test("pressure, slow consumers, malformed and oversized frames fail within bounds with redacted diagnostics", () => {
  const pressure = new TranscriptSyncHarness({ maxQueuedFrames: 1, maxFrameBytes: 512 });
  pressure.transport.send({ type: "small" }, { fault: "hold" });
  assert.throws(() => pressure.transport.send({ type: "second" }, { fault: "hold" }), (error) => error.code === "QUEUE_FULL");
  assert.throws(() => pressure.transport.send({ type: "large", value: "x".repeat(600) }), (error) => error.code === "FRAME_TOO_LARGE");

  const malformed = new TranscriptSyncHarness({ maxBytes: 256 });
  const demand = malformed.acquire("session-a");
  assert.throws(() => malformed.receiveSnapshot({ ...page, requestId: demand.requestId }), (error) => error.code === "SNAPSHOT_TOO_LARGE");

  const mismatch = ready();
  mismatch.commitDurable(live);
  const replay = structuredClone(live);
  replay.payload.event.message = "secret transcript payload";
  assert.throws(() => mismatch.commitDurable(replay), (error) => error.code === "REPLAY_MISMATCH");
  const artifact = mismatch.diagnostics.artifact();
  assert.ok(!JSON.stringify(artifact).includes("secret transcript payload"));
  assert.match(JSON.stringify(artifact), /transcript_replay_mismatch/);
  assert.ok(artifact.bytes <= artifact.bounds.maxBytes);
});
