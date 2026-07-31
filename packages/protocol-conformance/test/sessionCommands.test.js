import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const operations = [
  "session.metadata.patch", "session.delete",
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
});

test("session mutation transport selection is exclusive before admission", () => {
  const select = ({ connected, operations: advertised }, operation) =>
    connected && advertised.includes(operation) ? "reverse" : "legacy";
  for (const operation of operations) {
    assert.equal(select({ connected: true, operations }, operation), "reverse");
    assert.equal(select({ connected: true, operations: ["session.metadata.patch"] }, operation),
      operation === "session.metadata.patch" ? "reverse" : "legacy");
    assert.equal(select({ connected: false, operations }, operation), "legacy");
  }
});

test("direct HTTP session operations are absent from the reverse contract on both peers", async () => {
  const [peon, overseer] = await Promise.all([
    readFile(new URL("../../../apps/peon/protocol/reverse-command-v1/schema.json", import.meta.url), "utf8"),
    readFile(new URL("../../../apps/server/protocol/reverse-command-v1/schema.json", import.meta.url), "utf8"),
  ]);
  for (const schema of [JSON.parse(peon), JSON.parse(overseer)]) {
    const advertised = schema.$defs.command.properties.operation.enum;
    assert.equal(advertised.includes("session.start"), false);
    assert.equal(advertised.includes("session.followup"), false);
    assert.equal(advertised.includes("session.cancel"), false);
    assert.equal(advertised.includes("session.detail"), false);
    for (const operation of [
      "session.queue.add", "session.queue.list", "session.queue.edit",
      "session.queue.remove", "session.queue.send-now",
    ]) assert.equal(advertised.includes(operation), false, operation);
  }
});

test("all public queue routes use the single Fleet HTTP path", async () => {
  const source = await readFile(
    new URL("../../../apps/server/src/routes/peons/sessions.ts", import.meta.url),
    "utf8",
  );
  const queueStart = source.indexOf("router.get(`${wp}/sessions/:sid/queue`");
  const queueEnd = source.indexOf("// Stop is self-healing", queueStart);
  assert.ok(queueStart >= 0 && queueEnd > queueStart);
  const queueRoutes = source.slice(queueStart, queueEnd);
  assert.equal(queueRoutes.includes("selectSessionTransport"), false);
  assert.equal(queueRoutes.includes("reverseSession"), false);
  assert.equal(queueRoutes.includes("reverseCommandOperation"), false);
  for (const fragment of [
    '"GET", `/sessions/${encodeURIComponent(String(req.params.sid))}/queue`',
    '"POST", `/sessions/${encodeURIComponent(sid)}/queue`',
    '"PATCH",',
    '"DELETE",',
    '/queue/${encodeURIComponent(String(req.params.itemId))}/send',
  ]) assert.ok(queueRoutes.includes(fragment), fragment);
});
