import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import {
  claimPeonTransferConnection,
  releasePeonTransferConnection,
} from "./peonTransferConnections.js";
import {
  resetReverseTransportMetricsForTest,
  reverseTransportMetricsSnapshot,
} from "./modules/reverseTransportMetrics.js";

test("real transfer negotiation and replacement signals use fixed capability labels", () => {
  resetReverseTransportMetricsForTest();
  const first = {} as WebSocket;
  const replacement = {} as WebSocket;
  const peonId = "telemetry-test-peon";
  claimPeonTransferConnection(peonId, first, [
    "project-file-read-v1",
    "untrusted-capability-/private/path-token",
  ]);
  claimPeonTransferConnection(peonId, replacement, ["file-write-v1"]);
  releasePeonTransferConnection(peonId, replacement);
  assert.deepEqual(reverseTransportMetricsSnapshot(), {
    "connection:transfer:initial": 1,
    "negotiated:transfer:project-file-read-v1": 1,
    "negotiated:transfer:other": 1,
    "connection:transfer:replacement": 1,
    "negotiated:transfer:file-write-v1": 1,
  });
  const encoded = JSON.stringify(reverseTransportMetricsSnapshot());
  assert.equal(encoded.includes("/private/path"), false);
  assert.equal(encoded.includes("token"), false);
});
