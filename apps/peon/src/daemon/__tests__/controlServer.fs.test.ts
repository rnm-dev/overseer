import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlServer } from "../controlServer.js";

test("generic filesystem API browses a caller-selected root without escaping it", async (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "peon-fs-test-"));
  const root = path.join(fixture, "root");
  const outside = path.join(fixture, "outside");
  mkdirSync(path.join(root, "nested"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, "nested", "hello.txt"), "hello from root\n");
  writeFileSync(path.join(outside, "secret.txt"), "outside\n");
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape-link"));

  const server = createControlServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const query = (values: Record<string, string>) => new URLSearchParams(values).toString();

  t.after(() => {
    server.close();
    rmSync(fixture, { recursive: true, force: true });
  });

  const listing = await fetch(`${base}/api/v1/fs?${query({ root })}`);
  assert.equal(listing.status, 200);
  assert.deepEqual(
    ((await listing.json()) as { entries: Array<{ name: string; type: string }> }).entries.map(({ name, type }) => ({ name, type })),
    [
      { name: "nested", type: "dir" },
      { name: "escape-link", type: "other" },
    ],
  );

  const file = await fetch(`${base}/api/v1/fs/file?${query({ root, path: "nested/hello.txt" })}`);
  assert.equal(file.status, 200);
  assert.equal(((await file.json()) as { content: string }).content, "hello from root\n");

  const traversal = await fetch(`${base}/api/v1/fs/file?${query({ root, path: "../outside/secret.txt" })}`);
  assert.equal(traversal.status, 400);
  assert.equal(((await traversal.json()) as { error: string }).error, "path escapes root directory");

  const symlink = await fetch(`${base}/api/v1/fs/file?${query({ root, path: "escape-link" })}`);
  assert.equal(symlink.status, 400);
  assert.equal(((await symlink.json()) as { error: string }).error, "path escapes root directory");

  const relativeRoot = await fetch(`${base}/api/v1/fs?${query({ root: "." })}`);
  assert.equal(relativeRoot.status, 400);
  assert.equal(((await relativeRoot.json()) as { error: string }).error, "root must be an absolute path");
});
