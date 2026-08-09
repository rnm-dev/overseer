import assert from "node:assert/strict";
import test from "node:test";
import { INDEXED_RUN_ASSUMPTION_TTL_MS, indexedRunAssumptionDelay, shouldSeedIndexedRun } from "./runStatus";

test("seeds a run from the indexed summary before session metadata arrives", () => {
  assert.equal(shouldSeedIndexedRun({
    indexedStatus: "running",
    metadataStatusKnown: false,
    runRevision: 0,
    refuted: false,
  }), true);
});

test("bounds an unconfirmed indexed run without expiring confirmed state", () => {
  assert.equal(indexedRunAssumptionDelay(1_000, null), null);
  assert.equal(indexedRunAssumptionDelay(1_000, 500), INDEXED_RUN_ASSUMPTION_TTL_MS - 500);
  assert.equal(indexedRunAssumptionDelay(INDEXED_RUN_ASSUMPTION_TTL_MS + 500, 500), 0);
});

test("does not let an indexed summary override newer run evidence", () => {
  assert.equal(shouldSeedIndexedRun({ indexedStatus: "running", metadataStatusKnown: true, runRevision: 0, refuted: false }), false);
  assert.equal(shouldSeedIndexedRun({ indexedStatus: "running", metadataStatusKnown: false, runRevision: 1, refuted: false }), false);
  assert.equal(shouldSeedIndexedRun({ indexedStatus: "running", metadataStatusKnown: false, runRevision: 0, refuted: true }), false);
  assert.equal(shouldSeedIndexedRun({ indexedStatus: "completed", metadataStatusKnown: false, runRevision: 0, refuted: false }), false);
});
