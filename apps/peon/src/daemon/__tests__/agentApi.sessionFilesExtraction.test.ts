import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { type Server } from "node:http";
import test from "node:test";
import type { FileAccessContract } from "../files/index.js";
import {
  attachFleetSessionFileRoutes,
  type FleetSessionFileWatch,
} from "../http/fleet/sessionFiles.js";
import type { SessionCatalogReader, SessionTranscriptEventContract, SessionRecord } from "../sessions/index.js";

type SessionFilesService = Pick<SessionCatalogReader, "get"> & Pick<SessionTranscriptEventContract, "preview">;

interface SessionFileRouteHarness {
  base: string;
  close: () => Promise<void>;
}

function makeSessionRecord(id: string, dir: string): SessionRecord {
  return {
    id,
    prompt: "prompt",
    title: null,
    followUpPrompts: [],
    queuedFollowUps: [],
    pendingSystemPrompts: [],
    dir,
    agent: "claude-code",
    backendSessionId: null,
    backendTurnId: null,
    backendRuntimeGeneration: null,
    backendTurnStatus: "completed",
    model: null,
    reasoningEffort: null,
    projectId: null,
    projectKey: null,
    candidateProjectKeys: [],
    taskKey: null,
    taskTitle: null,
    initiator: null,
    parentSessionId: null,
    spawnDepth: 0,
    spawnRequestId: null,
    author: null,
    status: "completed",
    outcome: null,
    startedAt: 1,
    endedAt: 2,
    turnCount: 0,
    turnBudget: 0,
    usage: null,
    usageByModel: {},
    autoResumeAttempts: 0,
    lastActivityAt: 1,
    lastUserMessageAt: 1,
    lastMessagePreview: null,
    eventCount: 0,
  } as SessionRecord;
}

async function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<string | null> {
  const readResult = await Promise.race([
    reader.read(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (readResult === null || readResult.done) return null;
  return new TextDecoder().decode(readResult.value);
}

async function createSessionFileHarness(
  sessionFiles: SessionFilesService,
  fileAccessService: FileAccessContract,
  watch?: FleetSessionFileWatch,
): Promise<SessionFileRouteHarness> {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", (req, _res, next) => {
    const actorHeader = req.headers["peon-actor"];
    (req as express.Request & { actor?: string | null }).actor = typeof actorHeader === "string" ? actorHeader : null;
    next();
  });
  const router = express.Router();
  attachFleetSessionFileRoutes(router, {
    fileAccessService,
    sessionFiles,
    watch,
  });
  app.use("/api/v1", router);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}/api/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function createFileAccessService(spy: {
  resolveFromDir: (baseDir: string, subpath: string) => string;
  workspaceRelativePath?: (baseDir: string, absPath: string) => string;
  listDirEntries?: () => unknown[];
  readFileView?: () => { size: number; mtimeMs: number; binary: boolean; truncated: boolean; content: string | null; };
}): FileAccessContract {
  return {
    resolveFromDir: spy.resolveFromDir,
    resolveWithinDir: () => null,
    workspaceRelativePath: spy.workspaceRelativePath ?? (() => ""),
    listDirEntries: spy.listDirEntries ?? (() => []),
    readFileView: spy.readFileView ?? (() => ({ size: 0, mtimeMs: 0, binary: false, truncated: false, content: null })),
    dirErrorResponse: () => ({ status: 500, message: "dir error" }),
    fileErrorResponse: () => ({ status: 500, message: "file error" }),
  };
}

test("session file routes use injected session and file service dependencies", async () => {
  const calls = {
    get: 0,
    resolveFromDir: 0,
    listDirEntries: 0,
    readFileView: 0,
  };

  const record = makeSessionRecord("session-1", "/tmp/session-work");
  const sessionFiles: SessionFilesService = {
    get: (id) => {
      calls.get++;
      if (id === record.id) return record;
      return undefined;
    },
    preview: () => ({ type: "preview", name: "no-op.txt" }),
  };
  const fileAccessService = createFileAccessService({
    resolveFromDir: (baseDir, subpath) => {
      calls.resolveFromDir++;
      return path.join(baseDir, subpath);
    },
    listDirEntries: () => {
      calls.listDirEntries++;
      return [{ name: "foo.txt", type: "file", size: 4, mtimeMs: 1 }];
    },
    readFileView: () => {
      calls.readFileView++;
      return { size: 0, mtimeMs: 1, binary: false, truncated: false, content: "" };
    },
  });

  const harness = await createSessionFileHarness(sessionFiles, fileAccessService);
  const response = await fetch(`${harness.base}/sessions/session-1/files?path=artifacts`);
  const file = await fetch(`${harness.base}/sessions/session-1/file?path=readme.txt`);
  const miss = await fetch(`${harness.base}/sessions/missing/file?path=readme.txt`);

  assert.equal(response.status, 200);
  assert.equal(file.status, 200);
  assert.equal(miss.status, 404);
  assert.deepEqual(await miss.json(), { error: "unknown session", code: "UNKNOWN_SESSION" });
  assert.equal(calls.get, 3);
  assert.equal(calls.resolveFromDir, 2);
  assert.equal(calls.listDirEntries, 1);
  assert.equal(calls.readFileView, 1);

  await harness.close();
});

test("session file raw endpoint returns exact preview MIME and security headers", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "peon-session-file-raw-"));
  const pngPath = path.join(workspace, "preview.png");
  writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const record = makeSessionRecord("session-raw", workspace);
  const sessionFiles: SessionFilesService = {
    get: (id) => (id === record.id ? record : undefined),
    preview: () => undefined,
  };
  const fileAccessService = createFileAccessService({
    resolveFromDir: (_baseDir, subpath) => path.join(workspace, subpath),
    listDirEntries: () => [],
  });

  const harness = await createSessionFileHarness(sessionFiles, fileAccessService);
  const response = await fetch(`${harness.base}/sessions/session-raw/file/raw?path=preview.png`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "no-store");
  await harness.close();
});

test("preview route preserves actor and returns 201 status", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "peon-session-file-preview-"));
  const targetPath = path.join(workspace, "artifact.txt");
  writeFileSync(targetPath, "hello");

  const actor = "alice@example.com";
  const record = makeSessionRecord("session-preview", workspace);
  let previewActor: string | null = null;
  const sessionFiles: SessionFilesService = {
    get: (id) => (id === record.id ? record : undefined),
    preview: (_id, _filePath, author) => {
      previewActor = author ?? null;
      return { type: "preview", name: "artifact.txt", author };
    },
  };
  const fileAccessService = createFileAccessService({
    resolveFromDir: (_baseDir, subpath) => path.join(workspace, subpath),
  });

  const harness = await createSessionFileHarness(sessionFiles, fileAccessService);
  const response = await fetch(`${harness.base}/sessions/session-preview/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Peon-Actor": actor },
    body: JSON.stringify({ path: "artifact.txt" }),
  });

  const body = await response.json() as { event?: { author?: string; name?: string; type?: string } };
  assert.equal(response.status, 201);
  assert.equal(previewActor, actor);
  assert.equal(body.event?.name, "artifact.txt");

  await harness.close();
});

test("missing path returns a stable BAD_REQUEST envelope", async () => {
  const record = makeSessionRecord("session-path", "/tmp");
  const sessionFiles: SessionFilesService = {
    get: (id) => (id === record.id ? record : undefined),
    preview: () => ({ type: "preview", name: "noop.txt" }),
  };
  const fileAccessService = createFileAccessService({
    resolveFromDir: (baseDir, subpath) => path.join(baseDir, subpath),
  });

  const harness = await createSessionFileHarness(sessionFiles, fileAccessService);
  const missingFilePath = await fetch(`${harness.base}/sessions/session-path/file`);
  const missingRaw = await fetch(`${harness.base}/sessions/session-path/file/raw`);
  const missingPreview = await fetch(`${harness.base}/sessions/session-path/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  assert.equal(missingFilePath.status, 400);
  assert.deepEqual(await missingFilePath.json(), { error: "path is required", code: "BAD_REQUEST" });
  assert.equal(missingRaw.status, 400);
  assert.deepEqual(await missingRaw.json(), { error: "path is required", code: "BAD_REQUEST" });
  assert.equal(missingPreview.status, 400);
  assert.deepEqual(await missingPreview.json(), { error: "path is required", code: "BAD_REQUEST" });
  await harness.close();
});

test("session file stream coalesces change events and closes the watcher cleanly", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "peon-session-file-stream-"));
  const targetPath = path.join(workspace, "artifact.txt");
  writeFileSync(targetPath, "payload");

  const record = makeSessionRecord("session-stream", workspace);
  const sessionFiles: SessionFilesService = {
    get: (id) => (id === record.id ? record : undefined),
    preview: () => ({ type: "preview", name: "artifact.txt" }),
  };

  let watcherCloseCount = 0;
  let watcherHandler: ((eventType: "rename" | "change", filename: string | Buffer | null) => void) | null = null;
  const fakeWatch: FleetSessionFileWatch = (_filename, handler) => {
    watcherHandler = handler;
    Promise.resolve().then(() => handler("change", "artifact.txt"));
    return {
      close: () => {
        watcherCloseCount += 1;
      },
    };
  };

  const fileAccessService = createFileAccessService({
    resolveFromDir: (_baseDir, subpath) => path.join(workspace, subpath),
  });

  const harness = await createSessionFileHarness(sessionFiles, fileAccessService, fakeWatch);
  const controller = new AbortController();
  const response = await fetch(`${harness.base}/sessions/session-stream/file/stream?path=artifact.txt`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  try {
    assert.ok(watcherHandler !== null, "stream route should initialize the watch callback");

    const initialChunk = await readSseChunk(reader, 500);
    assert.ok(initialChunk);
    assert.match(initialChunk, /event: changed/);
    assert.match(initialChunk, /\"path\":\"artifact.txt\"/);

    watcherHandler("change", "other.txt");
    watcherHandler("change", "artifact.txt");
    watcherHandler("change", "artifact.txt");
    const chunk = await readSseChunk(reader, 500);
    assert.ok(chunk);
    assert.match(chunk, /event: changed/);
    assert.match(chunk, /\"path\":\"artifact.txt\"/);
    assert.equal((chunk.match(/event: changed/g) ?? []).length, 1);
  } finally {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(watcherCloseCount, 1);
    await harness.close();
  }
});
