import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeReverseCommandResult,
  REVERSE_COMMAND_OPERATIONS,
  type JsonObject,
  type ReverseCommandOperation,
  type ReverseCommandResultFrame,
} from "./modules/reverseCommands/index.js";

const peonId = "f4de920f-e33e-4cf5-97d0-3a75e9266001";
const sessionId = "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5";
const commandId = "528f4f0c-9f30-8a61-af1a-66d2582bdb4a";
const publicSession = { id: sessionId, status: "running" };

function frame(operation: ReverseCommandOperation, result: JsonObject | null): ReverseCommandResultFrame {
  return {
    type: "command_result",
    protocol: 1,
    commandId,
    operation,
    status: "applied",
    code: "OK",
    completedAt: 1,
    result,
  };
}

test("Overseer publishes every released Peon session operation", () => {
  assert.deepEqual(REVERSE_COMMAND_OPERATIONS.filter((operation) => operation.startsWith("session.")), [
    "session.metadata.patch", "session.delete",
  ]);
});

test("each released session operation accepts only its canonical success shape", () => {
  const cases: Array<[ReverseCommandOperation, JsonObject]> = [
    ["session.metadata.patch", publicSession],
    ["session.delete", { sessionId, deleted: true }],
  ];
  for (const [operation, result] of cases) {
    assert.doesNotThrow(() => assertSafeReverseCommandResult({
      operation,
      commandId,
      target: { peonId, sessionId },
    }, frame(operation, result)), operation);
    assert.throws(() => assertSafeReverseCommandResult({
      operation,
      commandId,
      target: { peonId, sessionId },
    }, frame(operation, { ...result, credential: "must-not-cross" })), operation);
  }
});

test("session rejection and conflict allowlists fail closed", () => {
  const record = {
    operation: "session.metadata.patch" as const,
    commandId,
    target: { peonId, sessionId },
  };
  assert.doesNotThrow(() => assertSafeReverseCommandResult(record, {
    ...frame("session.metadata.patch", null),
    status: "conflict",
    code: "RESUME_IN_PROGRESS",
  }));
  assert.throws(() => assertSafeReverseCommandResult(record, {
    ...frame("session.metadata.patch", null),
    status: "rejected",
    code: "SECRET_DETAIL",
  }));
});
