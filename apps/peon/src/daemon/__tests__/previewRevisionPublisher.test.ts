import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PreviewRevisionPublisher, type PreviewPublication } from "../overseer/socket/previewRevisionPublisher.js";
import { PreviewRevisionState } from "../overseer/socket/previewRevisionState.js";

const waitFor = async (predicate: () => boolean, timeout = 3_000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("publishes atomic saves and deletion tombstones with increasing revisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-publisher-"));
  const publications: PreviewPublication[] = [];
  const publisher = new PreviewRevisionPublisher(new PreviewRevisionState(), (item) => {
    publications.push(item);
    return true;
  });
  try {
    await writeFile(path.join(root, "report.txt"), "one");
    await publisher.watch("lease", root, "report.txt", Date.now() + 60_000);
    await waitFor(() => publications.some((item) => item.assets[0]?.bytes.toString() === "one"));
    await writeFile(path.join(root, ".save"), "two");
    await rename(path.join(root, ".save"), path.join(root, "report.txt"));
    await waitFor(() => publications.some((item) => item.assets[0]?.bytes.toString() === "two"));
    await rm(path.join(root, "report.txt"));
    await waitFor(() => publications.some((item) => item.deleted));
    const expected = [
      publications.find((item) => item.assets[0]?.bytes.toString() === "one")!,
      publications.find((item) => item.assets[0]?.bytes.toString() === "two")!,
      publications.find((item) => item.deleted)!,
    ];
    const revisions = expected.map((item) => item.revision);
    assert.ok(revisions.slice(1).every((revision, index) => revision > revisions[index]!));
  } finally {
    publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("coalesces bursts and retries a backpressured complete publication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-publisher-"));
  const attempts: PreviewPublication[] = [];
  let accept = false;
  const publisher = new PreviewRevisionPublisher(new PreviewRevisionState(), (item) => {
    attempts.push(item);
    if (!accept) {
      accept = true;
      return false;
    }
    return true;
  });
  try {
    await writeFile(path.join(root, "report.txt"), "one");
    await publisher.watch("lease", root, "report.txt", Date.now() + 60_000);
    await writeFile(path.join(root, "report.txt"), "two");
    await writeFile(path.join(root, "report.txt"), "three");
    await waitFor(() => attempts.length >= 2);
    assert.equal(attempts.at(-1)?.assets[0]?.bytes.toString(), "three");
    assert.ok((attempts.at(-1)?.revision ?? 0) > (attempts[0]?.revision ?? 0));
  } finally {
    publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("builds a bounded content-addressed HTML bundle before publication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-publisher-"));
  const publications: PreviewPublication[] = [];
  const publisher = new PreviewRevisionPublisher(new PreviewRevisionState(), (item) => {
    publications.push(item);
    return true;
  });
  try {
    await mkdir(path.join(root, "site"));
    await mkdir(path.join(root, "site", "assets"));
    await writeFile(path.join(root, "site", "index.html"), "<script src=\"app.js\"></script>");
    await writeFile(path.join(root, "site", "app.js"), "ok()");
    await writeFile(path.join(root, "site", "assets", "theme.css"), "body{}");
    await publisher.watch("lease", root, "site/index.html", Date.now() + 60_000);
    await waitFor(() => publications.some((item) =>
      item.assets.some((asset) => asset.path.endsWith("theme.css") && asset.bytes.toString() === "body{}")));
    const initial = publications.find((item) =>
      item.assets.some((asset) => asset.path.endsWith("theme.css") && asset.bytes.toString() === "body{}"))!;
    assert.deepEqual(initial.assets.map((asset) => asset.path), [
      "site/app.js",
      "site/assets/theme.css",
      "site/index.html",
    ]);
    assert.match(initial.assets[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
    await writeFile(path.join(root, "site", "assets", "theme.css"), "body{color:red}");
    await waitFor(() => publications.some((item) =>
      item.assets.some((asset) => asset.path.endsWith("theme.css") && asset.bytes.toString() === "body{color:red}")));
  } finally {
    publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects traversal and escaping symlinks before installing a watcher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-publisher-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "preview-outside-"));
  const publisher = new PreviewRevisionPublisher(new PreviewRevisionState(), () => true);
  try {
    await writeFile(path.join(outside, "secret"), "secret");
    await symlink(path.join(outside, "secret"), path.join(root, "link"));
    await assert.rejects(publisher.watch("one", root, "../secret", Date.now() + 1_000), /INVALID_PREVIEW_PATH/);
    await assert.rejects(publisher.watch("two", root, "link", Date.now() + 1_000), /PREVIEW_PATH_ESCAPE/);
  } finally {
    publisher.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
