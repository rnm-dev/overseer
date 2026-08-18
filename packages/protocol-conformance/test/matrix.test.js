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
      controlCapabilities: ["session-catalog-v1", "project-catalog-v1"],
      transferCapabilities: [],
    },
    {
      controlCapabilities: ["session-catalog-v1", "durable-delivery-v1", "project-catalog-v1"],
      transferCapabilities: [],
    },
  );
  assert.deepEqual(negotiated.control, []);
  assert.equal(routeForSurface("session-catalog", negotiated), "legacy-http");
  assert.equal(routeForSurface("project-catalog", negotiated), "legacy-http");
  assert.equal(routeForSurface("absolute-folder-picker", negotiated), "legacy-http");
  assert.equal(routeForSurface("project-directory", negotiated), "legacy-http");
});

test("all file bytes and mutations select the single Fleet HTTP authority", () => {
  const negotiated = negotiateCapabilities(
    { controlCapabilities: [], transferCapabilities: ["file-write-v1"] },
    { controlCapabilities: [], transferCapabilities: ["file-write-v1"] },
  );
  for (const surface of [
    "project-file-read", "sandbox-file-read", "project-file-upload",
    "attachment-upload", "project-file-move", "project-file-delete",
  ]) assert.equal(routeForSurface(surface, negotiated), "legacy-http");
  assert.equal("transfer" in negotiated, false);
});

test("update control always uses the single Fleet HTTP authority", () => {
  const current = negotiateCapabilities(
    { controlCapabilities: ["reverse-command-v1"], transferCapabilities: [] },
    { controlCapabilities: ["reverse-command-v1"], transferCapabilities: [] },
  );
  assert.equal(routeForSurface("peon-update", current), "legacy-http");
  assert.equal(routeForSurface("peon-update", {
    control: [], transfer: [], channelFeatures: {},
  }), "legacy-http");
});

test("covered contracts are distinguished from explicitly blocked extension cells", () => {
  const report = runCapabilityMatrix(loadFixture("capability-matrix-v1.json"));
  const reverseCommand = report.extensions.find((entry) => entry.id === "reverse-command");
  assert.equal(reverseCommand?.passed, true);
  assert.equal(reverseCommand?.blocked, false);
  const transcripts = report.extensions.find((entry) => entry.id === "transcripts");
  assert.equal(transcripts?.passed, true);
  assert.equal(transcripts?.blocked, false);
  const updates = report.extensions.find((entry) => entry.id === "updates");
  assert.equal(updates?.passed, true);
  assert.equal(updates?.blocked, false);
  const blocked = report.extensions.filter((entry) => entry.blocked);
  assert.deepEqual(blocked.map((entry) => entry.id), ["rollout"]);
  assert.ok(blocked.every((entry) => !entry.passed && entry.blockedBy.length > 20));
});

test("transcript history always uses the single Fleet HTTP authority", () => {
  const report = runCapabilityMatrix(loadFixture("capability-matrix-v1.json"));
  assert.equal(report.cells.filter((cell) => cell.routes["session-transcript"] === "legacy-http").length, 9);
});
