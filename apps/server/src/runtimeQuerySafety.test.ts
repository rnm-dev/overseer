import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeReverseCommandResult,
  type JsonObject,
  type ReverseCommandResultFrame,
} from "./modules/reverseCommands/reverseCommandTypes.js";

const record = { operation: "runtime.quota" as const, target: { peonId: "86f9907d-4cdf-4700-84c4-6bc67bfc765c" } };

function result(detail: JsonObject): ReverseCommandResultFrame {
  return {
    type: "command_result",
    protocol: 1,
    commandId: "86f9907d-4cdf-4700-84c4-6bc67bfc765c",
    operation: "runtime.quota",
    status: "applied",
    code: "OK",
    completedAt: 1,
    result: detail,
  };
}

test("runtime query terminal results allow bounded public provider data", () => {
  assert.doesNotThrow(() => assertSafeReverseCommandResult(record, result({
    provider: "codex",
    usage: { remaining: 50, resetsAt: 10 },
    windows: [{ name: "daily", used: 2 }],
  })));
});

test("runtime query terminal results reject sensitive keys at any depth", () => {
  for (const detail of <JsonObject[]>[
    { token: "secret" },
    { provider: { authResponse: { ok: true } } },
    { environment: ["PATH=/private/bin"] },
    { nested: { credentials: "secret" } },
  ]) {
    assert.throws(
      () => assertSafeReverseCommandResult(record, result(detail)),
      /forbidden field/,
    );
  }
});
