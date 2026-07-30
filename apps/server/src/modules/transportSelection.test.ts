import assert from "node:assert/strict";
import test from "node:test";
import {
  legacyCallbackAttemptCounts,
  resetLegacyCallbackAttemptCountsForTest,
  runSelectedTransport,
  selectPeonTransport,
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
