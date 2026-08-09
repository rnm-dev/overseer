import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = (relative: string) => readFileSync(path.resolve(import.meta.dirname, "..", relative), "utf8");

test("bounded runtime request routes use only Fleet HTTP", () => {
  const projects = source("routes/peons/projects.ts");
  for (const route of ["/stats", "/analytics", "/quota/${provider}", "/capabilities/${provider}"]) {
    assert.ok(projects.includes(route));
  }
  assert.ok(!projects.includes("runRuntimeCommandTransport"));
  assert.ok(!projects.includes('"runtime.stats"'));
  assert.ok(!projects.includes('"runtime.analytics"'));
  assert.ok(!projects.includes('"runtime.quota"'));
  assert.ok(!projects.includes('"runtime.capabilities"'));
});

test("workspace members may use read-only AI runtime routes", () => {
  const projects = source("routes/peons/projects.ts");
  for (const route of ["stats", "analytics", "quota/:provider", "capabilities/:provider"]) {
    const start = projects.indexOf(`router.get(\`${"${wp}"}/${route}\``);
    assert.notEqual(start, -1, `missing ${route} route`);
    const end = projects.indexOf("}));", start);
    assert.doesNotMatch(projects.slice(start, end), /ownerOnly\(/);
  }
});

test("explicit status and model reads do not select the runtime projection", () => {
  const sessions = source("routes/peons/sessions.ts");
  assert.match(sessions, /callPeon\(connOfRecord\(c\.record\), "GET", "\/status"/);
  assert.match(sessions, /callPeon\(connOfRecord\(c\.record\), "GET", "\/models"/);
  assert.ok(!sessions.includes("getRuntimeProjection"));
  assert.ok(!sessions.includes("RUNTIME_STATE_CAPABILITY"));
});

test("runtime query operations are absent from reverse command registries", () => {
  const serverTypes = source("modules/reverseCommands/reverseCommandTypes.ts");
  const peonOperations = source("../../peon/src/daemon/overseer/socket/channels/reverseCommandOperations.ts");
  for (const operation of [
    "runtime.stats", "runtime.analytics", "runtime.quota", "runtime.capabilities",
  ]) {
    assert.ok(!serverTypes.includes(operation));
    assert.ok(!peonOperations.includes(operation));
  }
});
