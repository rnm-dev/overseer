import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditVendoredContracts } from "../src/index.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("canonical protocol artifacts have an executable, content-free integrity audit", () => {
  const report = auditVendoredContracts(repositoryRoot, [
    {
      id: "reverse-command-v1-schema",
      copies: ["packages/protocol/reverse-command-v1/schema.json"],
    },
    {
      id: "reverse-command-v1-fixtures",
      copies: ["packages/protocol/reverse-command-v1/fixtures.json"],
    }
  ]);

  assert.equal(report.find((entry) => entry.id === "reverse-command-v1-schema")?.identical, true);
  assert.equal(report.find((entry) => entry.id === "reverse-command-v1-schema")?.jsonEquivalent, true);
  assert.equal(report.find((entry) => entry.id === "reverse-command-v1-fixtures")?.identical, true);
  assert.ok(report.every((entry) => entry.copies.every((copy) => /^[0-9a-f]{64}$/.test(copy.sha256))));
  assert.equal(JSON.stringify(report).includes("session.cancel"), false);
});
