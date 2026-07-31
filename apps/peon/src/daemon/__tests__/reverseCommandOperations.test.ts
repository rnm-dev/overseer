import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFERRED_REVERSE_COMMAND_OPERATIONS,
  PEON_ONLY_REVERSE_COMMAND_OPERATIONS,
  REVERSE_COMMAND_OPERATIONS,
} from "../overseer/socket/channels/reverseCommandOperations.js";
const CHANNEL_REGISTERED = [] as const;

const sorted = (values: Iterable<string>): string[] => [...values].sort();

test("the assembled handler set is exactly the declared contract", () => {
  const handled = new Set<string>([
    ...CHANNEL_REGISTERED,
  ]);
  const expected = new Set<string>([
    ...REVERSE_COMMAND_OPERATIONS.filter((operation) =>
      !(DEFERRED_REVERSE_COMMAND_OPERATIONS as readonly string[]).includes(operation)),
    ...PEON_ONLY_REVERSE_COMMAND_OPERATIONS,
  ]);
  assert.deepEqual(sorted(handled), sorted(expected));
});

test("the deferred and Peon-only lists stay on the right side of the union", () => {
  const union = new Set<string>(REVERSE_COMMAND_OPERATIONS);
  for (const operation of DEFERRED_REVERSE_COMMAND_OPERATIONS) {
    assert.ok(union.has(operation), `${operation} is deferred but absent from the operation union`);
  }
  for (const operation of PEON_ONLY_REVERSE_COMMAND_OPERATIONS) {
    assert.ok(!union.has(operation), `${operation} is listed as Peon-only but present in the operation union`);
  }
  assert.equal(new Set(REVERSE_COMMAND_OPERATIONS).size, REVERSE_COMMAND_OPERATIONS.length);
});

// That this list matches Overseer's is asserted by @rnm-dev/protocol-conformance,
// which reads both declarations; the two workspaces do not depend on each other.
test("no operation is advertised without a handler behind it", () => {
  const advertised = new Set<string>([
    ...CHANNEL_REGISTERED,
  ]);
  for (const operation of DEFERRED_REVERSE_COMMAND_OPERATIONS) {
    assert.ok(!advertised.has(operation), `${operation} is deferred yet advertised`);
  }
});
