import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  REVERSE_COMMAND_CAPABILITY,
  REVERSE_COMMAND_MAX_FRAME_BYTES,
  REVERSE_COMMAND_OPERATIONS,
} from "../dist/index.js";

const root = new URL("../", import.meta.url);

test("generated exports match the canonical reverse-command fixture", async () => {
  const fixtures = JSON.parse(await readFile(new URL("reverse-command-v1/fixtures.json", root), "utf8"));
  assert.equal(REVERSE_COMMAND_CAPABILITY, fixtures.capability);
  assert.equal(REVERSE_COMMAND_MAX_FRAME_BYTES, fixtures.maxCommandFrameBytes);
  assert.deepEqual(REVERSE_COMMAND_OPERATIONS, fixtures.enabledOperations);
});

test("the package contains the one canonical protocol document and schema", async () => {
  const protocol = await readFile(new URL("PROTOCOL.md", root), "utf8");
  const schema = JSON.parse(await readFile(new URL("reverse-command-v1/schema.json", root), "utf8"));
  assert.match(protocol, /^# Overseer ↔ Peon protocol/);
  assert.equal(schema.$id, "urn:rnm-dev:protocol:reverse-command-v1");
});
