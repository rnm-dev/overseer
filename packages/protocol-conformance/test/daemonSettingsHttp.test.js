import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("daemon settings use Fleet HTTP and stay out of reverse control", async () => {
  const [routes, peonApi, socket, peonSchema, serverSchema] = await Promise.all([
    readFile(new URL("../../../apps/server/src/routes/peons/projects.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../apps/peon/src/daemon/agentApi.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../apps/peon/src/daemon/overseer/socket/peonSocket.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../apps/peon/protocol/reverse-command-v1/schema.json", import.meta.url), "utf8"),
    readFile(new URL("../../../apps/server/protocol/reverse-command-v1/schema.json", import.meta.url), "utf8"),
  ]);

  assert.equal(peonSchema, serverSchema);
  assert.equal(peonSchema.includes("daemon.configuration.patch"), false);
  assert.equal(routes.includes('operation: "daemon.configuration.patch"'), false);
  assert.equal(routes.includes('callPeon(connOfRecord(c.record), "GET", "/settings"'), true);
  assert.equal(routes.includes('callPeon(connOfRecord(c.record), "PATCH", "/settings"'), true);
  assert.equal(peonApi.includes('"Peon-Configuration-Revision"'), true);
  assert.equal(peonApi.includes("patchDaemonConfiguration"), true);
  assert.equal(socket.includes("daemonConfigurationChannel"), false);
});
