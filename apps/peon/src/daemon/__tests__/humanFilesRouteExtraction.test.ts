import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import express from "express";
import { watch } from "node:fs";
import test from "node:test";

import type { FileAccessContract } from "../files/index.js";
import { attachHumanFilesystemRoutes } from "../http/human/files.js";

type Calls = {
  resolveWithinDir: number;
  workspaceRelativePath: number;
  listDirEntries: number;
  readFileView: number;
  dirErrorResponse: number;
  fileErrorResponse: number;
};

interface FileAccessHarness {
  calls: Calls;
  service: FileAccessContract;
}

function createFileAccessService(escapeSubpath = "escape-link"): FileAccessHarness {
  const calls: Calls = {
    resolveWithinDir: 0,
    workspaceRelativePath: 0,
    listDirEntries: 0,
    readFileView: 0,
    dirErrorResponse: 0,
    fileErrorResponse: 0,
  };

  return {
    calls,
    service: {
      resolveWithinDir(baseDir, subpath) {
        calls.resolveWithinDir += 1;
        if (subpath === escapeSubpath) return null;
        return path.join(baseDir, subpath);
      },
      resolveFromDir(baseDir, subpath) {
        return path.join(baseDir, subpath);
      },
      workspaceRelativePath(baseDir, absPath) {
        calls.workspaceRelativePath += 1;
        return path.relative(baseDir, absPath);
      },
      listDirEntries() {
        calls.listDirEntries += 1;
        return [{ name: "demo.txt", type: "file", size: 4, mtimeMs: 100 }];
      },
      readFileView() {
        calls.readFileView += 1;
        return {
          size: 4,
          mtimeMs: 100,
          binary: false,
          truncated: false,
          content: "demo",
        };
      },
      dirErrorResponse(error) {
        calls.dirErrorResponse += 1;
        return { status: 500, message: String((error as Error).message) };
      },
      fileErrorResponse(error) {
        calls.fileErrorResponse += 1;
        return { status: 500, message: String((error as Error).message) };
      },
    },
  };
}

async function startHarness(options: { watchDir?: typeof watch; service?: FileAccessContract } = {}): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  const fileAccessService = options.service ?? createFileAccessService().service;
  attachHumanFilesystemRoutes(app, { fileAccessService, watchDir: options.watchDir });

  const server = app.listen(0, "127.0.0.1");
  const base = await new Promise<string>((resolve, reject) => {
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected socket address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
    server.once("error", reject);
  });

  return {
    base,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test("human filesystem list and file routes use injected FileAccessContract methods", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "peon-human-files-extraction-"));
  const harness = createFileAccessService();
  const { base, close } = await startHarness({ service: harness.service });
  t.after(close);

  const listResponse = await fetch(`${base}/api/v1/fs?${new URLSearchParams({ root }).toString()}`);
  assert.equal(listResponse.status, 200);
  const list = (await listResponse.json()) as { path: string; entries: Array<{ name: string; type: string }> };
  assert.equal(list.path, "");
  assert.equal(list.entries.length, 1);

  const fileResponse = await fetch(`${base}/api/v1/fs/file?${new URLSearchParams({ root, path: "demo.txt" }).toString()}`);
  assert.equal(fileResponse.status, 200);
  const body = (await fileResponse.json()) as { path: string; content: string };
  assert.equal(body.path, "demo.txt");
  assert.equal(body.content, "demo");

  assert.equal(harness.calls.resolveWithinDir, 2);
  assert.equal(harness.calls.workspaceRelativePath, 2);
  assert.equal(harness.calls.listDirEntries, 1);
  assert.equal(harness.calls.readFileView, 1);
  assert.equal(harness.calls.dirErrorResponse, 0);
  assert.equal(harness.calls.fileErrorResponse, 0);
});

test("human filesystem file route keeps root-containment rejection through injected contract", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "peon-human-files-extraction-"));
  const harness = createFileAccessService("escape-link");
  const { base, close } = await startHarness({ service: harness.service });
  t.after(close);

  const traversal = await fetch(`${base}/api/v1/fs/file?${new URLSearchParams({ root, path: "escape-link" }).toString()}`);
  assert.equal(traversal.status, 400);
  assert.equal(((await traversal.json()) as { error: string }).error, "path escapes root directory");
  assert.equal(harness.calls.resolveWithinDir, 1);
  assert.equal(harness.calls.fileErrorResponse, 0);
});

test("human filesystem stream route preserves SSE snapshot behavior and closes watcher on abort", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "peon-human-files-extraction-"));
  const harness = createFileAccessService();
  let closed = false;
  let watchedPath: string | null = null;

  const watchDir: typeof watch = (watchPath, _onChange): ReturnType<typeof watch> => {
    watchedPath = watchPath;
    return {
      on: () => undefined,
      close: () => {
        closed = true;
      },
    } as ReturnType<typeof watch>;
  };

  const { base, close } = await startHarness({ service: harness.service, watchDir });
  t.after(close);

  const controller = new AbortController();
  const response = await fetch(`${base}/api/v1/fs/stream?${new URLSearchParams({ root }).toString()}`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");

  const reader = response.body?.getReader();
  assert(reader);
  const firstFrame = await Promise.race([
    reader.read(),
    wait(1000).then(() => {
      throw new Error("timed out waiting for SSE frame");
    }),
  ]);

  assert.equal(firstFrame.done, false);
  assert.ok(firstFrame.value !== undefined);
  const chunk = new TextDecoder().decode(firstFrame.value);
  assert.equal(chunk.includes("event: files"), true);

  controller.abort();
  await wait(25);

  assert.equal(closed, true);
  assert.equal(watchedPath, root);
});
