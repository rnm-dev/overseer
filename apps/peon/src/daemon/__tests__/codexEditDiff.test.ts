import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_EDIT_DIFF_BYTES,
  MAX_EDIT_DIFF_LINE_BYTES,
  normalizeCodexFileChanges,
} from "../agents/codex.js";

test("app-server file changes preserve patches and mark unavailable diffs", () => {
  assert.equal(normalizeCodexFileChanges({
    changes: [{ path: "/tmp/a", kind: "add", patch: "PATCH" }],
  })[0].diff, "PATCH");
  assert.equal(normalizeCodexFileChanges({
    changes: [{ path: "/tmp/a", kind: "update" }],
  })[0].diffUnavailable, "runtime_did_not_expose_patch");
});

test("app-server file changes use project-relative paths without disguising external paths", () => {
  const changes = normalizeCodexFileChanges({ changes: [
    { path: "/workspace/src/a.ts", kind: "update", diff: "patch-a" },
    { oldPath: "/workspace/old.ts", path: "/workspace/src/new.ts", kind: "rename", diff: "patch-b" },
    { path: "/shared/outside.ts", kind: "update", diff: "patch-c" },
  ] }, "/workspace");
  assert.equal(changes[0].path, "src/a.ts");
  assert.equal(changes[1].oldPath, "old.ts");
  assert.equal(changes[1].path, "src/new.ts");
  assert.equal(changes[2].path, "/shared/outside.ts");
});

test("app-server file-change diffs remain bounded", () => {
  const huge = `--- a/a\n+++ b/a\n@@ -1 +1 @@\n-${"x".repeat(MAX_EDIT_DIFF_BYTES)}\n+z\n`;
  const [change] = normalizeCodexFileChanges({
    changes: [{ path: "/tmp/a", kind: "update", diff: huge }],
  });
  assert.ok(Buffer.byteLength(change.diff as string) <= MAX_EDIT_DIFF_BYTES);
  assert.ok(Math.max(...(change.diff as string).split("\n").map((line) => Buffer.byteLength(line))) <= MAX_EDIT_DIFF_LINE_BYTES);
  assert.equal(change.diffTruncated, true);
  assert.equal(change.diffOriginalBytes, Buffer.byteLength(huge));
});
