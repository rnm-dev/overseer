import assert from "node:assert/strict";
import test from "node:test";

test("agents public index exports explicit API", async () => {
  const api = await import("../agents/index.js");
  const keys = Object.keys(api);

  assert.equal(keys.includes("runAgent"), true);
  assert.equal(keys.includes("normalizeStoredAgentEvent"), true);
  assert.equal(keys.includes("registerAgentDriver"), true);
  assert.equal(keys.includes("agentServices"), true);
  assert.equal(keys.includes("listAgentDrivers"), true);
  assert.equal(keys.includes("getAgentDriver"), true);
  assert.equal(keys.includes("requireAgentDriver"), true);
  assert.equal(keys.includes("shutdownAgentDriverRuntimes"), true);

  assert.equal(keys.includes("agentRegistry"), false);
  assert.equal(keys.includes("agentExecutor"), false);
});
