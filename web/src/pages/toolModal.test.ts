import assert from "node:assert/strict";
import test from "node:test";
import { editDiff, editStats, editStatsFromInput } from "./peon/session/messageParts";
import { toolHasOutputSection } from "./peon/session/parsing";

test("edit tool details omit the output section", () => {
  assert.equal(toolHasOutputSection("Edit"), false);
  assert.equal(toolHasOutputSection("edit"), false);
  assert.equal(toolHasOutputSection(" EDIT "), false);
});

test("other tool detail types retain their output section", () => {
  assert.equal(toolHasOutputSection("Bash"), true);
  assert.equal(toolHasOutputSection("Read"), true);
  assert.equal(toolHasOutputSection(undefined), true);
});

test("edit stats count added and removed lines for modal and chat labels", () => {
  assert.deepEqual(editStats([
    { kind: "context", text: "same" },
    { kind: "remove", text: "old one" },
    { kind: "remove", text: "old two" },
    { kind: "add", text: "new" },
  ]), { added: 1, removed: 2 });
  assert.equal(editStats(null), null);
  assert.deepEqual(editStatsFromInput({ changes: [{ diff: "--- a/file\n+++ b/file\n-old one\n-old two\n+new" }] }), { added: 1, removed: 2 });
  assert.deepEqual(editStatsFromInput({ old_string: "old one\nold two", new_string: "new" }), { added: 1, removed: 2 });
});

test("edit diff tracks old and new file line numbers across unified diff hunks", () => {
  const lines = editDiff({ changes: [{ path: "file.ts", diff: "--- a/file.ts\n+++ b/file.ts\n@@ -10,3 +10,4 @@\n same\n-old\n+new\n+extra\n tail" }] });
  assert.deepEqual(lines?.slice(3), [
    { kind: "context", text: " same", oldLine: 10, newLine: 10 },
    { kind: "remove", text: "old", oldLine: 11, newLine: undefined },
    { kind: "add", text: "new", oldLine: undefined, newLine: 11 },
    { kind: "add", text: "extra", oldLine: undefined, newLine: 12 },
    { kind: "context", text: " tail", oldLine: 12, newLine: 13 },
  ]);
});

test("old/new string edit diff numbers both sides from line one", () => {
  assert.deepEqual(editDiff({ old_string: "same\nold", new_string: "same\nnew" }), [
    { kind: "context", text: "same", oldLine: 1, newLine: 1 },
    { kind: "add", text: "new", newLine: 2 },
    { kind: "remove", text: "old", oldLine: 2 },
  ]);
});
