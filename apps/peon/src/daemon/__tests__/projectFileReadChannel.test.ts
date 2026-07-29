import assert from "node:assert/strict";
import { promises as fs, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PROJECT_FILE_BINARY_HEADER_BYTES,
  PROJECT_FILE_MAX_CHUNK_BYTES,
  PROJECT_FILE_READ_CAPABILITY,
  ProjectFileReadChannel,
} from "../overseer/socket/channels/projectFileReadChannel.js";
import type { PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";
import type { ProjectRecord } from "../projects/contracts.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function project(projectId: string, dir: string): ProjectRecord {
  return { projectId, key: "mutable-key", label: "Project", dir, lastSyncedAt: 1 };
}

function capture(binaryResult: (attempt: number) => boolean = () => true) {
  const frames: PeonSocketFrame[] = [];
  const binary: Buffer[] = [];
  const disconnects: string[] = [];
  let binaryAttempts = 0;
  const sender: PeonSocketSender = {
    durable: false,
    send: (frame) => { frames.push(frame); return true; },
    sendBinary: (frame) => {
      binaryAttempts += 1;
      if (!binaryResult(binaryAttempts)) return false;
      binary.push(Buffer.from(frame));
      return true;
    },
    sendDurable: () => ({ accepted: false, code: "PERSIST_FAILED", error: "disabled" }),
    disconnect: (reason) => disconnects.push(reason),
  };
  return { frames, binary, disconnects, sender, get binaryAttempts() { return binaryAttempts; } };
}

async function waitFor(predicate: () => boolean, message = "condition was not met"): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function payload(frame: Buffer): Buffer {
  assert.equal(frame[0], 1);
  assert.equal(frame[1], 1);
  return frame.subarray(PROJECT_FILE_BINARY_HEADER_BYTES);
}

test("opens by immutable project ID and streams range bytes only under credit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-file-"));
  writeFileSync(path.join(root, "page.html"), "0123456789");
  const channel = new ProjectFileReadChannel({ projects: { list: () => [project("project-id", root)] } });
  const output = capture();

  assert.equal(channel.capability, PROJECT_FILE_READ_CAPABILITY);
  channel.negotiated(true, {}, output.sender);
  channel.receive({
    type: "file_open", protocol: 1, requestId: REQUEST_ID, projectId: "project-id",
    relativePath: "page.html", actor: { userId: "user", email: "user@example.com" },
    range: { start: 2, end: 7 },
  }, output.sender);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_meta"));
  assert.deepEqual(output.frames[0], {
    type: "file_meta", requestId: REQUEST_ID, status: 206,
    contentType: "text/html; charset=utf-8", contentLength: 6, acceptRanges: "bytes",
    etag: output.frames[0]?.etag, lastModified: output.frames[0]?.lastModified,
    contentRange: "bytes 2-7/10",
  });
  assert.deepEqual(output.binary, [], "Peon must wait for file_credit");

  channel.receive({ type: "file_credit", requestId: REQUEST_ID, bytes: 3 }, output.sender);
  await waitFor(() => output.binary.length === 1);
  assert.equal(payload(output.binary[0]!).toString(), "234");
  assert.equal(output.binary[0]!.readUInt32BE(18), 0);
  assert.equal(output.frames.some((frame) => frame.type === "file_end"), false);

  channel.receive({ type: "file_credit", requestId: REQUEST_ID, bytes: 3 }, output.sender);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_end"));
  assert.equal(Buffer.concat(output.binary.map(payload)).toString(), "234567");
  assert.equal(output.binary[1]!.readUInt32BE(18), 1);
  // Overseer replenishes credit after accepting the final chunk. That grant
  // races with file_end in the opposite direction and must be harmless.
  channel.receive({ type: "file_credit", requestId: REQUEST_ID, bytes: 3 }, output.sender);
  assert.deepEqual(output.disconnects, []);
});

test("revalidates the opened inode after a concurrent symlink swap", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-file-race-"));
  const external = mkdtempSync(path.join(os.tmpdir(), "peon-project-file-race-external-"));
  mkdirSync(path.join(root, "sub"));
  writeFileSync(path.join(root, "sub", "file"), "inside");
  writeFileSync(path.join(external, "file"), "outside");
  let swapped = false;
  const channel = new ProjectFileReadChannel({
    projects: { list: () => [project("project-id", root)] },
    fileSystem: {
      open: async (file, flags) => {
        if (!swapped) {
          swapped = true;
          renameSync(path.join(root, "sub"), path.join(root, "sub-original"));
          symlinkSync(external, path.join(root, "sub"), "dir");
        }
        return fs.open(file, flags);
      },
      stat: (file) => fs.stat(file),
    },
  });
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  channel.receive({
    type: "file_open", protocol: 1, requestId: REQUEST_ID, projectId: "project-id",
    relativePath: "sub/file", actor: { userId: "user", email: "user@example.com" },
  }, output.sender);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_error"));
  assert.equal(output.frames[0]?.code, "PATH_ESCAPE");
  assert.deepEqual(output.binary, []);
  assert.deepEqual(output.disconnects, []);
});

test("rejects unknown projects, unsafe paths, external symlinks, directories, and invalid ranges", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-file-security-"));
  const external = path.join(mkdtempSync(path.join(os.tmpdir(), "peon-project-file-external-")), "secret");
  writeFileSync(external, "secret");
  symlinkSync(external, path.join(root, "escape"));
  writeFileSync(path.join(root, "small"), "abc");
  const channel = new ProjectFileReadChannel({ projects: { list: () => [project("project-id", root)] } });
  const output = capture();
  channel.negotiated(true, {}, output.sender);

  const open = (requestId: string, overrides: PeonSocketFrame) => channel.receive({
    type: "file_open", protocol: 1, requestId, projectId: "project-id", relativePath: "small",
    actor: { userId: "user", email: "user@example.com" }, ...overrides,
  }, output.sender);
  open("123e4567-e89b-42d3-a456-426614174001", { projectId: "missing" });
  open("123e4567-e89b-42d3-a456-426614174002", { relativePath: "../secret" });
  open("123e4567-e89b-42d3-a456-426614174003", { relativePath: "escape" });
  open("123e4567-e89b-42d3-a456-426614174004", { relativePath: "." });
  open("123e4567-e89b-42d3-a456-426614174005", { range: { start: 3 } });
  await waitFor(() => output.frames.filter((frame) => frame.type === "file_error").length === 5);

  assert.deepEqual(output.frames.map((frame) => frame.code).sort(), [
    "INVALID_PROJECT_PATH", "IS_DIRECTORY", "PATH_ESCAPE", "RANGE_NOT_SATISFIABLE", "UNKNOWN_PROJECT",
  ].sort());
  assert.deepEqual(output.binary, []);
  assert.deepEqual(output.disconnects, []);
});

test("bounds chunks, retries socket backpressure, and cancellation stops an active read", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-file-pressure-"));
  const bytes = Buffer.alloc(PROJECT_FILE_MAX_CHUNK_BYTES + 10, 7);
  writeFileSync(path.join(root, "large.bin"), bytes);
  const channel = new ProjectFileReadChannel({ projects: { list: () => [project("project-id", root)] } });
  const output = capture((attempt) => attempt !== 1);
  channel.negotiated(true, {}, output.sender);
  channel.receive({
    type: "file_open", protocol: 1, requestId: REQUEST_ID, projectId: "project-id",
    relativePath: "large.bin", actor: { userId: "user", email: "user@example.com" },
  }, output.sender);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_meta"));
  channel.receive({ type: "file_credit", requestId: REQUEST_ID, bytes: bytes.length }, output.sender);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_end"));
  assert.ok(output.binaryAttempts >= 3, "the rejected first send should be retried");
  assert.ok(output.binary.every((frame) => payload(frame).length <= PROJECT_FILE_MAX_CHUNK_BYTES));
  assert.deepEqual(Buffer.concat(output.binary.map(payload)), bytes);

  const cancelId = "123e4567-e89b-42d3-a456-426614174009";
  channel.receive({
    type: "file_open", protocol: 1, requestId: cancelId, projectId: "project-id",
    relativePath: "large.bin", actor: { userId: "user", email: "user@example.com" },
  }, output.sender);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_meta" && frame.requestId === cancelId));
  channel.receive({ type: "file_cancel", requestId: cancelId, reason: "browser closed" }, output.sender);
  channel.receive({ type: "file_cancel", requestId: cancelId, reason: "late duplicate" }, output.sender);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output.binary.some((frame) => frame.subarray(2, 18).equals(Buffer.from(cancelId.replaceAll("-", ""), "hex"))), false);
  assert.deepEqual(output.disconnects, []);
});

test("expires stalled transfers and exponentially bounds backpressure retries", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-file-stalled-"));
  writeFileSync(path.join(root, "stalled.bin"), Buffer.alloc(1024));
  const channel = new ProjectFileReadChannel({
    projects: { list: () => [project("project-id", root)] },
    idleLeaseMs: 30,
  });
  const output = capture(() => false);
  channel.negotiated(true, {}, output.sender);
  channel.receive({
    type: "file_open", protocol: 1, requestId: REQUEST_ID, projectId: "project-id",
    relativePath: "stalled.bin", actor: { userId: "user", email: "user@example.com" },
  }, output.sender);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_meta"));
  channel.receive({ type: "file_credit", requestId: REQUEST_ID, bytes: 1024 }, output.sender);
  await waitFor(() => output.disconnects.includes("project file transfer timed out"));
  assert.ok(output.binaryAttempts >= 2);
  assert.ok(output.binaryAttempts <= 4, `unexpected retry storm: ${output.binaryAttempts} attempts`);
});
