import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const operations = [
  "session.cancel", "session.start", "session.followup", "session.queue.list",
  "session.queue.add", "session.queue.edit", "session.queue.remove",
  "session.queue.send-now", "session.metadata.patch", "session.delete",
];

test("released reverse session command schemas stay vendored and complete on both peers", async () => {
  const [peon, overseer] = await Promise.all([
    readFile(new URL("../../../apps/peon/protocol/reverse-command-v1/schema.json", import.meta.url), "utf8"),
    readFile(new URL("../../../apps/server/protocol/reverse-command-v1/schema.json", import.meta.url), "utf8"),
  ]);
  assert.equal(overseer, peon);
  const schema = JSON.parse(overseer);
  const advertised = schema.$defs.command.properties.operation.enum;
  for (const operation of operations) assert.ok(advertised.includes(operation), operation);
  const conditionals = schema.$defs.command.allOf;
  assert.ok(conditionals.some((entry) =>
    entry.if?.properties?.operation?.const === "session.queue.add"
      && entry.then?.properties?.payload?.$ref === "#/$defs/sessionQueueAddPayload"));
  assert.equal(schema.$defs.sessionQueueAddPayload.properties.startNow.type, "boolean");
});

test("session mutation transport selection is exclusive before admission", () => {
  const select = ({ connected, operations: advertised }, operation) =>
    connected && advertised.includes(operation) ? "reverse" : "legacy";
  for (const operation of operations) {
    assert.equal(select({ connected: true, operations }, operation), "reverse");
    assert.equal(select({ connected: true, operations: ["session.cancel"] }, operation),
      operation === "session.cancel" ? "reverse" : "legacy");
    assert.equal(select({ connected: false, operations }, operation), "legacy");
  }
});
