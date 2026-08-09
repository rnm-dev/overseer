import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PeonSocketOutbox } from "../overseer/socket/peonSocketOutbox.js";
import { PEON_SOCKET_MAX_FRAME_BYTES } from "../overseer/socket/peonSocketProtocol.js";

function fixture(options: { maxMessages?: number; maxBytes?: number } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-socket-outbox-"));
  const fileBase = path.join(directory, "outbox");
  const outbox = new PeonSocketOutbox({ fileBase, ...options });
  return { directory, fileBase, outbox };
}

test("persists before accepting and replays the same identity after restart", () => {
  const { directory, fileBase, outbox } = fixture();
  try {
    const accepted = outbox.enqueue(
      { type: "result", sessionId: "s1" },
      { priority: "critical", capability: "session-result-v1" },
    );
    assert.equal(accepted.accepted, true);
    assert.ok(readFileSync(`${fileBase}.journal`, "utf8").includes("sessionId"));
    assert.equal(statSync(`${fileBase}.journal`).mode & 0o777, 0o600);

    const restarted = new PeonSocketOutbox({ fileBase });
    assert.deepEqual(restarted.pending(), outbox.pending());
    assert.equal(restarted.pending()[0]?.capability, "session-result-v1");
    assert.equal(restarted.status().epoch, outbox.status().epoch);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cumulative acknowledgements compact durably and tolerate acknowledgement replay", () => {
  const { directory, fileBase, outbox } = fixture();
  try {
    const first = outbox.enqueue({ type: "event", value: 1 });
    const second = outbox.enqueue({ type: "event", value: 2 });
    const third = outbox.enqueue({ type: "event", value: 3 });
    assert.ok(first.accepted && second.accepted && third.accepted);
    assert.equal(outbox.acknowledge(second.epoch, second.cursor), true);
    assert.equal(outbox.acknowledge(second.epoch, second.cursor), true);
    assert.deepEqual(outbox.pending().map((message) => message.cursor), [third.cursor]);

    const restarted = new PeonSocketOutbox({ fileBase });
    assert.deepEqual(restarted.pending().map((message) => message.cursor), [third.cursor]);
    assert.equal(restarted.status().acknowledgedCursor, second.cursor);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selective acknowledgements durably retire an independent cursor without crossing a blocked prefix", () => {
  const { directory, fileBase, outbox } = fixture();
  try {
    const blocked = outbox.enqueue({ type: "transcript_live_event", sessionId: "blocked" });
    const independent = outbox.enqueue({ type: "transcript_live_event", sessionId: "ready" });
    const later = outbox.enqueue({ type: "runtime_state" });
    assert.ok(blocked.accepted && independent.accepted && later.accepted);
    assert.equal(outbox.acknowledgeSelective(independent.epoch, independent.cursor), true);
    assert.equal(outbox.hasUsedSelectiveAcks(), true);
    assert.deepEqual(outbox.pending().map((message) => message.cursor), [blocked.cursor, later.cursor]);
    assert.equal(outbox.status().acknowledgedCursor, null);

    const restarted = new PeonSocketOutbox({ fileBase });
    assert.equal(restarted.hasUsedSelectiveAcks(), true);
    assert.deepEqual(restarted.pending().map((message) => message.cursor), [blocked.cursor, later.cursor]);
    assert.equal(restarted.acknowledgeSelective(blocked.epoch, blocked.cursor), true);
    assert.equal(restarted.status().acknowledgedCursor, independent.cursor);
    assert.deepEqual(restarted.pending().map((message) => message.cursor), [later.cursor]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selective acknowledgement holes remain bounded while a prefix is blocked", () => {
  const { directory, outbox } = fixture({ maxMessages: 2, maxBytes: 100_000 });
  try {
    const blocked = outbox.enqueue({ type: "blocked" });
    const second = outbox.enqueue({ type: "second" });
    assert.ok(blocked.accepted && second.accepted);
    assert.equal(outbox.acknowledgeSelective(second.epoch, second.cursor), true);
    const third = outbox.enqueue({ type: "third" });
    assert.ok(third.accepted);
    assert.equal(outbox.acknowledgeSelective(third.epoch, third.cursor), true);
    const fourth = outbox.enqueue({ type: "fourth" });
    assert.ok(fourth.accepted);
    assert.equal(outbox.acknowledgeSelective(fourth.epoch, fourth.cursor), false);
    assert.deepEqual(outbox.pending().map((message) => message.cursor), [blocked.cursor, fourth.cursor]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a restarted selective outbox retains the marker needed for safe downgrade fencing", () => {
  const { directory, fileBase, outbox } = fixture();
  try {
    const blocked = outbox.enqueue({ type: "blocked" });
    const retired = outbox.enqueue({ type: "retired" });
    const remaining = outbox.enqueue({ type: "remaining" });
    assert.ok(blocked.accepted && retired.accepted && remaining.accepted);
    assert.equal(outbox.acknowledgeSelective(retired.epoch, retired.cursor), true);

    const restarted = new PeonSocketOutbox({ fileBase });
    assert.deepEqual(restarted.pending().map((message) => message.cursor), [blocked.cursor, remaining.cursor]);
    assert.equal(restarted.hasUsedSelectiveAcks(), true);
    assert.equal(restarted.status().acknowledgedCursor, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deduplication and explicit coalescing preserve one ordered durable cursor", () => {
  const { directory, outbox } = fixture({ maxMessages: 1, maxBytes: 10_000 });
  try {
    const first = outbox.enqueue(
      { type: "session_catalog_event", value: 1 },
      { dedupeKey: "event-1", coalesceKey: "session-1" },
    );
    const duplicate = outbox.enqueue(
      { type: "session_catalog_event", value: 1 },
      { dedupeKey: "event-1", coalesceKey: "session-1" },
    );
    const coalesced = outbox.enqueue(
      { type: "session_catalog_event", value: 2 },
      { dedupeKey: "event-2", coalesceKey: "session-1" },
    );
    assert.ok(first.accepted && duplicate.accepted && coalesced.accepted);
    assert.equal(duplicate.cursor, first.cursor);
    assert.equal(coalesced.cursor, first.cursor);
    assert.deepEqual(outbox.pending().map((message) => message.payload.value), [2]);

    const rejected = outbox.enqueue({ type: "session_catalog_event", value: 3 }, { coalesceKey: "session-2" });
    assert.deepEqual(rejected, { accepted: false, code: "OUTBOX_FULL", error: "durable socket outbox limit reached" });
    assert.equal(outbox.status().backpressured, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovers the previous atomic generation when the newest slot is corrupt", () => {
  const { directory, fileBase, outbox } = fixture();
  try {
    const first = outbox.enqueue({ type: "event", value: 1 });
    assert.equal(first.accepted, true);
    const second = outbox.enqueue({ type: "event", value: 2 });
    assert.equal(second.accepted, true);
    // Either base checkpoint plus the fsynced journal reconstructs both events.
    writeFileSync(`${fileBase}.a.json`, "{broken", { mode: 0o600 });
    const recovered = new PeonSocketOutbox({ fileBase });
    assert.equal(recovered.status().recoveredFromCorruption, true);
    assert.deepEqual(recovered.pending().map((message) => message.payload.value), [1, 2]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an interrupted acknowledgement compaction replays duplicates instead of losing data", () => {
  const { directory, fileBase, outbox } = fixture();
  try {
    const first = outbox.enqueue({ type: "event", value: 1 });
    const second = outbox.enqueue({ type: "event", value: 2 });
    assert.ok(first.accepted && second.accepted);
    assert.equal(outbox.acknowledge(first.epoch, first.cursor), true);
    // Simulate a torn final ack append. The valid enqueue prefix must replay,
    // producing duplicates rather than deleting an uncommitted cursor.
    const journal = readFileSync(`${fileBase}.journal`, "utf8");
    writeFileSync(`${fileBase}.journal`, journal.slice(0, journal.lastIndexOf("\n", journal.length - 2) + 1) + "{torn");
    const recovered = new PeonSocketOutbox({ fileBase });
    assert.deepEqual(recovered.pending().map((message) => message.payload.value), [1, 2]);
    assert.equal(recovered.status().recoveredFromCorruption, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("quarantines wholly corrupt storage and starts a visible new epoch", () => {
  const { directory, fileBase, outbox } = fixture();
  try {
    const oldEpoch = outbox.status().epoch;
    outbox.enqueue({ type: "event", value: 1 });
    writeFileSync(`${fileBase}.a.json`, "bad-a");
    writeFileSync(`${fileBase}.b.json`, "bad-b");
    const recovered = new PeonSocketOutbox({ fileBase, now: () => 123 });
    assert.notEqual(recovered.status().epoch, oldEpoch);
    assert.equal(recovered.status().recoveredFromCorruption, true);
    assert.match(recovered.status().lastError ?? "", /corrupt/);
    assert.equal(recovered.pending().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects non-serializable frames without mutating durable state", () => {
  const { directory, outbox } = fixture();
  try {
    const circular: Record<string, unknown> = { type: "event" };
    circular.self = circular;
    const result = outbox.enqueue(circular);
    assert.equal(result.accepted, false);
    assert.equal(result.accepted ? null : result.code, "INVALID_MESSAGE");
    assert.equal(outbox.pending().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a durable message whose complete envelope cannot fit the wire", () => {
  const { directory, outbox } = fixture();
  try {
    const result = outbox.enqueue({ type: "event", value: "x".repeat(PEON_SOCKET_MAX_FRAME_BYTES) });
    assert.deepEqual(result, {
      accepted: false,
      code: "INVALID_MESSAGE",
      error: "durable socket message exceeds the wire frame limit",
    });
    assert.equal(outbox.pending().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("routine outage traffic appends journal mutations without rewriting checkpoints", () => {
  const { directory, fileBase, outbox } = fixture();
  try {
    const checkpointA = readFileSync(`${fileBase}.a.json`, "utf8");
    const checkpointB = readFileSync(`${fileBase}.b.json`, "utf8");
    for (let value = 0; value < 100; value += 1) {
      assert.equal(outbox.enqueue({ type: "event", value }).accepted, true);
    }
    assert.equal(readFileSync(`${fileBase}.a.json`, "utf8"), checkpointA);
    assert.equal(readFileSync(`${fileBase}.b.json`, "utf8"), checkpointB);
    assert.equal(readFileSync(`${fileBase}.journal`, "utf8").trim().split("\n").length, 100);
    const restarted = new PeonSocketOutbox({ fileBase });
    assert.equal(restarted.pending().length, 100);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checkpoint compaction preserves journaled messages across restart", () => {
  const { directory, fileBase } = fixture();
  try {
    const outbox = new PeonSocketOutbox({ fileBase, checkpointRecords: 3 });
    for (let value = 0; value < 3; value += 1) outbox.enqueue({ type: "event", value });
    assert.equal(readFileSync(`${fileBase}.journal`, "utf8"), "");
    const restarted = new PeonSocketOutbox({ fileBase });
    assert.deepEqual(restarted.pending().map((message) => message.payload.value), [0, 1, 2]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("destination replacement quarantines pending messages instead of leaking them", () => {
  const { directory, outbox } = fixture();
  try {
    assert.equal(outbox.bindDestination("a".repeat(64)), true);
    const accepted = outbox.enqueue({ type: "private_event", value: "secret" });
    assert.equal(accepted.accepted, true);
    const oldEpoch = outbox.status().epoch;
    assert.equal(outbox.bindDestination("b".repeat(64)), true);
    assert.notEqual(outbox.status().epoch, oldEpoch);
    assert.equal(outbox.pending().length, 0);
    assert.match(outbox.status().lastError ?? "", /quarantined/);
    assert.ok(readdirSync(directory).some((name) => name.includes(".destination-")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
