import assert from "node:assert/strict";
import test from "node:test";
import { leaseDeadline } from "../armory/workflowRuntime.js";

test("workflow lease deadline uses server-relative time", () => {
  const receivedAt = Date.parse("2026-09-18T10:00:00.000Z");
  assert.equal(leaseDeadline({
    server_time: "2026-09-18T10:05:00.000Z",
    expires_at: "2026-09-18T10:10:00.000Z",
  }, receivedAt), receivedAt + 5 * 60_000);
});

test("workflow lease deadline defaults to the protocol TTL", () => {
  assert.equal(leaseDeadline({}, 1_000), 301_000);
});
