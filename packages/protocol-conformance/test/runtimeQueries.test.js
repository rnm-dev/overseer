import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bounded runtime queries use Fleet HTTP and stay out of reverse-command-v1", async () => {
  const [schemaRaw, projectRoutes, sessionRoutes] = await Promise.all([
    readFile(new URL("../../protocol/reverse-command-v1/schema.json", import.meta.url), "utf8"),
    readFile(new URL("../../../apps/server/src/routes/peons/projects.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../apps/server/src/routes/peons/sessions.ts", import.meta.url), "utf8"),
  ]);
  const schema = JSON.parse(schemaRaw);
  assert.equal(schema.$id, "urn:rnm-dev:protocol:reverse-command-v1");
  const operations = [];
  for (const operation of [
    "runtime.stats", "runtime.analytics", "runtime.quota", "runtime.capabilities",
  ]) assert.equal(operations.includes(operation), false, operation);

  for (const route of ["/stats", "/analytics", "/quota/${provider}", "/capabilities/${provider}"]) {
    assert.ok(projectRoutes.includes(route), route);
  }
  assert.equal(projectRoutes.includes("runRuntimeCommandTransport"), false);
  assert.ok(sessionRoutes.includes('"GET", "/status"'));
  assert.ok(sessionRoutes.includes('"GET", "/models"'));
  assert.equal(sessionRoutes.includes("getRuntimeProjection"), false);
});

test("runtime-state-v1 remains a socket projection", async () => {
  const [peonChannel, serverProjection] = await Promise.all([
    readFile(new URL(
      "../../../apps/peon/src/daemon/overseer/socket/channels/runtimeStateChannel.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../../../apps/server/src/modules/fleet/runtimeProjection.ts", import.meta.url), "utf8"),
  ]);
  assert.ok(peonChannel.includes('RUNTIME_STATE_CAPABILITY = "runtime-state-v1"'));
  assert.ok(peonChannel.includes('type: "runtime_state"'));
  assert.ok(serverProjection.includes('RUNTIME_STATE_CAPABILITY = "runtime-state-v1"'));
  assert.ok(serverProjection.includes('"fresh" | "stale" | "offline"'));
});
