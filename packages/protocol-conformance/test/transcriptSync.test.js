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
