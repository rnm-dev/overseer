import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const canonicalSchema = async () => JSON.parse(await readFile(
  new URL("../../protocol/reverse-command-v1/schema.json", import.meta.url),
  "utf8",
));

test("session catalog reads and mutations are absent from reverse-command-v1", async () => {
  const schema = await canonicalSchema();
  const operations = schema.$defs.command.properties.operation.enum ?? [];
  for (const operation of ["session.list", "session.metadata.patch", "session.delete"]) {
    assert.equal(operations.includes(operation), false, operation);
  }
});

test("direct HTTP session operations are absent from the canonical reverse contract", async () => {
  const schema = await canonicalSchema();
  const advertised = schema.$defs.command.properties.operation.enum ?? [];
  assert.equal(advertised.includes("session.start"), false);
  assert.equal(advertised.includes("session.followup"), false);
  assert.equal(advertised.includes("session.cancel"), false);
  assert.equal(advertised.includes("session.detail"), false);
  assert.equal(advertised.includes("session.list"), false);
  assert.equal(advertised.includes("session.metadata.patch"), false);
  assert.equal(advertised.includes("session.delete"), false);
  for (const operation of [
    "session.queue.add", "session.queue.list", "session.queue.edit",
    "session.queue.remove", "session.queue.steer", "session.queue.send-now",
  ]) assert.equal(advertised.includes(operation), false, operation);
});

test("session catalog, rename and delete use Fleet HTTP while realtime catalog stays on sockets", async () => {
  const source = await readFile(
    new URL("../../../apps/server/src/routes/peons/sessions.ts", import.meta.url),
    "utf8",
  );
  for (const route of [
    'router.get(`${wp}/sessions`',
    'router.patch(`${wp}/sessions/:sid`',
    'router.delete(`${wp}/sessions/:sid`',
  ]) assert.ok(source.includes(route), route);
  assert.ok(source.includes('"GET", "/sessions"'));
  assert.ok(source.includes('"PATCH", `/sessions/${encodeURIComponent(sid)}`'));
  assert.ok(source.includes('"DELETE", `/sessions/${encodeURIComponent(sid)}`'));
  assert.equal(source.includes('"session.metadata.patch"'), false);
  assert.equal(source.includes('"session.delete"'), false);

  const catalog = await readFile(
    new URL("../../../apps/peon/src/daemon/overseer/socket/channels/sessionCatalogChannel.ts", import.meta.url),
    "utf8",
  );
  assert.ok(catalog.includes("session_catalog_event"));
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
    "router.post(`${wp}/sessions/:sid/queue/:itemId/send`",
    "router.post(`${wp}/sessions/:sid/queue/:itemId/steer`",
    'operation: "send"',
    'operation: "steer"',
  ]) assert.ok(queueRoutes.includes(fragment), fragment);
});
