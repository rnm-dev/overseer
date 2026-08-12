// Acceptance tests for project-scoped file browsing and mutations
// (GET/PUT/PATCH/DELETE /api/v1/projects/:key/files*) — see PROTOCOL.md "Project files" and
// the task that added them. Every daemon module that touches disk reads
// XDG_CONFIG_HOME/XDG_STATE_HOME once at import time, so those env vars are
// pointed at a scratch dir *before* any daemon module is imported (dynamic
// `import()`, not a static one, since static imports are hoisted above this).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";

const configHome = mkdtempSync(path.join(os.tmpdir(), "peon-test-config-"));
const stateHome = mkdtempSync(path.join(os.tmpdir(), "peon-test-state-"));
process.env.XDG_CONFIG_HOME = configHome;
process.env.XDG_STATE_HOME = stateHome;

const { settings } = await import("../settings/index.js");
const { projectStore } = await import("../projects/contracts.js");
const { createAgentRouter } = await import("../agentApi.js");
const { AtomicFileUpload, moveProjectFile: moveProjectFileAtomic } = await import("../files/index.js");
let uploadOpenOptions: Parameters<typeof AtomicFileUpload.open>[3] = {};
let projectMoveOptions: Parameters<typeof moveProjectFileAtomic>[3] = {};

const TOKEN = "test-bearer-token";
settings.update({ overseerToken: TOKEN });

const app = express();
app.use(express.json());
app.use("/api/v1", createAgentRouter({
  openProjectUpload: (target, maxBytes, claimedSha256) => (
    AtomicFileUpload.open(target, maxBytes, claimedSha256, uploadOpenOptions)
  ),
  moveProjectFile: (record, source, destination) => (
    moveProjectFileAtomic(record, source, destination, projectMoveOptions)
  ),
}));
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api/v1`;

test.after(() => server.close());

function authed(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${p}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
}

function upload(p: string, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  return authed(p, {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/octet-stream", ...headers },
  });
}

function move(p: string, destination: string): Promise<Response> {
  return authed(p, {
    method: "PATCH",
    body: JSON.stringify({ destination }),
    headers: { "Content-Type": "application/json" },
  });
}

function rawUpload(
  p: string,
  contentLength: number,
  drive: (req: ReturnType<typeof request>) => void,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${p}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(contentLength),
      },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    drive(req);
  });
}

function uploadTemps(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".peon-upload-"));
}

// --- fixture project ---------------------------------------------------
const projectDir = mkdtempSync(path.join(os.tmpdir(), "peon-test-project-"));
const outsideDir = mkdtempSync(path.join(os.tmpdir(), "peon-test-outside-"));
const otherProjectDir = mkdtempSync(path.join(os.tmpdir(), "peon-test-other-project-"));
const transferDir = mkdtempSync(path.join(os.tmpdir(), "peon-test-transfer-root-"));
writeFileSync(path.join(outsideDir, "secret.txt"), "outside content");
writeFileSync(path.join(projectDir, "README.md"), "hello world");
mkdirSync(path.join(projectDir, "src"));
writeFileSync(path.join(projectDir, "src", "main.ts"), "console.log(1)");
mkdirSync(path.join(projectDir, "src", "a dir with spaces"));
writeFileSync(path.join(projectDir, "src", "a dir with spaces", "café.txt"), "unicode content");
symlinkSync(outsideDir, path.join(projectDir, "escape-link"));
symlinkSync(path.join(outsideDir, "secret.txt"), path.join(projectDir, "escape-file"));
writeFileSync(path.join(projectDir, "big.txt"), Array.from({ length: 200 }, (_, i) => String(i % 10)).join(""));
writeFileSync(path.join(otherProjectDir, "other.txt"), "other project");
writeFileSync(path.join(transferDir, "transfer.txt"), "transfer sandbox");

const record = projectStore.createProject({ key: "proj1", label: "Proj1", dir: projectDir });
assert.equal(record.dir, projectDir);
projectStore.createProject({ key: "proj2", label: "Proj2", dir: otherProjectDir });
settings.update({ fileTransferRoot: transferDir });

test("lists the project root via /files?stat=1", async () => {
  const res = await authed("/projects/proj1/files?stat=1");
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.path, "");
  const names = body.entries.map((e: { name: string }) => e.name).sort();
  assert.ok(names.includes("README.md"));
  assert.ok(names.includes("src"));
  const readme = body.entries.find((e: { name: string }) => e.name === "README.md");
  assert.equal(readme.type, "file");
  assert.equal(readme.size, "hello world".length);
});

test("/files/ (trailing slash) also addresses the project root", async () => {
  const res = await authed("/projects/proj1/files/?stat=1");
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.path, "");
  assert.ok(body.entries.some((e: { name: string }) => e.name === "README.md"));
});

test("a symlink leaving the project root is listed inert, not traversable", async () => {
  const res = await authed("/projects/proj1/files?stat=1");
  const body = (await res.json()) as any;
  const link = body.entries.find((e: { name: string }) => e.name === "escape-link");
  assert.ok(link, "escape-link entry present");
  assert.equal(link.type, "other");
  assert.equal(link.size, null);
});

test("lists a nested directory, including unicode/space-named entries", async () => {
  const res = await authed("/projects/proj1/files/src?stat=1");
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.path, "src");
  const names = body.entries.map((e: { name: string }) => e.name).sort();
  assert.ok(names.includes("main.ts"));
  assert.ok(names.includes("a dir with spaces"));
});

test("downloads a text file with its content", async () => {
  const res = await authed("/projects/proj1/files/README.md");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "hello world");
  assert.match(res.headers.get("content-type") ?? "", /text/);
});

test("stat=1 on a file returns size/mtimeMs/sha256", async () => {
  const res = await authed("/projects/proj1/files/README.md?stat=1");
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.path, "README.md");
  assert.equal(body.type, "file");
  assert.equal(body.size, "hello world".length);
  assert.equal(typeof body.mtimeMs, "number");
  assert.equal(typeof body.sha256, "string");
  assert.equal(body.sha256.length, 64);
});

test("Unicode and URL-encoded path segments resolve correctly", async () => {
  const res = await authed("/projects/proj1/files/src/a%20dir%20with%20spaces/caf%C3%A9.txt");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "unicode content");
});

test("Range request returns exactly the requested byte count with 206", async () => {
  const res = await authed("/projects/proj1/files/big.txt", { headers: { Range: "bytes=0-99" } });
  assert.equal(res.status, 206);
  const text = await res.text();
  assert.equal(text.length, 100);
  assert.match(res.headers.get("content-range") ?? "", /^bytes 0-99\/200$/);
});

test("unknown project returns 404 UNKNOWN_PROJECT", async () => {
  const res = await authed("/projects/does-not-exist/files?stat=1");
  assert.equal(res.status, 404);
  const body = (await res.json()) as any;
  assert.equal(body.code, "UNKNOWN_PROJECT");
});

test("missing path returns 404 NOT_FOUND", async () => {
  const res = await authed("/projects/proj1/files/nope.txt?stat=1");
  assert.equal(res.status, 404);
  const body = (await res.json()) as any;
  assert.equal(body.code, "NOT_FOUND");
});

test("encoded traversal escaping the root returns 400 PATH_ESCAPE, no disclosure", async () => {
  const res = await authed("/projects/proj1/files/..%2F..%2Fetc%2Fpasswd?stat=1");
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.code, "PATH_ESCAPE");
});

test("a literal .. segment never yields a 200 (either PATH_ESCAPE or a routing 404)", async () => {
  const res = await authed("/projects/proj1/files/../secret?stat=1");
  assert.notEqual(res.status, 200);
});

test("an absolute-looking joined path (double slash) returns PATH_ESCAPE", async () => {
  const res = await authed("/projects/proj1/files//etc/passwd?stat=1");
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.code, "PATH_ESCAPE");
});

test("a symlink leaving the root, requested directly, returns PATH_ESCAPE not its external metadata", async () => {
  const res = await authed("/projects/proj1/files/escape-link?stat=1");
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.code, "PATH_ESCAPE");
  assert.equal(body.size, undefined);
});

test("a directory without ?stat=1 is 400 IS_DIRECTORY", async () => {
  const res = await authed("/projects/proj1/files/src");
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.code, "IS_DIRECTORY");
});

test("unsupported project-file mutation methods remain 404 or 405", async () => {
  const res = await authed("/projects/proj1/files/README.md", { method: "POST" });
  assert.ok(res.status === 404 || res.status === 405, `POST got ${res.status}`);
  assert.equal(await (await authed("/projects/proj1/files/README.md")).text(), "hello world");
});

test("missing bearer token is rejected", async () => {
  const res = await fetch(`${base}/projects/proj1/files?stat=1`);
  assert.equal(res.status, 401);
});

test("uploads to the project root and returns bytes through the existing GET route", async () => {
  const bytes = Buffer.from("uploaded at root\n");
  const res = await upload("/projects/proj1/files/uploaded.txt", bytes);
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), {
    path: "uploaded.txt",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const get = await authed("/projects/proj1/files/uploaded.txt");
  assert.equal(await get.text(), bytes.toString());
  assert.equal(statSync(path.join(projectDir, "uploaded.txt")).mode & 0o111, 0, "client upload does not acquire executable bits");
});

test("uploads sequential files into an existing Unicode/space-named folder", async () => {
  for (const [name, content] of [["one.txt", "first"], ["два.txt", "second"]] as const) {
    const route = `/projects/proj1/files/src/a%20dir%20with%20spaces/${encodeURIComponent(name)}`;
    const res = await upload(route, content);
    assert.equal(res.status, 201);
    assert.equal((await res.json() as { path: string }).path, `src/a dir with spaces/${name}`);
    assert.equal(readFileSync(path.join(projectDir, "src", "a dir with spaces", name), "utf8"), content);
  }
});

test("replacement remains atomic while a slow upload is in flight", async () => {
  const destination = path.join(projectDir, "atomic.txt");
  const oldBody = "old-complete-content";
  const newBody = "new-complete-content";
  writeFileSync(destination, oldBody);

  let continueUpload!: () => void;
  const paused = new Promise<void>((resolve) => { continueUpload = resolve; });
  let firstHalfSent!: () => void;
  const firstHalf = new Promise<void>((resolve) => { firstHalfSent = resolve; });
  const requestDone = rawUpload("/projects/proj1/files/atomic.txt", Buffer.byteLength(newBody), async (req) => {
    req.write(newBody.slice(0, 5));
    firstHalfSent();
    await paused;
    req.end(newBody.slice(5));
  });
  await firstHalf;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await (await authed("/projects/proj1/files/atomic.txt")).text(), oldBody);
  continueUpload();
  assert.equal((await requestDone).status, 201);
  assert.equal(await (await authed("/projects/proj1/files/atomic.txt")).text(), newBody);
  assert.deepEqual(uploadTemps(projectDir), []);
});

test("legacy HTTP upload fails closed if its destination parent is swapped before commit", async () => {
  const parent = path.join(projectDir, "http-swap-parent");
  const anchored = path.join(projectDir, "http-swap-parent-held");
  mkdirSync(parent);
  const body = "parent-swap-body";
  let continueUpload!: () => void;
  const paused = new Promise<void>((resolve) => { continueUpload = resolve; });
  let firstHalfSent!: () => void;
  const firstHalf = new Promise<void>((resolve) => { firstHalfSent = resolve; });
  const requestDone = rawUpload(
    "/projects/proj1/files/http-swap-parent/result.txt",
    Buffer.byteLength(body),
    async (req) => {
      req.write(body.slice(0, 4));
      firstHalfSent();
      await paused;
      req.end(body.slice(4));
    },
  );
  await firstHalf;
  await new Promise((resolve) => setTimeout(resolve, 25));
  renameSync(parent, anchored);
  symlinkSync(outsideDir, parent);
  continueUpload();
  const response = await requestDone;
  assert.equal(response.status, 400);
  assert.equal(JSON.parse(response.body).code, "PATH_ESCAPE");
  assert.equal(readdirSync(outsideDir).includes("result.txt"), false);
  assert.equal(readdirSync(anchored).includes("result.txt"), false);
  assert.deepEqual(uploadTemps(anchored), []);
});

test("legacy HTTP temp creation stays in its anchored parent when the pathname is swapped during open", async () => {
  const parent = path.join(projectDir, "http-open-swap-parent");
  const anchored = path.join(projectDir, "http-open-swap-parent-held");
  mkdirSync(parent);
  uploadOpenOptions = {
    beforeTemporaryOpen: () => {
      renameSync(parent, anchored);
      symlinkSync(outsideDir, parent);
    },
    afterTemporaryOpen: () => {
      assert.equal(uploadTemps(outsideDir).length, 0);
      assert.equal(uploadTemps(anchored).length, 1);
    },
  };
  try {
    const response = await upload("/projects/proj1/files/http-open-swap-parent/result.txt", "anchored-http-open");
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, "PATH_ESCAPE");
    assert.equal(readdirSync(outsideDir).includes("result.txt"), false);
    assert.equal(readdirSync(anchored).includes("result.txt"), false);
    assert.deepEqual(uploadTemps(outsideDir), []);
    assert.deepEqual(uploadTemps(anchored), []);
  } finally {
    uploadOpenOptions = {};
  }
});

test("legacy HTTP upload commits after its pathname-swapped anchored parent is restored during open", async () => {
  const parent = path.join(projectDir, "http-open-restore-parent");
  const anchored = path.join(projectDir, "http-open-restore-parent-held");
  mkdirSync(parent);
  uploadOpenOptions = {
    beforeTemporaryOpen: () => {
      renameSync(parent, anchored);
      symlinkSync(outsideDir, parent);
    },
    afterTemporaryOpen: () => {
      assert.equal(uploadTemps(outsideDir).length, 0);
      assert.equal(uploadTemps(anchored).length, 1);
      unlinkSync(parent);
      renameSync(anchored, parent);
    },
  };
  try {
    const body = "restored-http-parent";
    const response = await upload("/projects/proj1/files/http-open-restore-parent/result.txt", body);
    assert.equal(response.status, 201);
    assert.equal(readFileSync(path.join(parent, "result.txt"), "utf8"), body);
    assert.equal(readdirSync(outsideDir).includes("result.txt"), false);
    assert.deepEqual(uploadTemps(outsideDir), []);
    assert.deepEqual(uploadTemps(parent), []);
  } finally {
    uploadOpenOptions = {};
  }
});

test("accepts a correct checksum and rejects a mismatch without replacing the destination", async () => {
  const content = "checksum content";
  const digest = createHash("sha256").update(content).digest("hex");
  assert.equal((await upload("/projects/proj1/files/checksum.txt", content, { "Peon-Content-Sha256": digest })).status, 201);
  const mismatch = await upload("/projects/proj1/files/checksum.txt", "bad replacement", { "Peon-Content-Sha256": "0".repeat(64) });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json() as { code: string }).code, "CHECKSUM_MISMATCH");
  assert.equal(readFileSync(path.join(projectDir, "checksum.txt"), "utf8"), content);
  assert.deepEqual(uploadTemps(projectDir), []);
});

test("an aborted upload leaves neither a destination nor a temporary file", async () => {
  const destination = path.join(projectDir, "aborted.bin");
  await new Promise<void>((resolve) => {
    const req = request(`${base}/projects/proj1/files/aborted.bin`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(1024 * 1024),
      },
    });
    req.on("error", () => resolve());
    req.write(Buffer.alloc(32 * 1024, 1));
    setTimeout(() => req.destroy(), 10);
  });
  const cleanupDeadline = Date.now() + 2_000;
  while (uploadTemps(projectDir).length > 0 && Date.now() < cleanupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(readdirSync(projectDir).includes(path.basename(destination)), false);
  assert.deepEqual(uploadTemps(projectDir), []);
});

test("rejects an oversized upload from Content-Length without retaining a partial file", async () => {
  const result = await rawUpload("/projects/proj1/files/too-large.bin", 100 * 1024 * 1024 + 1, (req) => req.end());
  assert.equal(result.status, 413);
  assert.equal(JSON.parse(result.body).code, "FILE_TOO_LARGE");
  assert.equal(readdirSync(projectDir).includes("too-large.bin"), false);
  assert.deepEqual(uploadTemps(projectDir), []);
});

test("an upload only creates missing folders when it asks to", async () => {
  const withoutParents = await upload("/projects/proj1/files/dropped-folder/nested/file.txt", "no parents");
  assert.equal(withoutParents.status, 404);
  assert.equal((await withoutParents.json() as { code: string }).code, "PARENT_NOT_FOUND");
  assert.equal(readdirSync(projectDir).includes("dropped-folder"), false);

  const withParents = await upload("/projects/proj1/files/dropped-folder/nested/file.txt?parents=1", "with parents");
  assert.equal(withParents.status, 201);
  assert.equal(readFileSync(path.join(projectDir, "dropped-folder", "nested", "file.txt"), "utf8"), "with parents");
});

test("created upload parents stay inside the project root", async () => {
  const escape = await upload("/projects/proj1/files/..%2Fescaped%2Ffile.txt?parents=1", "escaping");
  assert.equal(escape.status, 400);
  assert.equal((await escape.json() as { code: string }).code, "PATH_ESCAPE");

  const throughLink = await upload("/projects/proj1/files/escape-link/nested/file.txt?parents=1", "through a link");
  assert.notEqual(throughLink.status, 201);
  assert.equal((await throughLink.json() as { code: string }).code, "PATH_ESCAPE");
});

test("upload failures use stable path, parent, and project error codes", async () => {
  const cases: Array<[string, string]> = [
    ["/projects/missing/files/file.txt", "UNKNOWN_PROJECT"],
    ["/projects/proj1/files/missing-parent/file.txt", "PARENT_NOT_FOUND"],
    ["/projects/proj1/files/src", "INVALID_PATH"],
    ["/projects/proj1/files/..%2F..%2Fescape.txt", "PATH_ESCAPE"],
    ["/projects/proj1/files//etc/passwd", "PATH_ESCAPE"],
    ["/projects/proj1/files/bad%00name", "INVALID_PATH"],
    ["/projects/proj1/files/escape-link/stolen.txt", "PATH_ESCAPE"],
    ["/projects/proj1/files/escape-file", "PATH_ESCAPE"],
  ];
  for (const [route, code] of cases) {
    const res = await upload(route, "blocked");
    assert.notEqual(res.status, 201, route);
    assert.equal((await res.json() as { code: string }).code, code, route);
  }
  assert.equal(readFileSync(path.join(outsideDir, "secret.txt"), "utf8"), "outside content");
});

test("one project cannot upload into another project or fileTransferRoot", async () => {
  for (const route of [
    "/projects/proj1/files/..%2F" + encodeURIComponent(path.basename(otherProjectDir)) + "%2Fother.txt",
    "/projects/proj1/files/..%2F" + encodeURIComponent(path.basename(transferDir)) + "%2Ftransfer.txt",
  ]) {
    const res = await upload(route, "intrusion");
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { code: string }).code, "PATH_ESCAPE");
  }
  assert.equal(readFileSync(path.join(otherProjectDir, "other.txt"), "utf8"), "other project");
  assert.equal(readFileSync(path.join(transferDir, "transfer.txt"), "utf8"), "transfer sandbox");
});

test("moves a regular file into a nested folder and back to the project root", async () => {
  writeFileSync(path.join(projectDir, "move-me.txt"), "move body");
  const intoFolder = await move("/projects/proj1/files/move-me.txt", "src/a dir with spaces/moved.txt");
  assert.equal(intoFolder.status, 200);
  assert.deepEqual(await intoFolder.json(), { path: "src/a dir with spaces/moved.txt", size: 9 });
  assert.equal(readdirSync(projectDir).includes("move-me.txt"), false);
  assert.equal(await (await authed("/projects/proj1/files/src/a%20dir%20with%20spaces/moved.txt")).text(), "move body");

  const back = await move("/projects/proj1/files/src/a%20dir%20with%20spaces/moved.txt", "moved-back.txt");
  assert.equal(back.status, 200);
  assert.equal(readFileSync(path.join(projectDir, "moved-back.txt"), "utf8"), "move body");
  assert.equal(readdirSync(path.join(projectDir, "src", "a dir with spaces")).includes("moved.txt"), false);
});

test("moves a whole folder, and refuses to move one inside itself", async () => {
  mkdirSync(path.join(projectDir, "movable-folder", "nested"), { recursive: true });
  writeFileSync(path.join(projectDir, "movable-folder", "nested", "leaf.txt"), "leaf body");

  const moved = await move("/projects/proj1/files/movable-folder", "src/movable-folder");
  assert.equal(moved.status, 200);
  assert.equal((await moved.json() as { path: string }).path, "src/movable-folder");
  assert.equal(readdirSync(projectDir).includes("movable-folder"), false);
  assert.equal(readFileSync(path.join(projectDir, "src", "movable-folder", "nested", "leaf.txt"), "utf8"), "leaf body");

  // The kernel is what refuses this; the daemon only has to name the refusal.
  const intoItself = await move("/projects/proj1/files/src/movable-folder", "src/movable-folder/nested/movable-folder");
  assert.equal(intoItself.status, 400);
  assert.equal((await intoItself.json() as { code: string }).code, "INVALID_PATH");
  assert.equal(readFileSync(path.join(projectDir, "src", "movable-folder", "nested", "leaf.txt"), "utf8"), "leaf body");

  const back = await move("/projects/proj1/files/src/movable-folder", "movable-folder");
  assert.equal(back.status, 200);
  assert.equal(readFileSync(path.join(projectDir, "movable-folder", "nested", "leaf.txt"), "utf8"), "leaf body");
});

test("move refuses a destination that is an existing folder", async () => {
  mkdirSync(path.join(projectDir, "occupied-folder"), { recursive: true });
  writeFileSync(path.join(projectDir, "folder-clash.txt"), "clash");
  const res = await move("/projects/proj1/files/folder-clash.txt", "occupied-folder");
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { code: string }).code, "DESTINATION_EXISTS");
  assert.equal(readFileSync(path.join(projectDir, "folder-clash.txt"), "utf8"), "clash");
});

test("move refuses an existing destination without modifying either file", async () => {
  writeFileSync(path.join(projectDir, "move-source.txt"), "source");
  writeFileSync(path.join(projectDir, "move-destination.txt"), "destination");
  const res = await move("/projects/proj1/files/move-source.txt", "move-destination.txt");
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { code: string }).code, "DESTINATION_EXISTS");
  assert.equal(readFileSync(path.join(projectDir, "move-source.txt"), "utf8"), "source");
  assert.equal(readFileSync(path.join(projectDir, "move-destination.txt"), "utf8"), "destination");
});

test("legacy HTTP PATCH derives both move paths from one anchored project root during pathname swap and restore", async () => {
  const heldRoot = `${projectDir}-http-move-held`;
  const sourceName = "http-root-swap-source.txt";
  const destinationName = "http-root-swap-destination.txt";
  writeFileSync(path.join(projectDir, sourceName), "authorized-http-source");
  writeFileSync(path.join(outsideDir, sourceName), "outside-http-source");
  projectMoveOptions = {
    afterProjectRootOpen: () => {
      renameSync(projectDir, heldRoot);
      symlinkSync(outsideDir, projectDir);
    },
    beforeCommit: () => {
      assert.equal(readdirSync(outsideDir).includes(destinationName), false);
      unlinkSync(projectDir);
      renameSync(heldRoot, projectDir);
    },
  };
  try {
    const response = await move(`/projects/proj1/files/${sourceName}`, destinationName);
    assert.equal(response.status, 200);
    assert.equal(readFileSync(path.join(projectDir, destinationName), "utf8"), "authorized-http-source");
    assert.equal(readdirSync(projectDir).includes(sourceName), false);
    assert.equal(readFileSync(path.join(outsideDir, sourceName), "utf8"), "outside-http-source");
    assert.equal(readdirSync(outsideDir).includes(destinationName), false);
  } finally {
    projectMoveOptions = {};
    if (readdirSync(path.dirname(projectDir)).includes(path.basename(heldRoot))) {
      try {
        unlinkSync(projectDir);
      } catch { /* the root pathname was already restored */ }
      renameSync(heldRoot, projectDir);
    }
  }
});

test("move rejects invalid sources and sandbox escapes with stable errors", async () => {
  const cases: Array<[string, string, string]> = [
    ["/projects/missing/files/file.txt", "target.txt", "UNKNOWN_PROJECT"],
    ["/projects/proj1/files/no-such.txt", "target.txt", "NOT_FOUND"],
    ["/projects/proj1/files/escape-file", "target.txt", "PATH_ESCAPE"],
    ["/projects/proj1/files/README.md", "README.md", "INVALID_PATH"],
    ["/projects/proj1/files/README.md", "missing-parent/file.txt", "PARENT_NOT_FOUND"],
    ["/projects/proj1/files/README.md", "../outside.txt", "PATH_ESCAPE"],
    ["/projects/proj1/files/README.md", path.join("..", path.basename(otherProjectDir), "other.txt"), "PATH_ESCAPE"],
    ["/projects/proj1/files/README.md", path.join("..", path.basename(transferDir), "transfer.txt"), "PATH_ESCAPE"],
    ["/projects/proj1/files/README.md", "escape-link/stolen.txt", "PATH_ESCAPE"],
    ["/projects/proj1/files/README.md", "/tmp/absolute.txt", "PATH_ESCAPE"],
    ["/projects/proj1/files/README.md", "bad\0name", "INVALID_PATH"],
  ];
  for (const [route, destination, code] of cases) {
    const res = await move(route, destination);
    assert.notEqual(res.status, 200, `${route} -> ${destination}`);
    assert.equal((await res.json() as { code: string }).code, code, `${route} -> ${destination}`);
  }
  assert.equal(readFileSync(path.join(projectDir, "README.md"), "utf8"), "hello world");
  assert.equal(readFileSync(path.join(otherProjectDir, "other.txt"), "utf8"), "other project");
  assert.equal(readFileSync(path.join(transferDir, "transfer.txt"), "utf8"), "transfer sandbox");
});

test("deletes only a canonical regular file", async () => {
  const target = path.join(projectDir, "delete-me.txt");
  writeFileSync(target, "delete body");
  const deleted = await authed("/projects/proj1/files/delete-me.txt", { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { path: "delete-me.txt", size: 11 });
  assert.equal(readdirSync(projectDir).includes("delete-me.txt"), false);

  for (const [route, code] of [
    ["/projects/proj1/files/src", "INVALID_PATH"],
    ["/projects/proj1/files/escape-file", "PATH_ESCAPE"],
    ["/projects/proj1/files/no-such.txt", "NOT_FOUND"],
    ["/projects/proj1/files/..%2Foutside.txt", "PATH_ESCAPE"],
  ] as const) {
    const res = await authed(route, { method: "DELETE" });
    assert.equal((await res.json() as { code: string }).code, code, route);
  }
  assert.equal(readFileSync(path.join(outsideDir, "secret.txt"), "utf8"), "outside content");
});
