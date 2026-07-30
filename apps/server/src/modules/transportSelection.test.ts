import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityRolloutAllows,
  legacyCallbackAttemptCounts,
  resetTransportTelemetryForTest,
  resetLegacyCallbackAttemptCountsForTest,
  reverseRolloutPolicyFromEnv,
  runSelectedTransport,
  selectPeonTransport,
  transportTelemetrySnapshot,
  transportPolicyFromEnv,
} from "./transportSelection.js";

const enabled = { reverseRoutingEnabled: true, legacyCallbackFallbackEnabled: true };

test("a negotiated reverse operation is authoritative and never evaluates callback addressing", async () => {
  resetLegacyCallbackAttemptCountsForTest();
  const selected = selectPeonTransport({
    connected: true,
    familyNegotiated: true,
    operationNegotiated: true,
    policy: enabled,
  });
  let callbackAddressReads = 0;
  const result = await runSelectedTransport(selected, {
    reverse: async () => "reverse",
    legacy: async () => {
      callbackAddressReads += 1;
      throw new Error("legacy callback must remain lazy");
    },
    unavailable: async () => "unavailable",
  });
  assert.equal(result, "reverse");
  assert.equal(callbackAddressReads, 0);
  assert.equal(legacyCallbackAttemptCounts()["reverse-capability-authoritative"], 0);
  assert.deepEqual(selected, {
    transport: "reverse",
    reason: "reverse-capability-authoritative",
    callbackAllowed: false,
  });
});

test("mixed-version Peons retain legacy fallback by default", () => {
  assert.deepEqual(selectPeonTransport({
    connected: true,
    familyNegotiated: false,
    operationNegotiated: false,
    policy: enabled,
  }), {
    transport: "legacy",
    reason: "legacy-mixed-version-fallback",
    callbackAllowed: true,
  });
  assert.deepEqual(transportPolicyFromEnv({}), enabled);
});

test("legacy callback attempts are attributed to the selected compatibility reason", async () => {
  resetLegacyCallbackAttemptCountsForTest();
  const selected = selectPeonTransport({
    connected: false,
    familyNegotiated: false,
    operationNegotiated: false,
    policy: enabled,
  });
  await runSelectedTransport(selected, {
    reverse: async () => undefined,
    legacy: async () => undefined,
    unavailable: async () => undefined,
  });
  assert.equal(legacyCallbackAttemptCounts()["legacy-mixed-version-fallback"], 1);
  assert.equal(legacyCallbackAttemptCounts()["reverse-capability-authoritative"], 0);
});

test("routing and fallback switches are independently rollback safe", () => {
  const reverseReady = { connected: true, familyNegotiated: true, operationNegotiated: true };
  assert.equal(selectPeonTransport({
    ...reverseReady,
    policy: { reverseRoutingEnabled: false, legacyCallbackFallbackEnabled: true },
  }).transport, "legacy");
  assert.equal(selectPeonTransport({
    ...reverseReady,
    policy: { reverseRoutingEnabled: false, legacyCallbackFallbackEnabled: false },
  }).transport, "unavailable");
  assert.deepEqual(transportPolicyFromEnv({
    OVERSEER_REVERSE_ROUTING: "0",
    OVERSEER_LEGACY_CALLBACK_FALLBACK: "0",
  }), {
    reverseRoutingEnabled: false,
    legacyCallbackFallbackEnabled: false,
  });
});

test("a capability-incomplete reverse Peon does not silently become reverse-authoritative", () => {
  const selected = selectPeonTransport({
    connected: true,
    familyNegotiated: true,
    operationNegotiated: false,
    policy: enabled,
  });
  assert.equal(selected.transport, "legacy");
  assert.equal(selected.reason, "reverse-capability-incomplete");
});

test("capability rollout stages are independent and fail closed on minimum version", () => {
  const rollout = reverseRolloutPolicyFromEnv({
    OVERSEER_REVERSE_CAPABILITY_ROLLOUT:
      "reverse-command-v1:allowlist:2.4.0,folder-listing-v1:default:1.2.0,file-write-v1:cohort:3.0.0:100",
    OVERSEER_REVERSE_ALLOWLIST_REVERSE_COMMAND_V1: "peon-canary;peon-second",
  });
  assert.equal(capabilityRolloutAllows({
    capability: "reverse-command-v1", peonId: "peon-canary", peonVersion: "2.4.0", rollout,
  }), true);
  assert.equal(capabilityRolloutAllows({
    capability: "reverse-command-v1", peonId: "not-listed", peonVersion: "9.0.0", rollout,
  }), false);
  assert.equal(capabilityRolloutAllows({
    capability: "folder-listing-v1", peonId: "any", peonVersion: "1.1.9", rollout,
  }), false);
  assert.equal(capabilityRolloutAllows({
    capability: "folder-listing-v1", peonId: "any", peonVersion: "1.2.0-beta.1", rollout,
  }), false);
  assert.equal(capabilityRolloutAllows({
    capability: "file-write-v1", peonId: "any", peonVersion: "3.0.0", rollout,
  }), true);
});

test("malformed rollout entries disable the named capability", () => {
  const rollout = reverseRolloutPolicyFromEnv({
    OVERSEER_REVERSE_CAPABILITY_ROLLOUT: "reverse-command-v1:cohort:bad:999",
  });
  assert.equal(capabilityRolloutAllows({
    capability: "reverse-command-v1", peonId: "peon", peonVersion: "99.0.0", rollout,
  }), false);
  assert.equal(rollout.valid, false);
});

test("rollout configuration is bounded and rejects ambiguous extra fields", () => {
  const tooMany = Array.from(
    { length: 65 },
    (_, index) => `capability-${index}-v1:off`,
  ).join(",");
  assert.equal(reverseRolloutPolicyFromEnv({
    OVERSEER_REVERSE_CAPABILITY_ROLLOUT: tooMany,
  }).valid, false);
  const extraField = reverseRolloutPolicyFromEnv({
    OVERSEER_REVERSE_CAPABILITY_ROLLOUT: "reverse-command-v1:default:2.0.0:100:ignored",
  });
  assert.equal(extraField.valid, false);
  assert.equal(capabilityRolloutAllows({
    capability: "folder-listing-v1",
    peonId: "peon",
    peonVersion: "9.0.0",
    rollout: extraField,
  }), false, "an invalid policy fails closed for every capability");
});

test("accepted reverse authority survives rollback without invoking a duplicate legacy effect", async () => {
  resetTransportTelemetryForTest();
  const selected = selectPeonTransport({
    connected: false,
    familyNegotiated: false,
    operationNegotiated: false,
    acceptedReverseCommand: true,
    policy: { reverseRoutingEnabled: false, legacyCallbackFallbackEnabled: true },
  });
  let admittedEffects = 1;
  let legacyEffects = 0;
  const result = await runSelectedTransport(selected, {
    reverse: async () => {
      // Status/replay joins the already-admitted command ID; it does not admit
      // another effect.
      return { status: "accepted", effects: admittedEffects };
    },
    legacy: async () => {
      legacyEffects += 1;
      admittedEffects += 1;
      return { status: "duplicated", effects: admittedEffects };
    },
    unavailable: async () => ({ status: "unavailable", effects: admittedEffects }),
  });
  assert.deepEqual(selected, {
    transport: "reverse",
    reason: "reverse-accepted-reconciliation",
    callbackAllowed: false,
  });
  assert.deepEqual(result, { status: "accepted", effects: 1 });
  assert.equal(legacyEffects, 0);
  assert.equal(legacyCallbackAttemptCounts()["reverse-accepted-reconciliation"], 0);
});

test("rollout denial selects one compatibility route and never invokes reverse", async () => {
  resetTransportTelemetryForTest();
  const rollout = reverseRolloutPolicyFromEnv({
    OVERSEER_REVERSE_CAPABILITY_ROLLOUT: "reverse-command-v1:off",
  });
  const selected = selectPeonTransport({
    connected: true,
    familyNegotiated: true,
    operationNegotiated: true,
    capability: "reverse-command-v1",
    peonId: "peon-1",
    peonVersion: "9.0.0",
    rollout,
    policy: enabled,
  });
  let reverseRuns = 0;
  await runSelectedTransport(selected, {
    reverse: async () => { reverseRuns += 1; },
    legacy: async () => undefined,
    unavailable: async () => undefined,
  });
  assert.equal(reverseRuns, 0);
  assert.equal(selected.transport, "legacy");
  assert.deepEqual(transportTelemetrySnapshot(), {
    selections: { reverse: 0, legacy: 1, unavailable: 0 },
    reasons: {
      "reverse-capability-authoritative": 0,
      "reverse-accepted-reconciliation": 0,
      "reverse-routing-disabled": 0,
      "reverse-rollout-disabled": 1,
      "legacy-mixed-version-fallback": 0,
      "reverse-capability-incomplete": 0,
    },
    callbackAttempts: {
      "reverse-capability-authoritative": 0,
      "reverse-accepted-reconciliation": 0,
      "reverse-routing-disabled": 0,
      "reverse-rollout-disabled": 1,
      "legacy-mixed-version-fallback": 0,
      "reverse-capability-incomplete": 0,
    },
  });
});
