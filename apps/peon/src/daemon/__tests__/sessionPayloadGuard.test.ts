import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  guardToolOutput,
  PAYLOAD_SAFE_TARGET_RATIO,
  utf8Prefix,
  utf8Suffix,
} from "../sessions/sessionPayloadGuard.js";

test("UTF-8 slicing never returns a broken code point", () => {
  assert.equal(utf8Prefix("a😀b", 4), "a");
  assert.equal(utf8Prefix("a😀b", 5), "a😀");
  assert.equal(utf8Suffix("a😀b", 4), "b");
  assert.equal(utf8Suffix("a😀b", 5), "😀b");
});

test("near-limit output warns without changing content", () => {
  const content = "é".repeat(360);
  const guarded = guardToolOutput("session-near", "tool", content, "command_output", 1_000);
  assert.equal(guarded.content, content);
  assert.equal(guarded.warning?.code, "payload_near_limit");
  assert.equal(guarded.warning?.limitBytes, 1_000);
});

test("protective truncation preserves the full UTF-8 output in a session log", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-payload-guard-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  try {
    const content = `start-${"😀".repeat(500)}-end`;
    const guarded = guardToolOutput("session-large", "tool/1", content, "command_output", 1_000);
    assert.equal(guarded.warning?.code, "payload_truncated");
    assert.ok(guarded.warning?.logPath);
    assert.equal(readFileSync(guarded.warning!.logPath as string, "utf8"), content);
    assert.ok((guarded.warning?.retainedBytes ?? Infinity) <= 1_000 * PAYLOAD_SAFE_TARGET_RATIO);
    assert.match(guarded.content, /Peon truncated this output/);
    assert.equal(guarded.content.includes("�"), false);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
