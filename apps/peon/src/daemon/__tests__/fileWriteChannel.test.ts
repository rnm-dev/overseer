import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FILE_WRITE_BINARY_HEADER_BYTES,
  FILE_WRITE_MAX_CHUNK_BYTES,
  FileWriteChannel,
} from "../overseer/socket/channels/fileWriteChannel.js";
import type { PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";
import { AtomicFileUpload, moveProjectFile } from "../files/index.js";

const actor = { userId: "operator", email: "operator@example.com" };

function sender(generation?: number): PeonSocketSender & { frames: PeonSocketFrame[]; disconnects: string[] } {
  const frames: PeonSocketFrame[] = [];
  const disconnects: string[] = [];
  return {
    durable: false,
    generation,
    frames,
    disconnects,
    send(frame) {
      frames.push(frame);
      return true;
    },
    sendBinary() {
      return true;
    },
    sendDurable() {
      return { accepted: false, code: "INVALID_MESSAGE", error: "not supported" };
    },
    disconnect(reason) {
      disconnects.push(reason);
    },
  };
}

function controlledUploadOpen() {
  const pending: Array<{
    resolve: (upload: never) => void;
    cancelled: { value: boolean };
  }> = [];
  const openUpload = () => new Promise<never>((resolve) => {
    pending.push({ resolve, cancelled: { value: false } });
  });
  const resolve = (index: number) => {
    const entry = pending[index]!;
    entry.resolve({
      size: 0,
      write: async () => {},
      complete: async () => ({ path: "unused", size: 0, sha256: createHash("sha256").digest("hex") }),
      cancel: async () => { entry.cancelled.value = true; },
    } as never);
  };
  return { openUpload, pending, resolve };
}

function uploadFrame(requestId: string, projectId: string, relativePath: string, bytes: Buffer, sha256?: string): PeonSocketFrame {
  return {
    type: "write_open",
    protocol: 1,
    requestId,
    operation: "upload",
    scope: "project",
    projectId,
    relativePath,
    contentLength: bytes.length,
    ...(sha256 ? { sha256 } : {}),
    actor,
  };
}

function moveFrame(
  requestId: string,
  projectId: string,
  relativePath = "source.txt",
  destination = "destination.txt",
): PeonSocketFrame {
  return {
    type: "write_open",
    protocol: 1,
    requestId,
    operation: "move",
    scope: "project",
    projectId,
    relativePath,
    destination,
    actor,
  };
}

function controlledMove() {
  let executions = 0;
  let finish!: (result: { path: string; size: number }) => void;
  let markSettled!: () => void;
  const operation = new Promise<{ path: string; size: number }>((resolve) => { finish = resolve; });
  const settled = new Promise<void>((resolve) => { markSettled = resolve; });
  const moveFile = async () => {
    executions += 1;
    try {
      return await operation;
    } finally {
      markSettled();
    }
  };
  return {
    moveFile,
    finish,
    settled,
    get executions() { return executions; },
  };
}

function chunk(requestId: string, sequence: number, bytes: Buffer): Buffer {
  const frame = Buffer.alloc(FILE_WRITE_BINARY_HEADER_BYTES + bytes.length);
  frame[0] = 1;
  frame[1] = 2;
  Buffer.from(requestId.replaceAll("-", ""), "hex").copy(frame, 2);
  frame.writeUInt32BE(sequence, 18);
  bytes.copy(frame, FILE_WRITE_BINARY_HEADER_BYTES);
  return frame;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for file write channel");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture(): { root: string; outside: string; channel: FileWriteChannel; projectId: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-write-project-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "peon-write-outside-"));
  const projectId = randomUUID();
  const channel = new FileWriteChannel({
    projects: { list: () => [{ projectId, dir: root }] as never },
    sandboxRoot: () => path.join(root, "sandbox"),
    idleLeaseMs: 1_000,
  });
  return { root, outside, channel, projectId };
}

test("file write channel streams by credit, commits atomically, and replays terminal results idempotently", async (t) => {
  const { root, outside, channel, projectId } = fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  mkdirSync(path.join(root, "nested"));
  const connection = sender();
  channel.negotiated(true, {}, connection);

  const requestId = randomUUID();
  const bytes = Buffer.alloc(FILE_WRITE_MAX_CHUNK_BYTES + 17, 0x61);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const open = uploadFrame(requestId, projectId, "nested/file.bin", bytes, digest);
  channel.receive(open, connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_ready"));
  const ready = connection.frames.find((frame) => frame.type === "write_ready")!;
  assert.equal(ready.credit, FILE_WRITE_MAX_CHUNK_BYTES);

  channel.receiveBinary(chunk(requestId, 0, bytes.subarray(0, FILE_WRITE_MAX_CHUNK_BYTES)), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_credit"));
  channel.receiveBinary(chunk(requestId, 1, bytes.subarray(FILE_WRITE_MAX_CHUNK_BYTES)), connection);
  channel.receive({ type: "write_end", requestId }, connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_result"));

  const result = connection.frames.find((frame) => frame.type === "write_result")!;
  assert.equal(result.status, 201);
  assert.equal(result.sha256, digest);
  assert.deepEqual(readFileSync(path.join(root, "nested/file.bin")), bytes);
  assert.equal(readdirSync(path.join(root, "nested")).some((name) => name.includes(".peon-upload-")), false);

  const before = connection.frames.length;
  channel.receive(open, connection);
  assert.deepEqual(connection.frames[before], result, "same request ID and input replays the cached terminal result");
  channel.receive({ ...open, relativePath: "nested/other.bin" }, connection);
  assert.equal(connection.frames.at(-1)?.code, "REQUEST_ID_REUSE");
  assert.equal(connection.disconnects.length, 0);
});

test("checksum mismatch, cancellation, and disconnect leave no partial destination or temporary file", async (t) => {
  const { root, outside, channel, projectId } = fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const connection = sender();
  channel.negotiated(true, {}, connection);
  const destination = path.join(root, "keep.txt");
  writeFileSync(destination, "original");

  const mismatchId = randomUUID();
  const bytes = Buffer.from("replacement");
  channel.receive(uploadFrame(mismatchId, projectId, "keep.txt", bytes, "0".repeat(64)), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_ready" && frame.requestId === mismatchId));
  channel.receiveBinary(chunk(mismatchId, 0, bytes), connection);
  channel.receive({ type: "write_end", requestId: mismatchId }, connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_error" && frame.requestId === mismatchId));
  assert.equal(connection.frames.find((frame) => frame.requestId === mismatchId && frame.type === "write_error")?.code, "CHECKSUM_MISMATCH");
  assert.equal(readFileSync(destination, "utf8"), "original");

  const cancelledId = randomUUID();
  channel.receive(uploadFrame(cancelledId, projectId, "cancelled.bin", Buffer.alloc(10)), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_ready" && frame.requestId === cancelledId));
  channel.receiveBinary(chunk(cancelledId, 0, Buffer.from("part")), connection);
  channel.receive({ type: "write_cancel", requestId: cancelledId }, connection);
  await waitFor(() => !readdirSync(root).some((name) => name.includes(".peon-upload-")));
  assert.equal(readdirSync(root).includes("cancelled.bin"), false);

  const disconnectedId = randomUUID();
  channel.receive(uploadFrame(disconnectedId, projectId, "disconnected.bin", Buffer.alloc(10)), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_ready" && frame.requestId === disconnectedId));
  channel.receiveBinary(chunk(disconnectedId, 0, Buffer.from("part")), connection);
  channel.disconnected(false);
  await waitFor(() => !readdirSync(root).some((name) => name.includes(".peon-upload-")));
  assert.equal(readdirSync(root).includes("disconnected.bin"), false);
});

test("file write channel enforces limits, credit, project containment, and sandbox symlink boundaries", async (t) => {
  const { root, outside, channel, projectId } = fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const connection = sender();
  channel.negotiated(true, {}, connection);

  const oversizedId = randomUUID();
  channel.receive({
    ...uploadFrame(oversizedId, projectId, "too-large.bin", Buffer.alloc(0)),
    contentLength: 100 * 1024 * 1024 + 1,
  }, connection);
  await waitFor(() => connection.frames.some((frame) => frame.requestId === oversizedId));
  assert.equal(connection.frames.find((frame) => frame.requestId === oversizedId)?.code, "FILE_TOO_LARGE");

  symlinkSync(outside, path.join(root, "escape"));
  const escapedId = randomUUID();
  channel.receive(uploadFrame(escapedId, projectId, "escape/secret.txt", Buffer.from("secret")), connection);
  await waitFor(() => connection.frames.some((frame) => frame.requestId === escapedId));
  assert.equal(connection.frames.find((frame) => frame.requestId === escapedId)?.code, "PATH_ESCAPE");
  assert.equal(readdirSync(outside).length, 0);

  const sandboxRoot = path.join(root, "sandbox");
  mkdirSync(sandboxRoot);
  symlinkSync(outside, path.join(sandboxRoot, "uploads"));
  const sandboxId = randomUUID();
  channel.receive({
    type: "write_open",
    protocol: 1,
    requestId: sandboxId,
    operation: "upload",
    scope: "sandbox",
    path: "uploads/session/file.txt",
    contentLength: 1,
    actor,
  }, connection);
  await waitFor(() => connection.frames.some((frame) => frame.requestId === sandboxId));
  assert.equal(connection.frames.find((frame) => frame.requestId === sandboxId)?.code, "PATH_ESCAPE");

  unlinkSync(path.join(sandboxRoot, "uploads"));
  mkdirSync(path.join(sandboxRoot, "uploads"));
  const attachmentLimitId = randomUUID();
  channel.receive({
    type: "write_open",
    protocol: 1,
    requestId: attachmentLimitId,
    operation: "upload",
    scope: "sandbox",
    path: "uploads/session/large.bin",
    contentLength: 25 * 1024 * 1024 + 1,
    actor,
  }, connection);
  await waitFor(() => connection.frames.some((frame) => frame.requestId === attachmentLimitId));
  assert.equal(connection.frames.find((frame) => frame.requestId === attachmentLimitId)?.code, "FILE_TOO_LARGE");

  const creditId = randomUUID();
  channel.receive(uploadFrame(creditId, projectId, "credit.bin", Buffer.alloc(FILE_WRITE_MAX_CHUNK_BYTES + 1)), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_ready" && frame.requestId === creditId));
  channel.receiveBinary(chunk(creditId, 0, Buffer.alloc(FILE_WRITE_MAX_CHUNK_BYTES + 1)), connection);
  assert.match(connection.disconnects.at(-1) ?? "", /invalid file write binary frame/);
});

test("project move is no-clobber, scoped to one project, and replay-safe", async (t) => {
  const { root, outside, channel, projectId } = fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  writeFileSync(path.join(root, "source.txt"), "source");
  writeFileSync(path.join(root, "occupied.txt"), "occupied");
  const connection = sender();
  channel.negotiated(true, {}, connection);

  const occupiedId = randomUUID();
  channel.receive({
    type: "write_open",
    protocol: 1,
    requestId: occupiedId,
    operation: "move",
    scope: "project",
    projectId,
    relativePath: "source.txt",
    destination: "occupied.txt",
    actor,
  }, connection);
  await waitFor(() => connection.frames.some((frame) => frame.requestId === occupiedId));
  assert.equal(connection.frames.find((frame) => frame.requestId === occupiedId)?.code, "DESTINATION_EXISTS");
  assert.equal(readFileSync(path.join(root, "source.txt"), "utf8"), "source");
  assert.equal(readFileSync(path.join(root, "occupied.txt"), "utf8"), "occupied");

  const movedId = randomUUID();
  const move = {
    type: "write_open",
    protocol: 1,
    requestId: movedId,
    operation: "move",
    scope: "project",
    projectId,
    relativePath: "source.txt",
    destination: "moved.txt",
    actor,
  };
  channel.receive(move, connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_result" && frame.requestId === movedId));
  assert.equal(readFileSync(path.join(root, "moved.txt"), "utf8"), "source");
  assert.equal(readdirSync(root).includes("source.txt"), false);
  const first = connection.frames.find((frame) => frame.type === "write_result" && frame.requestId === movedId);
  channel.receive(move, connection);
  assert.deepEqual(connection.frames.at(-1), first);

  const escapeId = randomUUID();
  channel.receive({ ...move, requestId: escapeId, relativePath: "moved.txt", destination: "../outside.txt" }, connection);
  await waitFor(() => connection.frames.some((frame) => frame.requestId === escapeId));
  assert.equal(connection.frames.find((frame) => frame.requestId === escapeId)?.code, "PATH_ESCAPE");
});

test("shared project move derives source and destination from one anchored root during pathname swap and restore", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-move-root-swap-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "peon-move-root-swap-outside-"));
  const heldRoot = `${root}-held`;
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(heldRoot, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  writeFileSync(path.join(root, "source.txt"), "authorized-source");
  writeFileSync(path.join(outside, "source.txt"), "outside-source");
  const result = await moveProjectFile({ dir: root }, "source.txt", "destination.txt", {
    afterProjectRootOpen: () => {
      renameSync(root, heldRoot);
      symlinkSync(outside, root);
    },
    beforeCommit: () => {
      assert.equal(readdirSync(outside).includes("destination.txt"), false);
      unlinkSync(root);
      renameSync(heldRoot, root);
    },
  });
  assert.deepEqual(result, { path: "destination.txt", size: Buffer.byteLength("authorized-source") });
  assert.equal(readFileSync(path.join(root, "destination.txt"), "utf8"), "authorized-source");
  assert.equal(readdirSync(root).includes("source.txt"), false);
  assert.equal(readFileSync(path.join(outside, "source.txt"), "utf8"), "outside-source");
  assert.equal(readdirSync(outside).includes("destination.txt"), false);
});

test("transfer-socket project move stays under one anchored root during pathname swap and restore", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-socket-move-root-swap-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "peon-socket-move-root-swap-outside-"));
  const heldRoot = `${root}-held`;
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(heldRoot, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  writeFileSync(path.join(root, "source.txt"), "authorized-socket-source");
  writeFileSync(path.join(outside, "source.txt"), "outside-socket-source");
  const projectId = randomUUID();
  const channel = new FileWriteChannel({
    projects: { list: () => [{ projectId, dir: root }] as never },
    sandboxRoot: () => path.join(root, "sandbox"),
    moveFile: (record, source, destination) => moveProjectFile(record, source, destination, {
      afterProjectRootOpen: () => {
        renameSync(root, heldRoot);
        symlinkSync(outside, root);
      },
      beforeCommit: () => {
        assert.equal(readdirSync(outside).includes("destination.txt"), false);
        unlinkSync(root);
        renameSync(heldRoot, root);
      },
    }),
  });
  const connection = sender(35);
  channel.negotiated(true, {}, connection);
  const requestId = randomUUID();
  channel.receive(moveFrame(requestId, projectId, "source.txt", "destination.txt"), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_result" && frame.requestId === requestId));
  assert.equal(readFileSync(path.join(root, "destination.txt"), "utf8"), "authorized-socket-source");
  assert.equal(readdirSync(root).includes("source.txt"), false);
  assert.equal(readFileSync(path.join(outside, "source.txt"), "utf8"), "outside-socket-source");
  assert.equal(readdirSync(outside).includes("destination.txt"), false);
});

test("concurrent project moves racing for one destination never clobber either source", async (t) => {
  const { root, outside, channel, projectId } = fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  writeFileSync(path.join(root, "first.txt"), "first");
  writeFileSync(path.join(root, "second.txt"), "second");
  const connection = sender();
  channel.negotiated(true, {}, connection);
  const firstId = randomUUID();
  const secondId = randomUUID();
  const move = (requestId: string, relativePath: string): PeonSocketFrame => ({
    type: "write_open",
    protocol: 1,
    requestId,
    operation: "move",
    scope: "project",
    projectId,
    relativePath,
    destination: "winner.txt",
    actor,
  });
  channel.receive(move(firstId, "first.txt"), connection);
  channel.receive(move(secondId, "second.txt"), connection);
  await waitFor(() => connection.frames.filter((frame) => frame.requestId === firstId || frame.requestId === secondId).length === 2);

  const outcomes = connection.frames.filter((frame) => frame.requestId === firstId || frame.requestId === secondId);
  assert.equal(outcomes.filter((frame) => frame.type === "write_result").length, 1);
  assert.equal(outcomes.filter((frame) => frame.code === "DESTINATION_EXISTS").length, 1);
  const winner = readFileSync(path.join(root, "winner.txt"), "utf8");
  assert.ok(winner === "first" || winner === "second");
  const remaining = readdirSync(root).filter((name) => name === "first.txt" || name === "second.txt");
  assert.equal(remaining.length, 1);
  assert.notEqual(readFileSync(path.join(root, remaining[0]!), "utf8"), winner);
});

test("opening admissions are bounded, cancellable, retryable, and incarnation fenced", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-write-admission-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const projectId = randomUUID();
  const controlled = controlledUploadOpen();
  const channel = new FileWriteChannel({
    projects: { list: () => [{ projectId, dir: root }] as never },
    maxActive: 1,
    idleLeaseMs: 1_000,
    openUpload: controlled.openUpload as never,
  });
  const connection = sender(11);
  channel.negotiated(true, {}, connection);
  const firstId = randomUUID();
  const first = uploadFrame(firstId, projectId, "first.bin", Buffer.alloc(1));
  channel.receive(first, connection);
  await waitFor(() => controlled.pending.length === 1);

  const refusedId = randomUUID();
  channel.receive(uploadFrame(refusedId, projectId, "refused.bin", Buffer.alloc(1)), connection);
  assert.equal(connection.frames.find((frame) => frame.requestId === refusedId)?.code, "TRANSFER_BUSY");

  channel.receive({ type: "write_cancel", requestId: firstId }, connection);
  channel.receive(first, connection);
  assert.equal(connection.frames.at(-1)?.code, "TRANSFER_BUSY");
  controlled.resolve(0);
  await waitFor(() => controlled.pending[0]!.cancelled.value);
  assert.equal(connection.frames.some((frame) => frame.type === "write_ready" && frame.requestId === firstId), false);

  channel.receive(first, connection);
  await waitFor(() => controlled.pending.length === 2);
  controlled.resolve(1);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_ready" && frame.requestId === firstId));
  assert.equal(
    connection.frames.filter((frame) => frame.type === "write_ready" && frame.requestId === firstId).length,
    1,
  );
  const activeRefusal = randomUUID();
  channel.receive(uploadFrame(activeRefusal, projectId, "active-refused.bin", Buffer.alloc(1)), connection);
  assert.equal(connection.frames.find((frame) => frame.requestId === activeRefusal)?.code, "TRANSFER_BUSY");
  channel.disconnected(false);
});

test("move work consumes the same admission bound until its native operation settles", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-write-move-admission-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const projectId = randomUUID();
  let finishMove!: (value: { path: string; size: number }) => void;
  const moving = new Promise<{ path: string; size: number }>((resolve) => { finishMove = resolve; });
  const channel = new FileWriteChannel({
    projects: { list: () => [{ projectId, dir: root }] as never },
    maxActive: 1,
    moveFile: (() => moving) as never,
  });
  const connection = sender(12);
  channel.negotiated(true, {}, connection);
  const moveId = randomUUID();
  channel.receive({
    type: "write_open",
    protocol: 1,
    requestId: moveId,
    operation: "move",
    scope: "project",
    projectId,
    relativePath: "source.txt",
    destination: "destination.txt",
    actor,
  }, connection);
  const refusedId = randomUUID();
  channel.receive(uploadFrame(refusedId, projectId, "refused-during-move.bin", Buffer.alloc(1)), connection);
  assert.equal(connection.frames.find((frame) => frame.requestId === refusedId)?.code, "TRANSFER_BUSY");
  finishMove({ path: "destination.txt", size: 1 });
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_result" && frame.requestId === moveId));
});

test("cancelled move keeps same-ID ownership and replays its authoritative result", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-write-move-cancel-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const projectId = randomUUID();
  const controlled = controlledMove();
  const channel = new FileWriteChannel({
    projects: { list: () => [{ projectId, dir: root }] as never },
    moveFile: controlled.moveFile as never,
  });
  const connection = sender(13);
  channel.negotiated(true, {}, connection);
  const requestId = randomUUID();
  const frame = moveFrame(requestId, projectId);
  channel.receive(frame, connection);
  await waitFor(() => controlled.executions === 1);
  channel.receive({ type: "write_cancel", requestId }, connection);

  channel.receive(frame, connection);
  assert.equal(connection.frames.at(-1)?.code, "DUPLICATE_REQUEST");
  channel.receive({ ...frame, destination: "changed.txt" }, connection);
  assert.equal(connection.frames.at(-1)?.code, "REQUEST_ID_REUSE");
  assert.equal(controlled.executions, 1);

  controlled.finish({ path: "destination.txt", size: 7 });
  await controlled.settled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(connection.frames.some((item) => item.type === "write_result" && item.requestId === requestId), false);
  channel.receive(frame, connection);
  assert.deepEqual(connection.frames.at(-1), {
    type: "write_result",
    requestId,
    status: 200,
    path: "destination.txt",
    size: 7,
  });
  assert.equal(controlled.executions, 1);
});

test("expired move lease preserves its tombstone until terminal replay is available", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-write-move-lease-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const projectId = randomUUID();
  const controlled = controlledMove();
  const channel = new FileWriteChannel({
    projects: { list: () => [{ projectId, dir: root }] as never },
    idleLeaseMs: 25,
    moveFile: controlled.moveFile as never,
  });
  const connection = sender(14);
  channel.negotiated(true, {}, connection);
  const requestId = randomUUID();
  const frame = moveFrame(requestId, projectId);
  channel.receive(frame, connection);
  await waitFor(() => connection.frames.some((item) => item.requestId === requestId && item.code === "TRANSFER_TIMEOUT"));
  channel.receive(frame, connection);
  assert.equal(connection.frames.at(-1)?.code, "DUPLICATE_REQUEST");
  assert.equal(controlled.executions, 1);

  controlled.finish({ path: "destination.txt", size: 8 });
  await controlled.settled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  channel.receive(frame, connection);
  assert.deepEqual(connection.frames.at(-1), {
    type: "write_result",
    requestId,
    status: 200,
    path: "destination.txt",
    size: 8,
  });
});

test("move completion after reconnect is cached but never published to the stale generation", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-write-move-generation-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const projectId = randomUUID();
  const controlled = controlledMove();
  const channel = new FileWriteChannel({
    projects: { list: () => [{ projectId, dir: root }] as never },
    moveFile: controlled.moveFile as never,
  });
  const oldConnection = sender(40);
  const newConnection = sender(41);
  const requestId = randomUUID();
  const frame = moveFrame(requestId, projectId);
  channel.negotiated(true, {}, oldConnection);
  channel.receive(frame, oldConnection);
  await waitFor(() => controlled.executions === 1);
  channel.disconnected(false);
  channel.negotiated(true, {}, newConnection);
  channel.receive(frame, newConnection);
  assert.equal(newConnection.frames.at(-1)?.code, "DUPLICATE_REQUEST");

  controlled.finish({ path: "destination.txt", size: 9 });
  await controlled.settled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(oldConnection.frames.some((item) => item.type === "write_result"), false);
  assert.equal(newConnection.frames.some((item) => item.type === "write_result"), false);
  channel.receive(frame, newConnection);
  assert.deepEqual(newConnection.frames.at(-1), {
    type: "write_result",
    requestId,
    status: 200,
    path: "destination.txt",
    size: 9,
  });
  assert.equal(controlled.executions, 1);
});

test("a delayed open from a stale socket generation cannot replace its retry", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-write-generation-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const projectId = randomUUID();
  const controlled = controlledUploadOpen();
  const channel = new FileWriteChannel({
    projects: { list: () => [{ projectId, dir: root }] as never },
    maxActive: 1,
    idleLeaseMs: 1_000,
    openUpload: controlled.openUpload as never,
  });
  const oldConnection = sender(20);
  const newConnection = sender(21);
  const requestId = randomUUID();
  const frame = uploadFrame(requestId, projectId, "generation.bin", Buffer.alloc(1));
  channel.negotiated(true, {}, oldConnection);
  channel.receive(frame, oldConnection);
  await waitFor(() => controlled.pending.length === 1);

  channel.negotiated(true, {}, newConnection);
  channel.receive(frame, newConnection);
  assert.equal(newConnection.frames.at(-1)?.code, "TRANSFER_BUSY");
  controlled.resolve(0);
  await waitFor(() => controlled.pending[0]!.cancelled.value);
  assert.equal(oldConnection.frames.some((item) => item.type === "write_ready"), false);

  channel.receive(frame, newConnection);
  await waitFor(() => controlled.pending.length === 2);
  controlled.resolve(1);
  await waitFor(() => newConnection.frames.some((item) => item.type === "write_ready" && item.requestId === requestId));
  assert.equal(newConnection.disconnects.length, 0);
  channel.disconnected(false);
});

test("an opening lease expires, releases admission capacity, and fences the late open", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-write-opening-lease-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const projectId = randomUUID();
  const controlled = controlledUploadOpen();
  const channel = new FileWriteChannel({
    projects: { list: () => [{ projectId, dir: root }] as never },
    maxActive: 1,
    idleLeaseMs: 25,
    openUpload: controlled.openUpload as never,
  });
  const connection = sender(22);
  channel.negotiated(true, {}, connection);
  const requestId = randomUUID();
  const frame = uploadFrame(requestId, projectId, "leased.bin", Buffer.alloc(1));
  channel.receive(frame, connection);
  await waitFor(() => connection.frames.some((item) => item.requestId === requestId && item.code === "TRANSFER_TIMEOUT"));
  channel.receive(frame, connection);
  assert.equal(connection.frames.at(-1)?.code, "TRANSFER_BUSY");
  controlled.resolve(0);
  await waitFor(() => controlled.pending[0]!.cancelled.value);
  channel.receive(frame, connection);
  await waitFor(() => controlled.pending.length === 2);
  controlled.resolve(1);
  await waitFor(() => connection.frames.some((item) => item.type === "write_ready" && item.requestId === requestId));
  channel.disconnected(false);
});

test("socket upload fails closed when its parent pathname is swapped before commit", async (t) => {
  const { root, outside, channel, projectId } = fixture();
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const parent = path.join(root, "parent");
  const anchored = path.join(root, "anchored-parent");
  mkdirSync(parent);
  const connection = sender(31);
  channel.negotiated(true, {}, connection);
  const requestId = randomUUID();
  const bytes = Buffer.from("contained");
  channel.receive(uploadFrame(requestId, projectId, "parent/result.txt", bytes), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_ready" && frame.requestId === requestId));
  channel.receiveBinary(chunk(requestId, 0, bytes), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_credit" && frame.requestId === requestId));
  renameSync(parent, anchored);
  symlinkSync(outside, parent);
  channel.receive({ type: "write_end", requestId }, connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_error" && frame.requestId === requestId));
  assert.equal(
    connection.frames.find((frame) => frame.type === "write_error" && frame.requestId === requestId)?.code,
    "PATH_ESCAPE",
  );
  assert.equal(readdirSync(outside).includes("result.txt"), false);
  assert.equal(readdirSync(anchored).includes("result.txt"), false);
  assert.equal(readdirSync(anchored).some((name) => name.includes(".peon-upload-")), false);
});

test("socket temp creation stays in its anchored parent when the pathname is swapped during open", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-write-open-swap-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "peon-write-open-swap-outside-"));
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const parent = path.join(root, "parent");
  const anchored = path.join(root, "anchored-parent");
  mkdirSync(parent);
  const projectId = randomUUID();
  const channel = new FileWriteChannel({
    projects: { list: () => [{ projectId, dir: root }] as never },
    sandboxRoot: () => path.join(root, "sandbox"),
    idleLeaseMs: 1_000,
    openUpload: (target, maxBytes, claimedSha256) => AtomicFileUpload.open(target, maxBytes, claimedSha256, {
      beforeTemporaryOpen: () => {
        renameSync(parent, anchored);
        symlinkSync(outside, parent);
      },
      afterTemporaryOpen: () => {
        assert.equal(readdirSync(outside).some((name) => name.includes(".peon-upload-")), false);
        assert.equal(readdirSync(anchored).some((name) => name.includes(".peon-upload-")), true);
      },
    }),
  });
  const connection = sender(32);
  channel.negotiated(true, {}, connection);
  const requestId = randomUUID();
  const bytes = Buffer.from("anchored-open");
  channel.receive(uploadFrame(requestId, projectId, "parent/result.txt", bytes), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_ready" && frame.requestId === requestId));
  channel.receiveBinary(chunk(requestId, 0, bytes), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_credit" && frame.requestId === requestId));
  channel.receive({ type: "write_end", requestId }, connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_error" && frame.requestId === requestId));
  assert.equal(
    connection.frames.find((frame) => frame.type === "write_error" && frame.requestId === requestId)?.code,
    "PATH_ESCAPE",
  );
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(readdirSync(anchored).includes("result.txt"), false);
  assert.equal(readdirSync(anchored).some((name) => name.includes(".peon-upload-")), false);
});

test("socket upload commits after its pathname-swapped anchored parent is restored during open", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-write-open-restore-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "peon-write-open-restore-outside-"));
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const parent = path.join(root, "parent");
  const anchored = path.join(root, "anchored-parent");
  mkdirSync(parent);
  const projectId = randomUUID();
  const channel = new FileWriteChannel({
    projects: { list: () => [{ projectId, dir: root }] as never },
    sandboxRoot: () => path.join(root, "sandbox"),
    idleLeaseMs: 1_000,
    openUpload: (target, maxBytes, claimedSha256) => AtomicFileUpload.open(target, maxBytes, claimedSha256, {
      beforeTemporaryOpen: () => {
        renameSync(parent, anchored);
        symlinkSync(outside, parent);
      },
      afterTemporaryOpen: () => {
        assert.equal(readdirSync(outside).some((name) => name.includes(".peon-upload-")), false);
        assert.equal(readdirSync(anchored).some((name) => name.includes(".peon-upload-")), true);
        unlinkSync(parent);
        renameSync(anchored, parent);
      },
    }),
  });
  const connection = sender(33);
  channel.negotiated(true, {}, connection);
  const requestId = randomUUID();
  const bytes = Buffer.from("restored-parent");
  channel.receive(uploadFrame(requestId, projectId, "parent/result.txt", bytes), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_ready" && frame.requestId === requestId));
  channel.receiveBinary(chunk(requestId, 0, bytes), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_credit" && frame.requestId === requestId));
  channel.receive({ type: "write_end", requestId }, connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_result" && frame.requestId === requestId));
  assert.deepEqual(readFileSync(path.join(parent, "result.txt")), bytes);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(readdirSync(parent).some((name) => name.includes(".peon-upload-")), false);
});

test("socket cancellation removes the temp from its anchored inode after an open-time parent swap", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-write-open-cancel-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "peon-write-open-cancel-outside-"));
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const parent = path.join(root, "parent");
  const anchored = path.join(root, "anchored-parent");
  mkdirSync(parent);
  const projectId = randomUUID();
  const channel = new FileWriteChannel({
    projects: { list: () => [{ projectId, dir: root }] as never },
    sandboxRoot: () => path.join(root, "sandbox"),
    idleLeaseMs: 1_000,
    openUpload: (target, maxBytes, claimedSha256) => AtomicFileUpload.open(target, maxBytes, claimedSha256, {
      beforeTemporaryOpen: () => {
        renameSync(parent, anchored);
        symlinkSync(outside, parent);
      },
    }),
  });
  const connection = sender(34);
  channel.negotiated(true, {}, connection);
  const requestId = randomUUID();
  const bytes = Buffer.from("cancelled-after-swap");
  channel.receive(uploadFrame(requestId, projectId, "parent/result.txt", bytes), connection);
  await waitFor(() => connection.frames.some((frame) => frame.type === "write_ready" && frame.requestId === requestId));
  channel.receiveBinary(chunk(requestId, 0, bytes), connection);
  channel.receive({ type: "write_cancel", requestId }, connection);
  await waitFor(() => !readdirSync(anchored).some((name) => name.includes(".peon-upload-")));
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(readdirSync(anchored).includes("result.txt"), false);
});

test("anchored move refuses a source inode swapped immediately before native commit", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-write-source-swap-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "source.txt"), "original");
  await assert.rejects(
    moveProjectFile({ dir: root }, "source.txt", "destination.txt", {
      beforeCommit: () => {
        renameSync(path.join(root, "source.txt"), path.join(root, "original-held.txt"));
        writeFileSync(path.join(root, "source.txt"), "replacement");
      },
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SOURCE_CHANGED",
  );
  assert.equal(readFileSync(path.join(root, "original-held.txt"), "utf8"), "original");
  assert.equal(readFileSync(path.join(root, "source.txt"), "utf8"), "replacement");
  assert.equal(readdirSync(root).includes("destination.txt"), false);
});
