import assert from "node:assert/strict";
import test from "node:test";
import {
  loadFixture,
  negotiateCapabilities,
  routeForSurface,
  runCapabilityMatrix,
} from "../src/index.js";

test("Peon × Overseer stable capability and downgrade matrix is green", () => {
  const fixture = loadFixture("capability-matrix-v1.json");
  const report = runCapabilityMatrix(fixture);

  assert.equal(report.cells.length, 9);
  assert.equal(report.failed, 0, report.cells.flatMap((cell) => cell.errors).join("\n"));
  for (const cell of report.cells) {
    for (const route of Object.values(cell.routes)) {
      assert.ok(["reverse-socket", "legacy-http", "unavailable"].includes(route));
    }
  }
});

test("canonical catalog dependencies are all-or-nothing and fallback is exclusive", () => {
  const negotiated = negotiateCapabilities(
    {
      controlCapabilities: ["session-catalog-v1", "project-catalog-v1", "folder-listing-v1"],
      transferCapabilities: [],
    },
    {
      controlCapabilities: ["session-catalog-v1", "durable-delivery-v1", "project-catalog-v1", "folder-listing-v1"],
      transferCapabilities: [],
    },
  );
  assert.deepEqual(negotiated.control, ["folder-listing-v1"]);
  assert.equal(routeForSurface("session-catalog", negotiated), "legacy-http");
  assert.equal(routeForSurface("project-catalog", negotiated), "legacy-http");
  assert.equal(routeForSurface("absolute-folder-picker", negotiated), "reverse-socket");
});

test("covered contracts are distinguished from explicitly blocked extension cells", () => {
  const report = runCapabilityMatrix(loadFixture("capability-matrix-v1.json"));
  const reverseCommand = report.extensions.find((entry) => entry.id === "reverse-command");
  assert.equal(reverseCommand?.passed, true);
  assert.equal(reverseCommand?.blocked, false);
  const transcripts = report.extensions.find((entry) => entry.id === "transcripts");
  assert.equal(transcripts?.passed, true);
  assert.equal(transcripts?.blocked, false);
  const blocked = report.extensions.filter((entry) => entry.blocked);
  assert.deepEqual(blocked.map((entry) => entry.id), ["writes", "rollout"]);
  assert.ok(blocked.every((entry) => !entry.passed && entry.blockedBy.length > 20));
});
