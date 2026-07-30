import assert from "node:assert/strict";
import test from "node:test";
import {
  resetReverseRolloutReadinessForTest,
  reverseRolloutReadinessSnapshot,
  runAcceptedReverseReconciliation,
} from "./modules/reverseRolloutReadiness.js";
import {
  resetTransportTelemetryForTest,
} from "./modules/transportSelection.js";
import { readReverseCommandStatus } from "./routes/peons.js";

test("real command status route stays reverse-authoritative after rollback", async () => {
  resetReverseRolloutReadinessForTest();
  resetTransportTelemetryForTest();
  let reads = 0;
  const result = await readReverseCommandStatus(async () => {
    reads += 1;
    return { state: "accepted" };
  });
  assert.deepEqual(result, { state: "accepted" });
  assert.equal(reads, 1);
  const readiness = reverseRolloutReadinessSnapshot();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.local.wiredSurfaces["command-status-reconciliation"], true);
  assert.equal(readiness.local.wiredSurfaces["operation-submission"], false);
  assert.equal(readiness.local.transport.selections.reverse, 1);
  assert.equal(readiness.local.transport.callbackAttempts["reverse-accepted-reconciliation"], 0);
  assert.deepEqual(readiness.operationalGates, {
    productionTelemetry: false,
    noInboundSoak: false,
    rollbackExercise: false,
    securityApproval: false,
    conformanceApproval: false,
  });
  assert.equal(JSON.stringify(readiness).includes("prompt"), false);
  assert.equal(JSON.stringify(readiness).includes("credential"), false);
  assert.equal(JSON.stringify(readiness).includes("payload"), false);
  assert.equal(JSON.stringify(readiness).includes("path"), false);
});

test("accepted reconciliation helper does not evaluate compatibility handlers", async () => {
  const result = await runAcceptedReverseReconciliation(async () => "status");
  assert.equal(result, "status");
});
