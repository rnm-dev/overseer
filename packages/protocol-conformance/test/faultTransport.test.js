import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedDiagnostics,
  DeterministicDeliveryHarness,
  DeterministicTransport,
  HarnessLimitError,
} from "../src/index.js";

test("drop, duplicate, reconnect and both process restarts converge to one effect", () => {
  const diagnostics = new BoundedDiagnostics({ clock: () => 1785400000000 });
  const harness = new DeterministicDeliveryHarness({ diagnostics });
  harness.append({ operation: "catalog.upsert", resourceId: "session-a" }, {
    messageId: "00000000-0000-4000-8000-000000000071",
  });

  assert.deepEqual(harness.cycle({ dataFault: "drop" }), {
    cursor: 1,
    acknowledgement: null,
    senderAcknowledgedCursor: 0,
    receiverCursor: 0,
    effects: 0,
  });

  harness.restart("peon");
  const duplicated = harness.cycle({ dataFault: "duplicate", ackFault: "drop" });
  assert.equal(duplicated.receiverCursor, 1);
  assert.equal(duplicated.effects, 1);
  assert.equal(duplicated.senderAcknowledgedCursor, 0);

  harness.restart("overseer");
  assert.deepEqual(harness.drain(), { steps: 1, effects: 1, acknowledgedCursor: 1 });
  assert.deepEqual(harness.state(), {
    journalMessages: 1,
    journalBytes: harness.state().journalBytes,
    acknowledgedCursor: 1,
    receiverCursor: 1,
    effects: 1,
  });
});

test("reordered durable delivery detects a gap and converges only in cursor order", () => {
  const harness = new DeterministicDeliveryHarness();
  harness.append({ resourceId: "first" }, { messageId: "00000000-0000-4000-8000-000000000081" });
  harness.append({ resourceId: "second" }, { messageId: "00000000-0000-4000-8000-000000000082" });

  harness.sendCursor(1, "hold");
  assert.equal(harness.receive(harness.sendCursor(2)), null);
  assert.equal(harness.state().receiverCursor, 0);
  const firstAck = harness.receive(harness.transport.releaseHeld("reverse"));
  harness.acknowledge(firstAck);
  assert.equal(harness.state().receiverCursor, 1);
  assert.deepEqual(harness.drain(), { steps: 1, effects: 2, acknowledgedCursor: 2 });
});

test("reconnect generation fencing discards held stale frames", () => {
  const harness = new DeterministicDeliveryHarness();
  harness.append({ resourceId: "fenced" }, { messageId: "00000000-0000-4000-8000-000000000091" });
  harness.sendCursor(1, "hold");
  harness.transport.disconnect();
  harness.transport.reconnect();

  assert.equal(harness.receive(harness.transport.releaseHeld()), null);
  assert.equal(harness.state().effects, 0);
  assert.deepEqual(harness.drain(), { steps: 1, effects: 1, acknowledgedCursor: 1 });
});

test("ephemeral reorder is deterministic and transport queues are bounded", () => {
  const transport = new DeterministicTransport({ maxQueuedFrames: 2 });
  transport.send({ type: "ephemeral_page", page: 1 }, { fault: "hold" });
  transport.send({ type: "ephemeral_page", page: 2 }, { fault: "hold" });
  assert.deepEqual(transport.releaseHeld("reverse").map((entry) => entry.frame.page), [2, 1]);

  const bounded = new DeterministicDeliveryHarness({ maxMessages: 1, maxBytes: 256 });
  bounded.append({ small: true });
  assert.throws(
    () => bounded.append({ second: true }),
    (error) => error instanceof HarnessLimitError && error.code === "OUTBOX_FULL",
  );
});

test("cursor or message-ID reuse never produces a second effect", () => {
  const harness = new DeterministicDeliveryHarness();
  harness.append({ resourceId: "canonical" }, { messageId: "00000000-0000-4000-8000-0000000000a1" });
  harness.cycle({ ackFault: "drop" });
  assert.equal(harness.state().effects, 1);

  const forgedCursor = harness.transport.send({
    type: "durable_message",
    epoch: "fixture-delivery-epoch",
    cursor: 1,
    messageId: "00000000-0000-4000-8000-0000000000a2",
    payload: { resourceId: "forged" },
  }, { durable: true });
  assert.equal(harness.receive(forgedCursor), null);
  assert.equal(harness.state().effects, 1);

  harness.append({ resourceId: "second" }, { messageId: "00000000-0000-4000-8000-0000000000a3" });
  const reusedId = harness.transport.send({
    type: "durable_message",
    epoch: "fixture-delivery-epoch",
    cursor: 2,
    messageId: "00000000-0000-4000-8000-0000000000a1",
    payload: { resourceId: "forged-again" },
  }, { durable: true });
  assert.equal(harness.receive(reusedId), null);
  assert.equal(harness.state().effects, 1);
});
