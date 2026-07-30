import assert from "node:assert/strict";
import test from "node:test";
import {
  HarnessLimitError,
  ProportionalLoadHarness,
  runDeterministicSoak,
} from "../src/index.js";

test("control remains responsive under transcript and transfer pressure without durable reorder", () => {
  const harness = new ProportionalLoadHarness({ maxQueued: 256, maxPerFlow: 64 });
  for (const flow of ["read-a", "write-a", "read-b", "write-b"]) harness.grantCredit(flow, 64 * 1024);
  for (let index = 1; index <= 32; index += 1) {
    harness.enqueue("durable", `session-${index % 4}`, { sequence: index, operation: "transcript" });
    for (const flow of ["read-a", "write-a", "read-b", "write-b"]) {
      harness.enqueue("transfer", flow, { bytes: 1024, operation: flow.startsWith("read") ? "read" : "write" });
    }
  }
  for (const operation of ["heartbeat", "cancel", "terminal-ack"]) {
    harness.enqueue("control", `peon/${operation}`, { operation });
  }
  const summary = harness.drain();
  assert.equal(summary.durableOrdered, true);
  assert.ok(summary.maxLatencyTicks.control <= 3, summary.maxLatencyTicks.control);
  assert.equal(summary.completed.control, 3);
  assert.equal(summary.completed.durable, 32);
  assert.equal(summary.completed.transfer, 128);
});

test("credit and round-robin keep Peon read/write flows fair and bounded", () => {
  const harness = new ProportionalLoadHarness({ maxQueued: 32, maxPerFlow: 4 });
  const flows = ["p1/u1/s1/read", "p1/u2/s2/write", "p2/u1/s3/read", "p2/u2/s4/write"];
  for (const flow of flows) {
    harness.grantCredit(flow, 2);
    assert.ok(harness.enqueue("transfer", flow, { bytes: 1 }));
    assert.ok(harness.enqueue("transfer", flow, { bytes: 1 }));
    assert.equal(harness.enqueue("transfer", flow, { bytes: 1 }), false, "producer stops at credit");
  }
  harness.drain();
  const counts = flows.map((flow) => harness.completedByFlow.get(flow));
  assert.deepEqual(counts, [2, 2, 2, 2]);
  assert.ok(harness.peakQueued <= 8);
});

test("control round-robin is fair across continuously backlogged Peon/user/session flows", () => {
  const harness = new ProportionalLoadHarness({ maxQueued: 64, maxPerFlow: 16 });
  const flows = ["p1/u1/s1", "p1/u2/s2", "p2/u1/s3", "p2/u2/s4"];
  for (const flow of flows) {
    for (let index = 0; index < 8; index += 1) {
      harness.enqueue("control", flow, { operation: ["heartbeat", "cancel", "terminal-ack"][index % 3] });
    }
  }
  harness.drain();
  assert.deepEqual(flows.map((flow) => harness.completedByFlow.get(flow)), [8, 8, 8, 8]);
  for (let batch = 0; batch < 8; batch += 1) {
    assert.deepEqual(
      harness.completed.slice(batch * flows.length, (batch + 1) * flows.length).map((task) => task.flow).sort(),
      flows,
    );
  }
});

test("queue, per-flow and reconnect storm limits fail closed with bounded diagnostics", () => {
  const harness = new ProportionalLoadHarness({
    maxQueued: 4, maxPerFlow: 2, maxReconnects: 2,
    maxDiagnosticEntries: 2, maxDiagnosticBytes: 512,
  });
  harness.enqueue("control", "a");
  harness.enqueue("control", "a");
  assert.throws(() => harness.enqueue("control", "a"),
    (error) => error instanceof HarnessLimitError && error.code === "FLOW_QUEUE_FULL");
  harness.enqueue("control", "b");
  harness.enqueue("control", "c");
  assert.throws(() => harness.enqueue("control", "d"),
    (error) => error instanceof HarnessLimitError && error.code === "QUEUE_FULL");
  assert.equal(harness.reconnect(), true);
  assert.equal(harness.reconnect(), true);
  assert.equal(harness.reconnect(), false);
  assert.equal(harness.reconnect(), false);
  const diagnostics = harness.summary().diagnostics;
  assert.ok(diagnostics.entries.length <= 2);
  assert.ok(diagnostics.bytes <= 512);
  assert.ok(diagnostics.droppedEntries >= 2);
});

test("deterministic soak meets local readiness criteria", () => {
  const first = runDeterministicSoak({ durationTicks: 2_000 });
  const second = runDeterministicSoak({ durationTicks: 2_000 });
  assert.equal(first.passed, true, JSON.stringify(first.criteria));
  assert.deepEqual(second, first);
});
