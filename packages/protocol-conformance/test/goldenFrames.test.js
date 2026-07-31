import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedDiagnostics,
  executeGoldenFrames,
  loadFixture,
  validateGoldenFrame,
} from "../src/index.js";

test("shared stable golden frames execute across every released reverse surface", () => {
  const fixture = loadFixture("stable-v1.json");
  const diagnostics = new BoundedDiagnostics({ clock: () => 1785400000000 });
  const report = executeGoldenFrames(fixture, { diagnostics });

  assert.equal(report.failed, 0, report.cases.filter((entry) => !entry.passed).map((entry) => entry.errors).join("\n"));
  assert.equal(report.passed, fixture.frames.length);
  assert.deepEqual(
    [...new Set(report.cases.map((entry) => entry.surface))].sort(),
    ["catalog", "socket"],
  );
  assert.ok(report.diagnostics.bytes <= report.diagnostics.bounds.maxBytes);
});

test("golden adapters fail closed for unknown schemas and byte limits", () => {
  assert.deepEqual(
    validateGoldenFrame({ schema: "unfinished.transcript", limit: "control", frame: {} }, { control: 1024 }).errors,
    ["no adapter for unfinished.transcript"],
  );
  const result = validateGoldenFrame({
    schema: "socket.control.hello",
    limit: "tiny",
    frame: { type: "hello", protocol: 1, padding: "x".repeat(200) },
  }, { tiny: 32 });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /limit/);
});

test("unfinished families can register adapters without changing the stable runner", () => {
  const entry = {
    schema: "transcript.snapshot_request",
    limit: "control",
    frame: { type: "transcript_snapshot_request", sessionId: "session-a" },
  };
  const result = validateGoldenFrame(entry, { control: 1024 }, {
    "transcript.snapshot_request": (frame, errors) => {
      if (frame.type !== "transcript_snapshot_request" || typeof frame.sessionId !== "string") {
        errors.push("invalid transcript snapshot request");
      }
    },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});
