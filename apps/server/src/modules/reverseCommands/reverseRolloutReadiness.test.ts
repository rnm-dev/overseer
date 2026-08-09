import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateReverseOnlyDefault,
  resetReverseRolloutReadinessForTest,
  reverseRolloutReadinessSnapshot,
  runAcceptedReverseReconciliation,
} from "./reverseRolloutReadiness.js";
import {
  resetTransportTelemetryForTest,
} from "./transportSelection.js";
import { readReverseCommandStatus } from "../../routes/peons.js";

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
    productionEvidence: false,
    productionTelemetry: false,
    noInboundSoak: false,
    rollbackExercise: false,
    securityApproval: false,
    conformanceApproval: true,
    deterministicLocalSoak: true,
  });
  assert.equal(readiness.evidence.deterministicLocalSoak.productionEvidence, false);
  assert.equal(readiness.reverseOnlyDefaultAllowed, false);
  assert.equal(JSON.stringify(readiness).includes("prompt"), false);
  assert.equal(JSON.stringify(readiness).includes("credential"), false);
  assert.equal(JSON.stringify(readiness).includes("payload"), false);
  assert.equal(JSON.stringify(readiness).includes("path"), false);
});

test("accepted reconciliation helper does not evaluate compatibility handlers", async () => {
  const result = await runAcceptedReverseReconciliation(async () => "status");
  assert.equal(result, "status");
});

test("reverse-only default fails closed on every required approval and production gate", () => {
  const complete = {
    operationSubmissionWired: true,
    conformanceApproved: true,
    deterministicLocalSoakPassed: true,
    securityApproved: true,
    productionEvidence: true,
    productionTelemetry: true,
    noInboundSoak: true,
    rollbackExercise: true,
  };
  assert.equal(evaluateReverseOnlyDefault(complete), true);
  for (const gate of Object.keys(complete) as Array<keyof typeof complete>) {
    assert.equal(
      evaluateReverseOnlyDefault({ ...complete, [gate]: false }),
      false,
      `${gate} must block reverse-only default`,
    );
  }
});

test("readiness diagnostics use bounded fixed labels and expose missing production proof", () => {
  const readiness = reverseRolloutReadinessSnapshot();
  assert.deepEqual(
    readiness.alerts.map(({ code }) => code),
    [
      "production-evidence-missing",
      "security-approval-missing",
      "operation-submission-unwired",
      "capable-callback-observed",
    ],
  );
  assert.equal(
    readiness.alerts.find(({ code }) => code === "production-evidence-missing")?.active,
    true,
  );
  assert.equal(readiness.alerts.length, 4);
  assert.deepEqual(
    readiness.dashboard.map(({ code, available }) => [code, available]),
    [
      ["transport-selection", true],
      ["callback-attempts", true],
      ["command-lifecycle", true],
      ["transfer-negotiation", true],
      ["production-acceptance", false],
    ],
  );
  const serialized = JSON.stringify(readiness);
  for (const forbidden of ["prompt", "credential", "payload", "token", "path"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
