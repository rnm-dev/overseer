import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const schema = JSON.parse(readFileSync(path.join(root, "protocol/reverse-command-v1/schema.json"), "utf8"));
const fixtures = JSON.parse(readFileSync(path.join(root, "protocol/reverse-command-v1/fixtures.json"), "utf8"));

test("reverse command v1 fixtures stay aligned with the normative schema", () => {
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

test("reverse command v1 keeps remote daemon pause and resume disabled", () => {
  assert.ok(!fixtures.enabledOperations.includes("daemon.pause"));
  assert.ok(!fixtures.enabledOperations.includes("daemon.resume"));
  assert.deepEqual(schema.$defs.command.properties.operation.not, {});
});

test("reverse command v1 publishes no update operations", () => {
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

test("request/response reads owned by Fleet HTTP are not reverse command operations", () => {
  const operations = fixtures.enabledOperations as string[];
  for (const operation of [
    "runtime.status", "runtime.models", "runtime.stats", "runtime.analytics",
    "runtime.quota", "runtime.capabilities",
  ]) assert.equal(operations.includes(operation), false);
  assert.equal(operations.some((operation) => operation.startsWith("armory.")), false);
});

test("Peon and Overseer reverse-command-v1 vendors are byte-identical", () => {
  const overseerRoot = path.resolve(root, "..");
  assert.equal(
    readFileSync(path.join(root, "protocol/reverse-command-v1/schema.json"), "utf8"),
    readFileSync(path.join(overseerRoot, "server/protocol/reverse-command-v1/schema.json"), "utf8"),
  );
  assert.equal(
    readFileSync(path.join(root, "protocol/reverse-command-v1/fixtures.json"), "utf8"),
    readFileSync(path.join(overseerRoot, "server/protocol/reverse-command-v1/fixtures.json"), "utf8"),
  );
});
