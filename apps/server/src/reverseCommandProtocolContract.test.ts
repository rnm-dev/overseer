import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const schemaRaw = readFileSync(path.join(root, "protocol/reverse-command-v1/schema.json"), "utf8");
const fixturesRaw = readFileSync(path.join(root, "protocol/reverse-command-v1/fixtures.json"), "utf8");
const schema = JSON.parse(schemaRaw);
const fixtures = JSON.parse(fixturesRaw);

test("vendored reverse command v1 fixtures match the shared contract", () => {
  assert.equal(schema.$id, "https://peon.local/protocol/reverse-command-v1/schema.json");
  assert.equal(fixtures.contractVersion, 1);
  assert.equal(fixtures.capability, "reverse-command-v1");
  assert.ok(!fixtures.enabledOperations.some((operation: string) => operation.startsWith("session.")));
  assert.equal(fixtures.maxCommandFrameBytes, 60 * 1024);

  assert.deepEqual(fixtures.enabledOperations, []);
  assert.deepEqual(fixtures.frames, {});
  assert.deepEqual(schema.$defs.target.required, ["peonId"]);
  assert.deepEqual(schema.$defs.command.properties.operation.not, {});
});

test("remote daemon pause and resume are not reverse command operations", () => {
  assert.ok(!fixtures.enabledOperations.includes("daemon.pause"));
  assert.ok(!fixtures.enabledOperations.includes("daemon.resume"));
  assert.deepEqual(schema.$defs.command.properties.operation.not, {});
});

test("reverse command v1 publishes stable generic HTTP mappings", () => {
  assert.deepEqual(fixtures.httpMappings, {
    PEON_OFFLINE: 503,
    CAPABILITY_UNAVAILABLE: 503,
    COMMAND_ID_REUSED: 409,
    COMMAND_PENDING: 202,
    COMMAND_TIMEOUT: 504
  });
});

test("the released v1 contract includes no update operations", () => {
  assert.deepEqual(schema.$defs.command.properties.operation.not, {});
  assert.deepEqual(schema.$defs.commandAccepted.properties.operation.not, {});
  assert.deepEqual(schema.$defs.commandResult.properties.operation.not, {});
});
