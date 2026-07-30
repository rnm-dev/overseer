import assert from "node:assert/strict";
import test from "node:test";
import {
  compareOperationRegistries,
  OperationRegistryError,
  readDeclaredOperations,
} from "../src/index.js";

test("Overseer and Peon declare the same reverse-command operation set", () => {
  const { overseer, peon, missingFromPeon, missingFromOverseer } = compareOperationRegistries();
  assert.ok(overseer.length > 0);
  assert.deepEqual(missingFromPeon, [], "operations Overseer sends that Peon does not advertise");
  assert.deepEqual(missingFromOverseer, [], "operations Peon handles that Overseer never sends");
  assert.equal(peon.length, overseer.length);
});

test("a declaration that is missing, empty or repeated is an error rather than an empty set", () => {
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
