import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const source = async (path) => readFile(new URL(path, root), "utf8");
const json = async (path) => JSON.parse(await source(path));

test("Armory uses Fleet HTTP and is absent from reverse-command-v1 on both peers", async () => {
  const [route, serverSchema, peonSchema, serverOperations, peonOperations] = await Promise.all([
    source("apps/server/src/routes/peons/armory.ts"),
    json("apps/server/protocol/reverse-command-v1/schema.json"),
    json("apps/peon/protocol/reverse-command-v1/schema.json"),
    source("apps/server/src/modules/reverseCommands/reverseCommandTypes.ts"),
    source("apps/peon/src/daemon/overseer/socket/channels/reverseCommandOperations.ts"),
  ]);

  assert.match(route, /import \{ callPeon, connOfRecord \}/);
  assert.doesNotMatch(route, /reverseCommand|runReverseCommandTransport|armoryCall/);
  assert.equal((route.match(/\bcallPeon\(/g) ?? []).length, 23);
  assert.match(route, /armory-project-packages-v1/);
  for (const path of [
    '"/armory/profiles"',
    '`/armory/profiles/${id}`',
    '`/armory/profiles/${id}/configuration`',
    '`/armory/profiles/${id}/verify`',
    '`/armory/projects/${ids.projectId}/assignments`',
    '`/armory/projects/${ids.projectId}/assignments/${ids.packageId}`',
  ]) assert.ok(route.includes(path), path);
  assert.match(route, /ARMORY_ACTIVATION_RETIRED/);

  for (const schema of [serverSchema, peonSchema]) {
    const operations = schema.$defs.command.properties.operation.enum ?? [];
    assert.equal(operations.some((operation) => operation.startsWith("armory.")), false);
    assert.equal(Object.hasOwn(schema.$defs.target.properties, "packageId"), false);
    assert.equal(Object.hasOwn(schema.$defs.target.properties, "operationId"), false);
  }
  assert.doesNotMatch(serverOperations, /"armory\./);
  assert.doesNotMatch(peonOperations, /"armory\./);
});
