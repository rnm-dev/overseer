import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-session-size-state-"));

const { sessionArtifactInventory, sessionsDir, sessionsSizeBytes } = await import("../sessions/sessionArtifacts.js");

test("sessionsSizeBytes includes all regular session artifacts recursively", () => {
  mkdirSync(path.join(sessionsDir, "session-1", "attachments"), { recursive: true });
  writeFileSync(path.join(sessionsDir, "session-1.summary.json"), "summary");
  writeFileSync(path.join(sessionsDir, "session-1.jsonl"), "transcript");
  writeFileSync(path.join(sessionsDir, "session-1", "attachments", "file.bin"), Buffer.alloc(13));

  assert.equal(sessionsSizeBytes(), 7 + 10 + 13);
});

test("sessionsSizeBytes ignores symlinks instead of following files outside the store", () => {
  const outside = path.join(path.dirname(sessionsDir), "outside.bin");
  writeFileSync(outside, Buffer.alloc(100));
  symlinkSync(outside, path.join(sessionsDir, "outside-link"));

  assert.equal(sessionsSizeBytes(), 7 + 10 + 13);
});

test("session artifact inventory groups top-level files and nested artifacts by session id", () => {
  writeFileSync(path.join(sessionsDir, "session-2.summary.json"), "sum");
  writeFileSync(path.join(sessionsDir, "session-2.jsonl"), "events");
  mkdirSync(path.join(sessionsDir, "session-2", "previews"), { recursive: true });
  writeFileSync(path.join(sessionsDir, "session-2", "previews", "page.html"), "preview");
  writeFileSync(path.join(sessionsDir, "unmatched.tmp"), "orphan");

  const inventory = sessionArtifactInventory();
  assert.equal(inventory.bySessionId.get("session-1"), 7 + 10 + 13);
  assert.equal(inventory.bySessionId.get("session-2"), 3 + 6 + 7);
  assert.equal(inventory.totalBytes, (7 + 10 + 13) + (3 + 6 + 7) + 6);
});
