import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DirectoryWatchRegistry, directoryWatchTarget } from "../files/index.js";

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "filesystem event timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
test("native watcher broadcasts create/change/rename/delete and closes after last subscriber", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "peon-watch-"));
  const watches = new DirectoryWatchRegistry();
  let first = 0; let second = 0;
  const stopA = watches.subscribe(dir, () => first++);
  const stopB = watches.subscribe(dir, () => second++);
  try {
    assert.equal(watches.size, 1);
    const a = path.join(dir, "a"); const b = path.join(dir, "b");
    for (const mutate of [() => writeFileSync(a, "one"), () => writeFileSync(a, "two"), () => renameSync(a, b), () => rmSync(b)]) {
      const before = first;
      mutate();
      await waitFor(() => first > before && second > before);
    }
    stopA(); assert.equal(watches.size, 1);
    const before = second;
    writeFileSync(a, "last");
    await waitFor(() => second > before);
    assert.equal(first, before);
    stopB(); assert.equal(watches.size, 0);
  } finally { stopA(); stopB(); rmSync(dir, { recursive: true, force: true }); }
});

test("watch target rejects escape and detects replaced root, directory and symlink", () => {
  const base = mkdtempSync(path.join(tmpdir(), "peon-watch-target-"));
  try {
    const root = path.join(base, "root"); mkdirSync(root);
    mkdirSync(path.join(root, "child"));
    symlinkSync(base, path.join(root, "escape"));
    for (const relative of ["../", "/tmp", "C:\\temp", "a/../b", "escape", "a\0b"]) {
      assert.throws(() => directoryWatchTarget(root, relative));
    }
    const original = directoryWatchTarget(root, "child");
    assert.equal(original.valid(), true);
    renameSync(path.join(root, "child"), path.join(root, "old"));
    mkdirSync(path.join(root, "child"));
    assert.equal(original.valid(), false);
    const rootTarget = directoryWatchTarget(root, "");
    renameSync(root, path.join(base, "old-root")); mkdirSync(root);
    assert.equal(rootTarget.valid(), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("replacement gets a new native watcher even before old stream is reaped", () => {
  const base = mkdtempSync(path.join(tmpdir(), "peon-watch-replace-"));
  const watches = new DirectoryWatchRegistry();
  const dir = path.join(base, "dir"); mkdirSync(dir);
  const stopA = watches.subscribe(dir, () => {});
  renameSync(dir, path.join(base, "old")); mkdirSync(dir);
  const stopB = watches.subscribe(dir, () => {});
  try { assert.equal(watches.size, 2); }
  finally { stopA(); stopB(); assert.equal(watches.size, 0); rmSync(base, { recursive: true, force: true }); }
});
