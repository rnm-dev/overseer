import assert from "node:assert/strict";
import test from "node:test";
import {
  compareOperationRegistries,
  OperationRegistryError,
  readDeclaredOperations,
} from "../src/index.js";

test("Overseer and Peon consume the canonical reverse-command operation set", () => {
  const { overseer, peon, missingFromPeon, missingFromOverseer } = compareOperationRegistries();
  assert.deepEqual(overseer, []);
  assert.deepEqual(missingFromPeon, [], "operations Overseer sends that Peon does not advertise");
  assert.deepEqual(missingFromOverseer, [], "operations Peon handles that Overseer never sends");
  assert.equal(peon.length, overseer.length);
});

test("a missing declaration or escaping source path remains an error", () => {
  assert.throws(
    () => readDeclaredOperations({
      file: "apps/server/src/modules/reverseCommands/reverseCommandTypes.ts",
      binding: "NOT_A_DECLARED_BINDING",
    }),
    OperationRegistryError,
  );
  assert.throws(
    () => readDeclaredOperations({ file: "../outside.ts", binding: "REVERSE_COMMAND_OPERATIONS" }),
    OperationRegistryError,
  );
});
