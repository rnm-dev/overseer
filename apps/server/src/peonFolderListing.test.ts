import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import WebSocket from "ws";
import { bindPeon, mintCredential } from "./credentials.js";
import { initDb, query } from "./db.js";
import {
  createFolderListingOperations,
  FOLDER_LISTING_ENTRY_METADATA_FEATURE,
} from "./peonFolderListing.js";
import { getPeonConnection, peonConnectionSupports } from "./peonConnections.js";
import { PeonOperationError } from "./peonOperationChannel.js";
import { attachPeonSocket } from "./peonSocket.js";
import { registry } from "./registry.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function open(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function collector(ws: WebSocket) {
  const frames: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  ws.on("message", (data) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    for (const waiter of waiters) waiter();
  });
  const next = (predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 2_000) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const inspect = () => {
      const index = frames.findIndex(predicate);
      if (index < 0) return;
      clearTimeout(timeout);
      waiters.delete(inspect);
      resolve(frames.splice(index, 1)[0]!);
    };
    const timeout = setTimeout(() => {
      waiters.delete(inspect);
      reject(new Error(`timed out waiting for frame; received ${JSON.stringify(frames)}`));
    }, timeoutMs);
    waiters.add(inspect);
    inspect();
  });
  return { frames, next };
}

async function fixture(suffix: string, timeoutMs = 500) {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);
  const workspaceId = `folder-workspace-${suffix}`;
  const peonId = `folder-peon-${suffix}`;
  await query(`INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ($1,'Folder',$2,'owner',$3)`, [workspaceId, `folder-${suffix}`, Date.now()]);
  const { credential, token } = await mintCredential(workspaceId, "Folder Peon", "owner");
  assert.equal(await bindPeon(credential.id, peonId), true);
  await registry.register({
    peonId, credentialId: credential.id, workspaceId, name: "Folder Peon", hostname: null,
    address: "127.0.0.1", controlPort: 4570, publicUrl: null, protocol: 1, capabilities: [], token, load: null,
  });
  let nextId = 0;
  const operations = createFolderListingOperations({ timeoutMs, id: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}` });
  const server = http.createServer();
  const wss = attachPeonSocket(server, { folderOperations: operations });
  const port = await listen(server);
  const ws = await open(`ws://127.0.0.1:${port}/api/v1/peons/ws`, token);
  const received = collector(ws);
  return { peonId, token, operations, server, wss, ws, received, url: `ws://127.0.0.1:${port}/api/v1/peons/ws` };
}

async function hello(
  ws: WebSocket,
  received: ReturnType<typeof collector>,
  peonId: string,
  capabilities = ["folder-listing-v1"],
  channels?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  ws.send(JSON.stringify({ type: "hello", protocol: 1, peonId, capabilities, ...(channels ? { channels } : {}) }));
  return received.next((frame) => frame.type === "hello_ack");
}

async function shutdown(value: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  value.ws.terminate();
  await new Promise<void>((resolve) => value.wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => value.server.close((error) => error ? reject(error) : resolve()));
}

test("negotiates folder listing independently and accumulates correlated pages in Peon order", async () => {
  const f = await fixture("pages");
  try {
    assert.deepEqual(await hello(f.ws, f.received, f.peonId, ["folder-listing-v1"], {
      "folder-listing-v1": { entryMetadata: "entry-metadata-v1" },
    }), {
      type: "hello_ack",
      protocol: 1,
      capabilities: ["folder-listing-v1"],
      channels: { "folder-listing-v1": { entryMetadata: "entry-metadata-v1" } },
    });
    const connection = getPeonConnection(f.peonId);
    assert.ok(connection);
    assert.equal(peonConnectionSupports(connection, FOLDER_LISTING_ENTRY_METADATA_FEATURE), true);
    const result = f.operations.request(f.peonId, { path: "/srv/work", projectId: "ignored", limit: 999 });
    const first = await f.received.next((frame) => frame.type === "folder_list_request");
    assert.equal(first.path, "/srv/work");
    assert.equal(first.projectId, "ignored");
    assert.equal(first.limit, 500);
    f.ws.send(JSON.stringify({
      type: "folder_list_page", requestId: first.requestId, path: "/srv/work", projectId: null,
      entries: [
        { name: "z-dir", type: "directory", size: null, mtimeMs: 101 },
        { name: ".hidden", type: "file", size: 6, mtimeMs: 102 },
        { name: "outside-link", type: "other", size: null, mtimeMs: null },
      ],
      nextCursor: "opaque-1", hasMore: true,
    }));
    const next = await f.received.next((frame) => frame.type === "folder_list_request" && frame.cursor === "opaque-1");
    assert.deepEqual(next, { type: "folder_list_request", requestId: first.requestId, cursor: "opaque-1", limit: 500 });
    f.ws.send(JSON.stringify({
      type: "folder_list_page", requestId: first.requestId, path: "/srv/work", projectId: null,
      entries: [{ name: "a.txt", type: "file", size: 12, mtimeMs: 103 }], nextCursor: null, hasMore: false,
    }));
    assert.deepEqual(await result, {
      path: "/srv/work", projectId: null,
      entries: [
        { name: "z-dir", type: "directory", size: null, mtimeMs: 101 },
        { name: ".hidden", type: "file", size: 6, mtimeMs: 102 },
        { name: "outside-link", type: "other", size: null, mtimeMs: null },
        { name: "a.txt", type: "file", size: 12, mtimeMs: 103 },
      ],
    });
    assert.equal(f.received.frames.some((frame) => frame.type === "durable_message"), false);

    const projectResult = f.operations.request(f.peonId, { projectId: "stable-project" });
    const projectRequest = await f.received.next((frame) => frame.type === "folder_list_request");
    assert.equal(projectRequest.projectId, "stable-project");
    assert.equal("path" in projectRequest, false);
    f.ws.send(JSON.stringify({
      type: "folder_list_page", requestId: projectRequest.requestId, path: "/projects/stable", projectId: "stable-project",
      entries: [], nextCursor: null, hasMore: false,
    }));
    assert.deepEqual(await projectResult, { path: "/projects/stable", projectId: "stable-project", entries: [] });

    const nestedResult = f.operations.request(f.peonId, { projectId: "stable-project", relativePath: "src/lib" });
    const nestedRequest = await f.received.next((frame) => frame.type === "folder_list_request");
    assert.equal(nestedRequest.projectId, "stable-project");
    assert.equal(nestedRequest.relativePath, "src/lib");
    f.ws.send(JSON.stringify({
      type: "folder_list_page", requestId: nestedRequest.requestId, path: "/projects/stable/src/lib", projectId: "stable-project",
      entries: [{ name: "index.ts", type: "file" }], nextCursor: null, hasMore: false,
    }));
    assert.deepEqual(await nestedResult, {
      path: "/projects/stable/src/lib",
      projectId: "stable-project",
      entries: [{ name: "index.ts", type: "file", size: null, mtimeMs: null }],
    });

    await assert.rejects(f.operations.request(f.peonId, { path: "relative/path" }),
      (error: unknown) => error instanceof PeonOperationError && error.code === "INVALID_PATH");
    const injectedFrameFields = { path: "/tmp", type: "durable_message", requestId: "attacker-controlled" };
    await assert.rejects(f.operations.request(f.peonId, injectedFrameFields),
      (error: unknown) => error instanceof PeonOperationError && error.code === "BAD_REQUEST");
    await assert.rejects(f.operations.request(f.peonId, { path: "/tmp", projectId: 42 } as unknown as { path: string }),
      (error: unknown) => error instanceof PeonOperationError && error.code === "BAD_REQUEST");
    await assert.rejects(f.operations.request(f.peonId, { projectId: "stable-project", relativePath: "/absolute" }),
      (error: unknown) => error instanceof PeonOperationError && error.code === "INVALID_PATH");
    assert.equal(f.received.frames.some((frame) => frame.type === "durable_message" || frame.requestId === "attacker-controlled"), false);

    const closed = new Promise<number>((resolve) => f.ws.once("close", resolve));
    f.ws.send(JSON.stringify({
      type: "folder_list_page", requestId: projectRequest.requestId, path: "/projects/stable", projectId: "stable-project",
      entries: [], nextCursor: null, hasMore: false,
    }));
    assert.equal(await closed, 1002);
  } finally {
    await shutdown(f);
  }
});

test("preserves Peon errors and releases concurrency on abort and timeout", async () => {
  const f = await fixture("lifecycle", 30);
  try {
    await hello(f.ws, f.received, f.peonId);
    const errored = f.operations.request(f.peonId, { projectId: "missing" });
    const errorRequest = await f.received.next((frame) => frame.type === "folder_list_request");
    f.ws.send(JSON.stringify({ type: "folder_list_error", requestId: errorRequest.requestId, code: "UNKNOWN_PROJECT", error: "project was removed" }));
    await assert.rejects(errored, (error: unknown) => error instanceof PeonOperationError
      && error.code === "UNKNOWN_PROJECT" && error.message === "project was removed" && error.status === 404);

    const unsupported = f.operations.request(f.peonId, { path: "/tmp" });
    const unsupportedRequest = await f.received.next((frame) => frame.type === "folder_list_request");
    f.ws.send(JSON.stringify({
      type: "folder_list_error",
      requestId: unsupportedRequest.requestId,
      code: "UNSUPPORTED_PLATFORM",
      error: "secure handle-relative folder listing is unavailable on this platform",
    }));
    await assert.rejects(unsupported, (error: unknown) => error instanceof PeonOperationError
      && error.code === "UNSUPPORTED_PLATFORM" && error.status === 501);

    const controller = new AbortController();
    const cancelled = f.operations.request(f.peonId, { path: "/tmp" }, controller.signal);
    const cancelRequest = await f.received.next((frame) => frame.type === "folder_list_request");
    await assert.rejects(f.operations.request(f.peonId, { path: "/tmp/second" }),
      (error: unknown) => error instanceof PeonOperationError && error.code === "SYNC_IN_PROGRESS");
    controller.abort();
    await assert.rejects(cancelled, (error: unknown) => error instanceof PeonOperationError && error.code === "CANCELLED");
    assert.deepEqual(await f.received.next((frame) => frame.type === "folder_list_cancel"), { type: "folder_list_cancel", requestId: cancelRequest.requestId });
    f.ws.send(JSON.stringify({ type: "folder_list_cancelled", requestId: cancelRequest.requestId }));

    const timedOut = f.operations.request(f.peonId, { path: "/slow" });
    const timedOutRejection = assert.rejects(timedOut,
      (error: unknown) => error instanceof PeonOperationError && error.code === "TIMEOUT");
    const timeoutRequest = await f.received.next((frame) => frame.type === "folder_list_request");
    assert.deepEqual(await f.received.next((frame) => frame.type === "folder_list_cancel", 1_000), { type: "folder_list_cancel", requestId: timeoutRequest.requestId });
    await timedOutRejection;
    assert.equal(f.ws.readyState, WebSocket.OPEN);
  } finally {
    await shutdown(f);
  }
});

test("rejects protocol drift and local row bounds without leaking request state", async () => {
  const f = await fixture("bounds");
  try {
    await hello(f.ws, f.received, f.peonId);
    const inconsistent = f.operations.request(f.peonId, { projectId: "project" });
    const request = await f.received.next((frame) => frame.type === "folder_list_request");
    f.ws.send(JSON.stringify({
      type: "folder_list_page", requestId: request.requestId, path: "/one", projectId: "project",
      entries: [], nextCursor: "next", hasMore: true,
    }));
    await f.received.next((frame) => frame.type === "folder_list_request" && frame.cursor === "next");
    f.ws.send(JSON.stringify({
      type: "folder_list_page", requestId: request.requestId, path: "/two", projectId: "project",
      entries: [], nextCursor: null, hasMore: false,
    }));
    await assert.rejects(inconsistent, (error: unknown) => error instanceof PeonOperationError && error.code === "PROTOCOL_ERROR");
    assert.equal((await f.received.next((frame) => frame.type === "folder_list_cancel")).requestId, request.requestId);

    const malformed = f.operations.request(f.peonId, { path: "/malformed" });
    const malformedRequest = await f.received.next((frame) => frame.type === "folder_list_request");
    f.ws.send(JSON.stringify({
      type: "folder_list_error", requestId: malformedRequest.requestId, code: "NOT_FOUND", error: "missing", detail: "not part of v1",
    }));
    await assert.rejects(malformed, (error: unknown) => error instanceof PeonOperationError && error.code === "PROTOCOL_ERROR");
    assert.equal((await f.received.next((frame) => frame.type === "folder_list_cancel")).requestId, malformedRequest.requestId);

    const oversizedPage = f.operations.request(f.peonId, { path: "/large-page" });
    const oversizedPageRequest = await f.received.next((frame) => frame.type === "folder_list_request");
    const wideEntries = Array.from({ length: 270 }, (_, index) => ({ name: `${index}-${"x".repeat(3_500)}`, type: "file" }));
    f.ws.send(JSON.stringify({
      type: "folder_list_page", requestId: oversizedPageRequest.requestId, path: "/large-page", projectId: null,
      entries: wideEntries, nextCursor: null, hasMore: false,
    }));
    await assert.rejects(oversizedPage, (error: unknown) => error instanceof PeonOperationError && error.code === "PROTOCOL_ERROR");
    assert.equal((await f.received.next((frame) => frame.type === "folder_list_cancel")).requestId, oversizedPageRequest.requestId);

    const oversized = f.operations.request(f.peonId, { path: "/many" });
    const oversizedRequest = await f.received.next((frame) => frame.type === "folder_list_request");
    const entries = Array.from({ length: 20_001 }, (_, index) => ({ name: `f${index}`, type: "file" }));
    f.ws.send(JSON.stringify({
      type: "folder_list_page", requestId: oversizedRequest.requestId, path: "/many", projectId: null,
      entries, nextCursor: null, hasMore: false,
    }));
    await assert.rejects(oversized, (error: unknown) => error instanceof PeonOperationError && error.code === "LISTING_TOO_LARGE");
    assert.equal((await f.received.next((frame) => frame.type === "folder_list_cancel")).requestId, oversizedRequest.requestId);
  } finally {
    await shutdown(f);
  }
});

test("older Peons are capability-fenced and disconnects settle only their own generation", async () => {
  const f = await fixture("compatibility");
  try {
    await assert.rejects(f.operations.request(f.peonId, { path: "/tmp" }),
      (error: unknown) => error instanceof PeonOperationError && error.code === "PEON_OFFLINE");
    assert.deepEqual(await hello(f.ws, f.received, f.peonId, []), { type: "hello_ack", protocol: 1, capabilities: [] });
    const legacyConnection = getPeonConnection(f.peonId);
    assert.ok(legacyConnection);
    assert.equal(peonConnectionSupports(legacyConnection, FOLDER_LISTING_ENTRY_METADATA_FEATURE), false);
    await assert.rejects(f.operations.request(f.peonId, { path: "/tmp" }),
      (error: unknown) => error instanceof PeonOperationError && error.code === "UNSUPPORTED_CAPABILITY");

    f.ws.terminate();
    const replacement = await open(f.url, f.token);
    const replacementFrames = collector(replacement);
    await hello(replacement, replacementFrames, f.peonId);
    const pending = f.operations.request(f.peonId, { path: "/tmp" });
    const request = await replacementFrames.next((frame) => frame.type === "folder_list_request");
    replacement.terminate();
    await assert.rejects(pending, (error: unknown) => error instanceof PeonOperationError && error.code === "CONNECTION_LOST");

    const newest = await open(f.url, f.token);
    const newestFrames = collector(newest);
    await hello(newest, newestFrames, f.peonId);
    const retried = f.operations.request(f.peonId, { path: "/tmp" });
    const retryRequest = await newestFrames.next((frame) => frame.type === "folder_list_request");
    assert.notEqual(retryRequest.requestId, request.requestId);
    newest.send(JSON.stringify({
      type: "folder_list_page", requestId: retryRequest.requestId, path: "/tmp", projectId: null,
      entries: [], nextCursor: null, hasMore: false,
    }));
    assert.deepEqual(await retried, { path: "/tmp", projectId: null, entries: [] });
    newest.terminate();
  } finally {
    await shutdown(f);
  }
});
