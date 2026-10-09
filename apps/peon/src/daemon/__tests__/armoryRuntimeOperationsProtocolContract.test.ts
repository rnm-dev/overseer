import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const root = path.resolve(import.meta.dirname, "../../../../../docs/protocol/armory-package-operations-v1");
const schema = JSON.parse(readFileSync(path.join(root, "schema.json"), "utf8")) as { $id: string; $defs: Record<string, unknown> };
const fixtures = JSON.parse(readFileSync(path.join(root, "fixtures.json"), "utf8")) as { contractVersion: number; capability: string; examples: Array<{ schema: string; value: unknown }> };

test("Armory package operation fixtures validate and contain no payload fields", () => {
  assert.equal(fixtures.contractVersion, 1);
  assert.equal(fixtures.capability, "armory-package-operations-v1");
  const ajv = new Ajv2020({ strict: true, formats: { uuid: /^[0-9a-f-]{36}$/ } });
  ajv.addSchema(schema);
  for (const example of fixtures.examples) {
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${example.schema}` });
    assert.equal(validate(example.value), true, ajv.errorsText(validate.errors));
  }
  assert.doesNotMatch(JSON.stringify(fixtures), /arguments|results|values|credentials|stderr/i);
});
