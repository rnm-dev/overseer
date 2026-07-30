import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PROJECT_FILE_BINARY_HEADER_BYTES,
  ProjectFileReadChannel,
  SANDBOX_FILE_READ_CAPABILITY,
  SandboxFileReadChannel,
} from "../overseer/socket/channels/projectFileReadChannel.js";
import { PeonSocketMultiplexer, type PeonSocketFrame, type PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function capture() {
  const frames: PeonSocketFrame[] = [];
  const binary: Buffer[] = [];
  const disconnects: string[] = [];
  const sender: PeonSocketSender = {
    durable: false,
    send: (frame) => { frames.push(frame); return true; },
    sendBinary: (frame) => { binary.push(Buffer.from(frame)); return true; },
    sendDurable: () => ({ accepted: false, code: "PERSIST_FAILED", error: "disabled" }),
    disconnect: (reason) => disconnects.push(reason),
  };
  return { frames, binary, disconnects, sender };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

test("sandbox channel accepts relative and absolute contained paths and streams under credit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-sandbox-file-"));
  const absolute = path.join(root, "attachment.txt");
  writeFileSync(absolute, "attachment");
  for (const [requestId, filePath] of [
    [REQUEST_ID, "attachment.txt"],
    ["123e4567-e89b-42d3-a456-426614174001", absolute],
  ] as const) {
    const channel = new SandboxFileReadChannel({ sandboxRoot: () => root });
    const output = capture();
    assert.equal(channel.capability, SANDBOX_FILE_READ_CAPABILITY);
    assert.equal(channel.handles({ type: "file_open", scope: "sandbox" }), true);
    assert.equal(channel.handles({ type: "file_open", projectId: "project" }), false);
    channel.negotiated(true, {}, output.sender);
    channel.receive({
      type: "file_open", protocol: 1, requestId, scope: "sandbox", path: filePath,
      actor: { userId: "user", email: "user@example.com" },
    }, output.sender);
    await waitFor(() => output.frames.some((frame) => frame.type === "file_meta"));
    channel.receive({ type: "file_credit", requestId, bytes: 10 }, output.sender);
    await waitFor(() => output.frames.some((frame) => frame.type === "file_end"));
    assert.equal(Buffer.concat(output.binary.map((frame) => frame.subarray(PROJECT_FILE_BINARY_HEADER_BYTES))).toString(), "attachment");
    assert.deepEqual(output.disconnects, []);
  }
});

test("sandbox channel reports disabled roots, escapes, external symlinks, and missing files safely", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-sandbox-security-"));
  const external = path.join(mkdtempSync(path.join(os.tmpdir(), "peon-sandbox-external-")), "secret");
  writeFileSync(external, "secret");
  symlinkSync(external, path.join(root, "escape"));
  const output = capture();
  const open = (channel: SandboxFileReadChannel, requestId: string, filePath: string) => {
    channel.negotiated(true, {}, output.sender);
    channel.receive({
      type: "file_open", protocol: 1, requestId, scope: "sandbox", path: filePath,
      actor: { userId: "user", email: "user@example.com" },
    }, output.sender);
  };
  open(new SandboxFileReadChannel({ sandboxRoot: () => "" }), REQUEST_ID, "file");
  open(new SandboxFileReadChannel({ sandboxRoot: () => root }), "123e4567-e89b-42d3-a456-426614174001", "../secret");
  open(new SandboxFileReadChannel({ sandboxRoot: () => root }), "123e4567-e89b-42d3-a456-426614174002", "escape");
  open(new SandboxFileReadChannel({ sandboxRoot: () => root }), "123e4567-e89b-42d3-a456-426614174003", "missing");
  await waitFor(() => output.frames.filter((frame) => frame.type === "file_error").length === 4);
  assert.deepEqual(output.frames.map((frame) => frame.code).sort(), [
    "FILES_DISABLED", "NOT_FOUND", "PATH_ESCAPE", "PATH_ESCAPE",
  ].sort());
  assert.deepEqual(output.binary, []);
  assert.deepEqual(output.disconnects, []);
});

test("sandbox channel rejects a contained FIFO without blocking its idle lease", async (t) => {
  if (process.platform === "win32") return t.skip("named FIFO fixture requires POSIX mkfifo");
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-sandbox-fifo-"));
  const fifo = path.join(root, "attachment.pipe");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    return t.skip("mkfifo is unavailable");
  }
  const output = capture();
  const channel = new SandboxFileReadChannel({ sandboxRoot: () => root, idleLeaseMs: 1_000 });
  channel.negotiated(true, {}, output.sender);
  channel.receive({
    type: "file_open", protocol: 1, requestId: REQUEST_ID, scope: "sandbox", path: fifo,
    actor: { userId: "user", email: "user@example.com" },
  }, output.sender);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_error"));
  assert.equal(output.frames.find((frame) => frame.type === "file_error")?.code, "NOT_FILE");
  assert.deepEqual(output.binary, []);
  assert.deepEqual(output.disconnects, []);
});

test("shared transfer multiplexer routes flow control to the channel that owns the request", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-sandbox-multiplex-"));
  writeFileSync(path.join(root, "attachment"), "sandbox");
  const output = capture();
  const multiplexer = new PeonSocketMultiplexer([
    new ProjectFileReadChannel({ projects: { list: () => [] } }),
    new SandboxFileReadChannel({ sandboxRoot: () => root }),
  ]);
  multiplexer.negotiated({
    capabilities: ["project-file-read-v1", "sandbox-file-read-v1"],
  }, output.sender);
  assert.equal(multiplexer.receive({
    type: "file_open", protocol: 1, requestId: REQUEST_ID, scope: "sandbox", path: "attachment",
    actor: { userId: "user", email: "user@example.com" },
  }, output.sender), true);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_meta"));
  assert.equal(multiplexer.receive({ type: "file_credit", requestId: REQUEST_ID, bytes: 7 }, output.sender), true);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_end"));
  assert.equal(Buffer.concat(output.binary.map((frame) => frame.subarray(PROJECT_FILE_BINARY_HEADER_BYTES))).toString(), "sandbox");
  assert.deepEqual(output.disconnects, []);
});
