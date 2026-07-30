import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const schemaRaw = readFileSync(path.join(root, "protocol/reverse-command-v1/schema.json"), "utf8");
const fixturesRaw = readFileSync(path.join(root, "protocol/reverse-command-v1/fixtures.json"), "utf8");
const schema = JSON.parse(schemaRaw);
const fixtures = JSON.parse(fixturesRaw);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("vendored reverse command v1 fixtures match the shared contract", () => {
  assert.equal(schema.$id, "https://peon.local/protocol/reverse-command-v1/schema.json");
  assert.equal(fixtures.contractVersion, 1);
  assert.equal(fixtures.capability, "reverse-command-v1");
  assert.deepEqual(fixtures.enabledOperations, ["session.cancel"]);
  assert.equal(fixtures.maxCommandFrameBytes, 60 * 1024);

  const { command, accepted, durableResult, statusRequest, terminalStatus } = fixtures.frames;
  assert.equal(command.capability, fixtures.capability);
  assert.equal(command.operation, "session.cancel");
  assert.deepEqual(command.payload, {});
  assert.deepEqual(schema.$defs.target.required, ["peonId", "sessionId"]);
  assert.match(command.commandId, UUID);
  assert.match(command.target.peonId, UUID);
  assert.match(command.target.sessionId, UUID);
  assert.match(command.actor.userId, UUID);
  assert.ok(Buffer.byteLength(JSON.stringify(command), "utf8") <= fixtures.maxCommandFrameBytes);
  assert.equal(accepted.commandId, command.commandId);
  assert.equal(durableResult.payload.commandId, command.commandId);
  assert.equal(statusRequest.commandId, command.commandId);
  assert.deepEqual(terminalStatus.result, durableResult.payload);
});

test("remote daemon pause and resume are not reverse command operations", () => {
  assert.ok(!fixtures.enabledOperations.includes("daemon.pause"));
  assert.ok(!fixtures.enabledOperations.includes("daemon.resume"));
  assert.ok(!schema.$defs.command.properties.operation.enum.includes("daemon.pause"));
  assert.ok(!schema.$defs.command.properties.operation.enum.includes("daemon.resume"));
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

test("the released v1 contract rejects unreleased project operations", () => {
  assert.deepEqual(schema.$defs.command.properties.operation.enum, ["session.cancel"]);
  assert.equal(schema.$defs.commandAccepted.properties.operation.const, "session.cancel");
  assert.equal(schema.$defs.commandResult.properties.operation.const, "session.cancel");
});
