import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

test("project-directory-watch-v1 golden frames conform to the shared wire contract", () => {
  const root = path.resolve(import.meta.dirname, "../../../../../docs/protocol/project-directory-watch-v1");
  const schema = JSON.parse(readFileSync(path.join(root, "schema.json"), "utf8"));
  const fixtures = JSON.parse(readFileSync(path.join(root, "fixtures.json"), "utf8"));
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  for (const frame of fixtures.valid) assert.equal(validate(frame), true, JSON.stringify(validate.errors));
  for (const frame of fixtures.invalid) assert.equal(validate(frame), false, JSON.stringify(frame));
});
