import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-project-files-extraction-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-project-files-extraction-state-"));

const TOKEN = `pn_fleet_project_files_${randomUUID()}`;

const { settings } = await import("../settings/index.js");
const { createAgentRouter } = await import("../agentApi.js");

settings.update({ overseerToken: TOKEN, paused: false });

const projectDir = path.join(mkdtempRoot(), "project");
const projectKey = "extracted-project";
let lookupCount = 0;
const projectReader = {
  get: (key: string) => {
    lookupCount += 1;
    if (key === projectKey) return { dir: projectDir };
    return undefined;
  },
};
mkdirSync(projectDir, { recursive: true });

const resolveCalls: { resolveWithinDir: number; workspaceRelativePath: number; listDirEntries: number } = {
  resolveWithinDir: 0,
  workspaceRelativePath: 0,
  listDirEntries: 0,
};
const fileAccessService = {
  resolveWithinDir: (baseDir: string, subpath: string) => {
    resolveCalls.resolveWithinDir += 1;
    return path.join(baseDir, subpath);
  },
  workspaceRelativePath: (baseDir: string, absPath: string) => {
    resolveCalls.workspaceRelativePath += 1;
    return path.relative(baseDir, absPath);
  },
  listDirEntries: () => {
    resolveCalls.listDirEntries += 1;
    return [];
  },
  readFileView: () => {
    throw new Error("readFileView not used in this test");
  },
  dirErrorResponse: () => ({ status: 500, message: "dir error" }),
  fileErrorResponse: () => ({ status: 500, message: "file error" }),
};

const app = express();
app.use(express.json());
app.use("/api/v1", createAgentRouter({ projectFileReader: projectReader, fileAccessService }));

const api: Server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => api.once("listening", () => resolve()));
const address = api.address();
assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}/api/v1`;

test.after(async () => {
  api.closeAllConnections();
  await new Promise<void>((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
});

function authed(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
}

function upload(p: string, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  return authed(p, {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/octet-stream", ...headers },
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
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    drive(req);
  });
}

function mkdtempRoot(): string {
  const marker = mkdtempSync(path.join(os.tmpdir(), "peon-test-project-extracted-"));
  return marker;
}

test("extracts project-file routes through injected project reader and file access contract", async () => {
  lookupCount = 0;
  resolveCalls.resolveWithinDir = 0;
  resolveCalls.workspaceRelativePath = 0;
  resolveCalls.listDirEntries = 0;
  const response = await authed(`/projects/${projectKey}/files?stat=1`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { path: string; entries: unknown[] };
  assert.equal(payload.path, "");
  assert.equal(payload.entries.length, 0);
  assert.equal(lookupCount, 1);
  assert.equal(resolveCalls.resolveWithinDir, 1);
  assert.equal(resolveCalls.workspaceRelativePath, 1);
  assert.equal(resolveCalls.listDirEntries, 1);
});

test("unknown project path still returns UNKNOWN_PROJECT", async () => {
  const response = await authed(`/projects/missing/files?stat=1`);
  assert.equal(response.status, 404);
  const payload = (await response.json()) as { code: string };
  assert.equal(payload.code, "UNKNOWN_PROJECT");
});

test("malformed project URL is rejected by the file-route middleware", async () => {
  const response = await authed(`/projects/${projectKey}/files/%E0%A4`);
  assert.equal(response.status, 400);
  const body = (await response.json()) as { code: string };
  assert.equal(body.code, "INVALID_PATH");
});

test("checksum mismatch does not replace destination or leak temp files", async () => {
  const destination = "checksum.txt";
  const destinationPath = path.join(projectDir, destination);
  writeFileSync(destinationPath, "expected");
  const mismatch = await upload(`/projects/${projectKey}/files/${destination}`, "replacement", {
    "Peon-Content-Sha256": "0".repeat(64),
  });
  assert.equal(mismatch.status, 409);
  const payload = (await mismatch.json()) as { code: string };
  assert.equal(payload.code, "CHECKSUM_MISMATCH");
  assert.equal(readFileSync(destinationPath, "utf8"), "expected");
  assert.equal(readdirSync(projectDir).filter((name) => name.includes(".peon-upload-")).length, 0);
});

test("upload remains atomic when a large upload is in progress", async () => {
  const destination = "atomic.txt";
  const destinationPath = path.join(projectDir, destination);
  const oldBody = "old-body";
  const newBody = "new-body-content";
  writeFileSync(destinationPath, oldBody);

  let started!: () => void;
  const firstHalfSent = new Promise<void>((resolve) => {
    started = resolve;
  });
  let continueUpload!: () => void;
  const continueAfterFirstHalf = new Promise<void>((resolve) => {
    continueUpload = () => resolve();
  });
  const requestDone = rawUpload(`/projects/${projectKey}/files/${destination}`, Buffer.byteLength(newBody), (req) => {
    req.write(newBody.slice(0, 4));
    started();
    continueAfterFirstHalf.then(() => req.write(newBody.slice(4))).then(() => req.end());
  });

  await firstHalfSent;
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(readFileSync(destinationPath, "utf8"), oldBody);
  continueUpload();
  const result = await requestDone;
  assert.equal(result.status, 201);
  assert.equal(readFileSync(destinationPath, "utf8"), newBody);
});

test("move and delete operations remain scoped to the injected project", async () => {
  const sourceName = "move-source.txt";
  const destinationName = "move-destination.txt";
  const sourcePath = path.join(projectDir, sourceName);
  const destinationPath = path.join(projectDir, destinationName);
  writeFileSync(sourcePath, "to-be-moved");

  const moveResponse = await authed(`/projects/${projectKey}/files/${sourceName}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destination: destinationName }),
  });
  assert.equal(moveResponse.status, 200);
  const moveBody = await moveResponse.json() as { path: string };
  assert.equal(moveBody.path, destinationName);
  assert.equal(readFileSync(destinationPath, "utf8"), "to-be-moved");
  assert.equal(readdirSync(projectDir).includes(sourceName), false);

  const deleteResponse = await authed(`/projects/${projectKey}/files/${destinationName}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 200);
  const deleteBody = await deleteResponse.json() as { path: string; size: number };
  assert.equal(deleteBody.path, destinationName);
  assert.equal(readdirSync(projectDir).includes(destinationName), false);
});
