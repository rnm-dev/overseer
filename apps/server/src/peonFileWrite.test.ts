import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { WebSocket } from "ws";
import {
  failPeonFileTransfers,
  getPeonFileWriteCoordinatorSnapshot,
  handlePeonFileJson,
  MAX_FILE_CHUNK_BYTES,
  movePeonProjectFile,
  PeonFileStreamError,
  uploadPeonProjectFile,
  uploadPeonSandboxFile,
} from "./peonFileStream.js";
import {
  claimPeonTransferConnection,
  FILE_WRITE_CAPABILITY,
  releasePeonTransferConnection,
} from "./peonTransferConnections.js";
import { projectFileWriteChannel, sandboxFileWriteChannel } from "./modules/projects/index.js";

interface FakeSocket {
  readyState: number;
  sent: Array<string | Buffer>;
  send(data: string | Buffer): void;
}

function socket(): WebSocket & FakeSocket {
  const fake: FakeSocket = {
    readyState: WebSocket.OPEN,
    sent: [],
    send(data) {
      this.sent.push(typeof data === "string" ? data : Buffer.from(data));
    },
  };
  return fake as WebSocket & FakeSocket;
}

function jsonFrames(ws: FakeSocket): Array<Record<string, unknown>> {
  return ws.sent.filter((value): value is string => typeof value === "string").map((value) => JSON.parse(value) as Record<string, unknown>);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Overseer file writer");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Overseer chunks client uploads only after Peon credit and preserves the public result", async (t) => {
  const peonId = "write-peon";
  const ws = socket();
  claimPeonTransferConnection(peonId, ws, [FILE_WRITE_CAPABILITY]);
  t.after(() => releasePeonTransferConnection(peonId, ws));

  const bytes = Buffer.alloc(MAX_FILE_CHUNK_BYTES + 7, 0x62);
  const result = uploadPeonProjectFile({
    peonId,
    workspaceId: "workspace",
    projectId: "project-id",
    relativePath: "dist/app.bin",
    source: Readable.from(bytes),
    contentLength: bytes.length,
    sha256: "a".repeat(64),
    maxBytes: 100 * 1024 * 1024,
    actor: { userId: "operator", email: "operator@example.com" },
  });
  const open = jsonFrames(ws)[0]!;
  assert.deepEqual({
    type: open.type,
    operation: open.operation,
    scope: open.scope,
    projectId: open.projectId,
    relativePath: open.relativePath,
    contentLength: open.contentLength,
    sha256: open.sha256,
  }, {
    type: "write_open",
    operation: "upload",
    scope: "project",
    projectId: "project-id",
    relativePath: "dist/app.bin",
    contentLength: bytes.length,
    sha256: "a".repeat(64),
  });
  const requestId = String(open.requestId);
  assert.equal(handlePeonFileJson(peonId, ws, {
    type: "write_ready",
    requestId,
    maxBytes: 100 * 1024 * 1024,
    credit: MAX_FILE_CHUNK_BYTES,
  }), true);
  await waitFor(() => ws.sent.some((value) => Buffer.isBuffer(value)));
  assert.equal(ws.sent.filter((value) => Buffer.isBuffer(value)).length, 1, "credit bounds in-flight binary data");
  assert.equal(handlePeonFileJson(peonId, ws, { type: "write_credit", requestId, bytes: MAX_FILE_CHUNK_BYTES }), true);
  await waitFor(() => ws.sent.filter((value) => Buffer.isBuffer(value)).length === 2);
  await waitFor(() => jsonFrames(ws).some((frame) => frame.type === "write_end"));
  assert.equal(handlePeonFileJson(peonId, ws, {
    type: "write_result",
    requestId,
    status: 201,
    path: "dist/app.bin",
    size: bytes.length,
    sha256: "b".repeat(64),
  }), true);
  assert.deepEqual(await result, {
    status: 201,
    path: "dist/app.bin",
    size: bytes.length,
    sha256: "b".repeat(64),
  });
});

test("Overseer propagates checksum refusals and cancels on browser abort or transfer disconnect", async (t) => {
  const peonId = "write-failures";
  const ws = socket();
  claimPeonTransferConnection(peonId, ws, [FILE_WRITE_CAPABILITY]);
  t.after(() => releasePeonTransferConnection(peonId, ws));

  const refused = uploadPeonSandboxFile({
    peonId,
    workspaceId: "workspace",
    path: "uploads/session/file.txt",
    source: Readable.from(Buffer.from("body")),
    contentLength: 4,
    maxBytes: 25 * 1024 * 1024,
    actor: { userId: "operator", email: "operator@example.com" },
  });
  const refusedOpen = jsonFrames(ws).at(-1)!;
  assert.equal(handlePeonFileJson(peonId, ws, {
    type: "write_error",
    requestId: refusedOpen.requestId,
    status: 409,
    code: "CHECKSUM_MISMATCH",
    message: "private digest detail",
  }), true);
  await assert.rejects(refused, (error: unknown) => error instanceof PeonFileStreamError
    && error.status === 409 && error.code === "CHECKSUM_MISMATCH");

  const controller = new AbortController();
  const source = new PassThrough();
  const cancelled = uploadPeonSandboxFile({
    peonId,
    workspaceId: "workspace",
    path: "uploads/session/cancelled.txt",
    source,
    maxBytes: 25 * 1024 * 1024,
    actor: { userId: "operator", email: "operator@example.com" },
    signal: controller.signal,
  });
  const cancelledOpen = jsonFrames(ws).at(-1)!;
  handlePeonFileJson(peonId, ws, {
    type: "write_ready",
    requestId: cancelledOpen.requestId,
    maxBytes: 25 * 1024 * 1024,
    credit: MAX_FILE_CHUNK_BYTES,
  });
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof PeonFileStreamError && error.code === "TRANSFER_CANCELLED");
  assert.ok(jsonFrames(ws).some((frame) => frame.type === "write_cancel" && frame.requestId === cancelledOpen.requestId));

  const disconnected = movePeonProjectFile({
    peonId,
    workspaceId: "workspace",
    projectId: "project-id",
    relativePath: "from.txt",
    destination: "to.txt",
    actor: { userId: "operator", email: "operator@example.com" },
  });
  failPeonFileTransfers(peonId, ws);
  await assert.rejects(disconnected, (error: unknown) => error instanceof PeonFileStreamError
    && error.code === "PEON_TRANSFER_DISCONNECTED");
});

test("write routing is capability-gated, mixed-version compatible, and exclusive once selected", () => {
  assert.equal(sandboxFileWriteChannel({ capabilityReady: false }), "proxy");
  assert.equal(sandboxFileWriteChannel({ capabilityReady: true }), "socket");
  assert.equal(projectFileWriteChannel({ capabilityReady: false, projectId: "project" }), "proxy");
  assert.equal(projectFileWriteChannel({ capabilityReady: true, projectId: null }), "unavailable");
  assert.equal(projectFileWriteChannel({ capabilityReady: true, projectId: "project" }), "socket");
});

test("write coordinator requires exact capability and validates security boundaries before opening", async (t) => {
  const peonId = "old-peon";
  const ws = socket();
  claimPeonTransferConnection(peonId, ws, ["project-file-read-v1"]);
  t.after(() => releasePeonTransferConnection(peonId, ws));
  assert.throws(
    () => uploadPeonProjectFile({
      peonId,
      workspaceId: "workspace",
      projectId: "project",
      relativePath: "file.txt",
      source: Readable.from("body"),
      maxBytes: 100,
      actor: { userId: "operator", email: "operator@example.com" },
    }),
    (error: unknown) => error instanceof PeonFileStreamError && error.code === "PEON_TRANSFER_UNAVAILABLE",
  );
  assert.throws(
    () => uploadPeonProjectFile({
      peonId,
      workspaceId: "workspace",
      projectId: "project",
      relativePath: "../escape",
      source: Readable.from("body"),
      maxBytes: 100,
      actor: { userId: "operator", email: "operator@example.com" },
    }),
    (error: unknown) => error instanceof PeonFileStreamError && error.code === "INVALID_PROJECT_PATH",
  );
  assert.equal(ws.sent.length, 0);
});

test("write coordinator correlates command/transfer IDs and bounds user byte reservations", async (t) => {
  const peonId = "write-admission";
  const ws = socket();
  claimPeonTransferConnection(peonId, ws, [FILE_WRITE_CAPABILITY]);
  t.after(() => releasePeonTransferConnection(peonId, ws));

  const commandId = "11111111-1111-4111-8111-111111111111";
  const first = uploadPeonProjectFile({
    peonId,
    workspaceId: "workspace-a",
    projectId: "project",
    relativePath: "first.bin",
    source: new PassThrough(),
    contentLength: 100 * 1024 * 1024,
    maxBytes: 100 * 1024 * 1024,
    commandId,
    actor: { userId: "bounded-user", email: "operator@example.com" },
  });
  const firstOpen = jsonFrames(ws).at(-1)!;
  assert.equal(firstOpen.transferId, firstOpen.requestId);
  assert.equal(firstOpen.commandId, commandId);
  assert.deepEqual(getPeonFileWriteCoordinatorSnapshot(), {
    active: 1,
    reservedBytes: 100 * 1024 * 1024,
    lifecycle: { pending: 1 },
  });

  const second = uploadPeonProjectFile({
    peonId,
    workspaceId: "workspace-a",
    projectId: "project",
    relativePath: "second.bin",
    source: new PassThrough(),
    contentLength: 100 * 1024 * 1024,
    maxBytes: 100 * 1024 * 1024,
    actor: { userId: "bounded-user", email: "operator@example.com" },
  });
  assert.throws(
    () => uploadPeonProjectFile({
      peonId,
      workspaceId: "workspace-a",
      projectId: "project",
      relativePath: "third.bin",
      source: new PassThrough(),
      contentLength: 100 * 1024 * 1024,
      maxBytes: 100 * 1024 * 1024,
      actor: { userId: "bounded-user", email: "operator@example.com" },
    }),
    (error: unknown) => error instanceof PeonFileStreamError
      && error.code === "TRANSFER_QUOTA_EXCEEDED"
      && error.status === 429,
  );

  failPeonFileTransfers(peonId, ws);
  await assert.rejects(first);
  await assert.rejects(second);
  assert.deepEqual(getPeonFileWriteCoordinatorSnapshot(), {
    active: 0,
    reservedBytes: 0,
    lifecycle: {},
  });
});
