import assert from "node:assert/strict";
import {
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  dirErrorResponse,
  fileErrorResponse,
  listDirEntries,
  readFileView,
  resolveFromDir,
  resolveWithinDir,
} from "../files/index.js";

function createWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-files-boundary-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "peon-files-outside-"));
  const nested = path.join(root, "nested");
  const unicodeDir = path.join(root, "unicode dir");

  mkdirSync(nested);
  mkdirSync(unicodeDir);
  writeFileSync(path.join(root, "safe.txt"), "hello");
  writeFileSync(path.join(nested, "inner.txt"), "inner");
  writeFileSync(path.join(outside, "secret.txt"), "outside");
  writeFileSync(path.join(unicodeDir, "cafe\u00e9.txt"), "unicode");

  return { root, outside };
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(`errno ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test("resolveWithinDir enforces traversal and symlink containment", (t) => {
  const { root, outside } = createWorkspace();
  const realRoot = realpathSync(root);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape-link"));

  assert.equal(resolveWithinDir(root, "nested/inner.txt"), path.join(realRoot, "nested", "inner.txt"));
  assert.equal(resolveWithinDir(root, "../outside"), null);
  assert.equal(resolveWithinDir(root, path.join("nested", "..", "safe.txt")), path.join(realRoot, "safe.txt"));
  assert.equal(resolveWithinDir(root, "escape-link"), null);
});

test("unicode and realpath-aware helpers preserve safe access", (t) => {
  const { root, outside } = createWorkspace();
  const realRoot = realpathSync(root);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  assert.equal(resolveWithinDir(root, "unicode dir/cafe\u00e9.txt"), path.join(realRoot, "unicode dir", "cafe\u00e9.txt"));
  assert.equal(resolveFromDir(root, "unicode dir/cafe\u00e9.txt"), path.join(realRoot, "unicode dir", "cafe\u00e9.txt"));
});

test("directory listing differentiates directories, files, and disarmed symlinks", (t) => {
  const { root, outside } = createWorkspace();
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  mkdirSync(path.join(root, "dir"));
  writeFileSync(path.join(root, "dir", "file"), "payload");
  symlinkSync(outside, path.join(root, "escape-link"));

  const entries = listDirEntries(root, root);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  assert.equal(byName.get("dir")?.type, "dir");
  assert.equal(byName.get("safe.txt")?.type, "file");
  assert.equal(byName.get("safe.txt")?.size, readFileSync(path.join(root, "safe.txt")).length);
  assert.equal(byName.get("escape-link")?.type, "other");
  assert.equal(byName.get("escape-link")?.size, null);
});

test("readFileView preserves text boundaries and rejects non-files", (t) => {
  const { root } = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const view = readFileView(path.join(root, "safe.txt"));
  assert.equal(view.size, 5);
  assert.equal(view.binary, false);
  assert.equal(view.content, "hello");
  assert.equal(view.truncated, false);

  assert.throws(() => readFileView(root), {
    name: "Error",
  });
});

test("error mapping preserves boundary behavior for directory, file, and permission errors", () => {
  assert.deepEqual(dirErrorResponse(errno("ENOENT")), { status: 404, message: "directory not found" });
  assert.deepEqual(fileErrorResponse(errno("ENOENT")), { status: 404, message: "file not found" });
  assert.deepEqual(dirErrorResponse(errno("ENOTDIR")), { status: 400, message: "not a directory" });
  assert.deepEqual(fileErrorResponse(errno("EISDIR")), { status: 400, message: "not a file" });
  assert.deepEqual(fileErrorResponse(errno("EINVAL")), { status: 400, message: "not a file" });
  assert.deepEqual(dirErrorResponse(errno("EACCES")), { status: 403, message: "permission denied" });
  assert.deepEqual(fileErrorResponse(errno("EACCES")), { status: 403, message: "permission denied" });
});
