import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import express from "express";
import type { Server } from "node:http";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-test-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-test-state-"));

const { settings } = await import("../settings/index.js");
const { updateChecker } = await import("../updateChecker.js");
const { createAgentRouter } = await import("../agentApi.js");

const token = "status-test-token";
const currentVersion = (JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { version: string }).version;
settings.update({ overseerToken: token });

const fakeGitDir = mkdtempSync(path.join(os.tmpdir(), "peon-fake-git-"));
const fakeGit = path.join(fakeGitDir, "git");
const checkCountFile = path.join(fakeGitDir, "check-count");
const localSha = "1111111111111111111111111111111111111111";
const firstRemoteSha = "2222222222222222222222222222222222222222";
const secondRemoteSha = "3333333333333333333333333333333333333333";
writeFileSync(fakeGit, `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' "${localSha}"
  exit 0
fi
if [ "$1" = "ls-remote" ]; then
  printf x >> "$PEON_TEST_UPDATE_COUNT_FILE"
  sleep 0.05
  if [ "$PEON_TEST_UPDATE_ERROR" = "1" ]; then
    printf '%s\\n' 'simulated update check failure' >&2
    exit 7
  fi
  printf '%s\\tHEAD\\n' "$PEON_TEST_REMOTE_SHA"
  exit 0
fi
if [ "$1" = "-C" ]; then
  exit 1
fi
exit 2
`);
chmodSync(fakeGit, 0o755);
writeFileSync(checkCountFile, "");

const originalPath = process.env.PATH;
process.env.PATH = `${fakeGitDir}${path.delimiter}${originalPath ?? ""}`;
process.env.PEON_TEST_UPDATE_COUNT_FILE = checkCountFile;
process.env.PEON_TEST_REMOTE_SHA = firstRemoteSha;

const app = express();
app.use(express.json());
app.use("/api/v1", createAgentRouter());
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;

test.after(() => {
  server.close();
  process.env.PATH = originalPath;
  delete process.env.PEON_TEST_UPDATE_COUNT_FILE;
  delete process.env.PEON_TEST_REMOTE_SHA;
  delete process.env.PEON_TEST_UPDATE_ERROR;
});

test("GET /api/v1/status exposes update checker state", async () => {
  const expected = updateChecker.getState();
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.updateAvailable, expected.updateAvailable);
  assert.equal(body.updateCurrentVersion, expected.currentVersion);
  assert.equal(body.updateLatestVersion, expected.latestVersion);
  assert.equal(body.updateCurrentRevision, expected.currentRevision);
  assert.equal(body.updateLatestRevision, expected.latestRevision);
  assert.equal(body.updateCheckedAt, expected.checkedAt);
  assert.equal(body.updateCheckError, expected.error);
});

test("POST /api/v1/control/check-update requires fleet authentication and protocol compatibility", async () => {
  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/v1/control/check-update`, {
    method: "POST",
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(((await unauthenticated.json()) as { code: string }).code, "UNAUTHENTICATED");

  const unsupported = await fetch(`http://127.0.0.1:${port}/api/v1/control/check-update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "2" },
  });
  assert.equal(unsupported.status, 400);
  assert.equal(((await unsupported.json()) as { code: string }).code, "UNSUPPORTED_PROTOCOL");
});

test("POST /api/v1/control/check-update runs a fresh check and returns update status", async () => {
  const previousCheckedAt = updateChecker.getState().checkedAt;
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/control/check-update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });

  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["code", "result", "status"]);
  assert.equal(body.status, "available");
  assert.equal(body.code, "OK");
  const result = body.result as Record<string, unknown>;
  assert.equal(result.updateAvailable, true);
  assert.equal(result.currentVersion, currentVersion);
  assert.equal(result.latestVersion, null);
  assert.equal(result.currentRevision, localSha);
  assert.equal(result.latestRevision, firstRemoteSha);
  assert.equal(result.checkError, null);
  assert.equal(typeof result.checkedAt, "number");
  if (previousCheckedAt !== null) assert.ok((result.checkedAt as number) > previousCheckedAt);
});

test("concurrent manual update requests admit one check and reject the competing operation", async () => {
  writeFileSync(checkCountFile, "");
  process.env.PEON_TEST_REMOTE_SHA = secondRemoteSha;
  const before = updateChecker.getState().checkedAt as number;
  const headers = { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" };

  const [first, second] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/v1/control/check-update`, { method: "POST", headers }),
    fetch(`http://127.0.0.1:${port}/api/v1/control/check-update`, { method: "POST", headers }),
  ]);
  const [firstBody, secondBody] = await Promise.all([
    first.json() as Promise<Record<string, unknown>>,
    second.json() as Promise<Record<string, unknown>>,
  ]);

  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(readFileSync(checkCountFile, "utf8"), "x");
  const success = first.status === 200 ? firstBody : secondBody;
  const conflict = first.status === 409 ? firstBody : secondBody;
  const result = success.result as Record<string, unknown>;
  assert.equal(result.latestRevision, secondRemoteSha);
  assert.ok((result.checkedAt as number) > before);
  assert.equal(conflict.code, "UPDATE_IN_PROGRESS");
});

test("manual update-check failures return a bounded registry error without crashing the API", async () => {
  process.env.PEON_TEST_UPDATE_ERROR = "1";
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/control/check-update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });
  delete process.env.PEON_TEST_UPDATE_ERROR;

  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["code", "error"]);
  assert.equal(body.code, "REGISTRY_UNAVAILABLE");
  assert.equal(body.error, "release registry is unavailable");
});

test("GET /api/v1/status remains cache-only", async () => {
  writeFileSync(checkCountFile, "");
  const expected = { ...updateChecker.getState() };
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(readFileSync(checkCountFile, "utf8"), "");
  assert.equal(body.updateCheckedAt, expected.checkedAt);
  assert.equal(body.updateCheckError, expected.error);
});
