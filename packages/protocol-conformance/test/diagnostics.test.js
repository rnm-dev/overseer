import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedDiagnostics,
  redactDiagnostic,
} from "../src/index.js";

test("diagnostics redact credentials, prompts, transcripts, actors and sensitive paths", () => {
  const redacted = redactDiagnostic({
    authorization: "Bearer pn_super_secret",
    prompt: "implement the private thing",
    transcript: [{ text: "private output" }],
    actorEmail: "operator@example.com",
    localPath: "/Users/viktor/private/project",
    message: "failed with Bearer pn_inline_secret at /tmp/private.txt",
    stableCode: "PATH_ESCAPE",
  });
  const serialized = JSON.stringify(redacted);

  for (const secret of ["pn_super_secret", "private thing", "private output", "operator@example.com", "/Users/viktor", "/tmp/private.txt"]) {
    assert.equal(serialized.includes(secret), false, `diagnostic leaked ${secret}`);
  }
  assert.equal(redacted.stableCode, "PATH_ESCAPE");
  assert.match(redacted.message, /REDACTED/);
});

test("diagnostic artifacts enforce entry, byte, value and collection bounds", () => {
  const diagnostics = new BoundedDiagnostics({
    maxEntries: 3,
    maxBytes: 640,
    maxValueLength: 48,
    clock: () => 1785400000000,
  });
  for (let index = 0; index < 12; index += 1) {
    diagnostics.add("injected_failure", { index, detail: "x".repeat(400), values: Array.from({ length: 80 }, (_, item) => item) });
  }
  const artifact = diagnostics.artifact();

  assert.ok(artifact.entries.length <= 3);
  assert.ok(artifact.bytes <= 640);
  assert.ok(artifact.droppedEntries > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(artifact), "utf8") < 2048);
});
