import assert from "node:assert/strict";
import test from "node:test";
import { runtimeQueryHandlers, safeRuntimeQueryResult } from "../overseer/socket/channels/runtimeQueryHandlers.js";
import type { ValidCommand } from "../overseer/socket/channels/reverseCommandChannel.js";

function command(operation: string, payload: Record<string, unknown>): ValidCommand {
  return {
    commandId: "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    operation,
    target: { peonId: "f4de920f-e33e-4cf5-97d0-3a75e9266090", sessionId: "" },
    actor: { userId: "b169219d-45f6-4f42-b78f-3fb931dac7ee", email: "operator@example.com" },
    payload,
    expected: null,
    requestedAt: 1,
  };
}

test("runtime query handlers are bounded, normal-priority gateway operations", async () => {
  const handlers = runtimeQueryHandlers();
  assert.deepEqual(Object.keys(handlers).sort(), [
    "runtime.analytics", "runtime.capabilities", "runtime.quota", "runtime.stats",
  ]);
  assert.equal(handlers["runtime.stats"]?.priority, "normal");
  assert.equal(handlers["runtime.stats"]?.maxConcurrency, 2);
  assert.equal(handlers["runtime.stats"]?.validate({}, null), null);
  assert.match(handlers["runtime.stats"]?.validate({}, {}) ?? "", /expected state/);

  const invalidPeriod = await handlers["runtime.stats"]!.execute(command("runtime.stats", { period: "forever" }));
  assert.deepEqual(invalidPeriod, { status: "rejected", code: "BAD_COMMAND" });
  const invalidAnalytics = await handlers["runtime.analytics"]!.execute(command("runtime.analytics", { query: "bad" }));
  assert.deepEqual(invalidAnalytics, { status: "rejected", code: "BAD_COMMAND" });
  const invalidProvider = await handlers["runtime.quota"]!.execute(command("runtime.quota", { provider: "other", refresh: false }));
  assert.deepEqual(invalidProvider, { status: "rejected", code: "UNKNOWN_PROVIDER" });
});

test("runtime query results reject recursively nested sensitive keys", async () => {
  assert.deepEqual(
    safeRuntimeQueryResult({ provider: { nested: [{ authorization: "must-not-cross" }] } }),
    { status: "failed", code: "INTERNAL" },
  );
});
