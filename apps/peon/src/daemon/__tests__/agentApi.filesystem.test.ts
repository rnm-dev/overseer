import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-filesystem-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-filesystem-state-"));

const { settings } = await import("../settings/index.js");
const { createAgentRouter } = await import("../agentApi.js");

const token = "pn_filesystem_test";
settings.update({ overseerToken: token });

const app = express();
app.use(express.json());
app.use("/api/v1", createAgentRouter());
const server: Server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}/api/v1`;
const headers = { Authorization: `Bearer ${token}` };

const fixture = mkdtempSync(path.join(os.tmpdir(), "peon-filesystem-root-"));
mkdirSync(path.join(fixture, "alpha"));
mkdirSync(path.join(fixture, "bravo"));
writeFileSync(path.join(fixture, "secret.txt"), "must never be returned");
symlinkSync(path.join(fixture, "alpha"), path.join(fixture, "directory-link"));
symlinkSync(path.join(fixture, "secret.txt"), path.join(fixture, "file-link"));
symlinkSync(path.join(fixture, "missing"), path.join(fixture, "broken-link"));
symlinkSync("loop-link", path.join(fixture, "loop-link"));

function filesystemUrl(absPath: string, query = "?stat=1"): string {
  const encoded = absPath.split(path.sep).filter(Boolean).map(encodeURIComponent).join("/");
  return `${base}/filesystem/${encoded}${query}`;
}

test.after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

test("lists only directories and navigable directory symlinks", async () => {
  const response = await fetch(filesystemUrl(fixture), { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    path: fixture,
    entries: [
      { name: "alpha", type: "directory" },
      { name: "bravo", type: "directory" },
      { name: "directory-link", type: "directory" },
    ],
  });

  const throughLink = await fetch(filesystemUrl(path.join(fixture, "directory-link")), { headers });
  assert.equal(throughLink.status, 200);
  assert.deepEqual(await throughLink.json(), { path: path.join(fixture, "directory-link"), entries: [] });
});

test("browses from the filesystem root", async () => {
  for (const route of ["/filesystem?stat=1", "/filesystem/?stat=1"]) {
    const response = await fetch(`${base}${route}`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as { path: string; entries: Array<{ type: string }> };
    assert.equal(body.path, path.parse(fixture).root);
    assert.ok(body.entries.every((entry) => entry.type === "directory"));
  }
});

test("requires authentication and stat mode", async () => {
  assert.equal((await fetch(filesystemUrl(fixture))).status, 401);
  const withoutStat = await fetch(filesystemUrl(fixture, ""), { headers });
  assert.equal(withoutStat.status, 400);
  assert.equal(((await withoutStat.json()) as { code: string }).code, "BAD_REQUEST");
});

test("missing paths and direct file paths return NOT_FOUND without content", async () => {
  for (const target of [path.join(fixture, "missing"), path.join(fixture, "secret.txt"), path.join(fixture, "file-link")]) {
    const response = await fetch(filesystemUrl(target), { headers });
    assert.equal(response.status, 404);
    const body = await response.json() as { code: string; entries?: unknown; content?: unknown };
    assert.equal(body.code, "NOT_FOUND");
    assert.equal(body.entries, undefined);
    assert.equal(body.content, undefined);
  }
});

test("cyclic symlink paths return INVALID_PATH", async () => {
  const response = await fetch(filesystemUrl(path.join(fixture, "loop-link")), { headers });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { code: string }).code, "INVALID_PATH");
});

test("malformed URL escapes return a stable INVALID_PATH response", async () => {
  const response = await fetch(`${base}/filesystem/%E0%A4%A?stat=1`, { headers });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { code: string }).code, "INVALID_PATH");
});

test("unreadable directories return FORBIDDEN", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root can read mode-000 directories");
    return;
  }
  const forbidden = path.join(fixture, "forbidden");
  mkdirSync(forbidden);
  chmodSync(forbidden, 0o000);
  try {
    const response = await fetch(filesystemUrl(forbidden), { headers });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code: string }).code, "FORBIDDEN");
  } finally {
    chmodSync(forbidden, 0o700);
  }
});

test("mutation methods are unavailable", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(filesystemUrl(path.join(fixture, "alpha")), {
      method,
      headers,
      body: method === "DELETE" ? undefined : "data",
    });
    assert.equal(response.status, 404, `${method} must not be registered`);
  }
});
