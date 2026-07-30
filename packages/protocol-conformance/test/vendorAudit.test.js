import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditVendoredContracts } from "../src/index.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("shared schema and fixture vendors have an executable, content-free drift audit", () => {
  const report = auditVendoredContracts(repositoryRoot, [
    {
      id: "peon-claim-v1-schema",
      copies: ["apps/server/protocol/peon-claim-v1/schema.json", "apps/peon/protocol/peon-claim-v1/schema.json"],
    },
    {
      id: "peon-claim-v1-fixtures",
      copies: ["apps/server/protocol/peon-claim-v1/fixtures.json", "apps/peon/protocol/peon-claim-v1/fixtures.json"],
    },
    {
      id: "peon-claim-v1-security-vectors",
      copies: ["apps/server/protocol/peon-claim-v1/security-vectors.json", "apps/peon/protocol/peon-claim-v1/security-vectors.json"],
    },
    {
      id: "reverse-command-v1-schema",
      copies: ["apps/server/protocol/reverse-command-v1/schema.json", "apps/peon/protocol/reverse-command-v1/schema.json"],
    },
    {
      id: "reverse-command-v1-fixtures",
      copies: ["apps/server/protocol/reverse-command-v1/fixtures.json", "apps/peon/protocol/reverse-command-v1/fixtures.json"],
    }
  ]);

  assert.equal(report.find((entry) => entry.id === "peon-claim-v1-schema")?.identical, true);
  assert.equal(report.find((entry) => entry.id === "peon-claim-v1-fixtures")?.identical, true);
  assert.equal(report.find((entry) => entry.id === "peon-claim-v1-security-vectors")?.identical, true);
  assert.equal(report.find((entry) => entry.id === "reverse-command-v1-schema")?.identical, false);
  assert.equal(report.find((entry) => entry.id === "reverse-command-v1-schema")?.jsonEquivalent, true);
  assert.equal(report.find((entry) => entry.id === "reverse-command-v1-fixtures")?.identical, true);
  assert.ok(report.every((entry) => entry.copies.every((copy) => /^[0-9a-f]{64}$/.test(copy.sha256))));
  assert.equal(JSON.stringify(report).includes("session.cancel"), false);
});
