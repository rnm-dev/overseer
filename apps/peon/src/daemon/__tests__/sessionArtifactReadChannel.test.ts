import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PROJECT_FILE_BINARY_HEADER_BYTES,
  SESSION_ARTIFACT_MAX_BYTES,
  SESSION_ARTIFACT_CAPABILITY,
  SessionArtifactReadChannel,
} from "../overseer/socket/channels/projectFileReadChannel.js";
import type { SessionRecord } from "../sessions/index.js";
import type { PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function record(id: string, dir: string): SessionRecord {
  return { id, dir } as SessionRecord;
}

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

test("session artifact reads use authoritative session identity, ranges, credit, and containment", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-session-artifact-"));
  const outside = path.join(mkdtempSync(path.join(os.tmpdir(), "peon-session-outside-")), "secret.txt");
  writeFileSync(path.join(root, "artifact.txt"), "0123456789");
  writeFileSync(outside, "secret");
  symlinkSync(outside, path.join(root, "escape.txt"));
  const sessions = { get: (id: string) => id === "session-1" ? record(id, root) : undefined };
  const output = capture();
  const channel = new SessionArtifactReadChannel({ sessions });
  assert.equal(channel.capability, SESSION_ARTIFACT_CAPABILITY);
  assert.equal(channel.handles({ type: "file_open", scope: "session" }), true);
  channel.negotiated(true, {}, output.sender);

  channel.receive({
    type: "file_open", protocol: 1, requestId: REQUEST_ID, scope: "session",
    sessionId: "session-1", path: "artifact.txt", range: { start: 2, end: 5 },
    actor: { userId: "operator", email: "operator@example.com" },
  }, output.sender);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_meta"));
  assert.equal(output.frames.find((frame) => frame.type === "file_meta")?.contentRange, "bytes 2-5/10");
  channel.receive({ type: "file_credit", requestId: REQUEST_ID, bytes: 4 }, output.sender);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_end"));
  assert.equal(Buffer.concat(output.binary.map((frame) => frame.subarray(PROJECT_FILE_BINARY_HEADER_BYTES))).toString(), "2345");

  for (const [requestId, sessionId, filePath] of [
    ["123e4567-e89b-42d3-a456-426614174001", "missing", "artifact.txt"],
    ["123e4567-e89b-42d3-a456-426614174002", "session-1", "../secret.txt"],
    ["123e4567-e89b-42d3-a456-426614174003", "session-1", "escape.txt"],
  ] as const) {
    channel.receive({
      type: "file_open", protocol: 1, requestId, scope: "session", sessionId, path: filePath,
      actor: { userId: "operator", email: "operator@example.com" },
    }, output.sender);
  }
  await waitFor(() => output.frames.filter((frame) => frame.type === "file_error").length === 3);
  assert.deepEqual(output.frames.filter((frame) => frame.type === "file_error").map((frame) => frame.code).sort(), [
    "INVALID_PATH", "PATH_ESCAPE", "UNKNOWN_SESSION",
  ].sort());
  assert.deepEqual(output.disconnects, []);
});

test("disconnect releases a stalled session artifact read", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-session-artifact-cancel-"));
  writeFileSync(path.join(root, "large.bin"), Buffer.alloc(128 * 1024));
  const output = capture();
  const channel = new SessionArtifactReadChannel({ sessions: { get: () => record("session-1", root) } });
  channel.negotiated(true, {}, output.sender);
  channel.receive({
    type: "file_open", protocol: 1, requestId: REQUEST_ID, scope: "session",
    sessionId: "session-1", path: "large.bin",
    actor: { userId: "operator", email: "operator@example.com" },
  }, output.sender);
  await waitFor(() => output.frames.some((frame) => frame.type === "file_meta"));
  channel.disconnected(false);
  channel.receive({ type: "file_credit", requestId: REQUEST_ID, bytes: 1024 }, output.sender);
  assert.equal(output.binary.length, 0);
});

test("session artifacts force active content to generic bytes and reject malformed ranges", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-session-artifact-mime-"));
  for (const name of ["index.html", "vector.svg", "script.js"]) writeFileSync(path.join(root, name), "active");
  const output = capture();
  const channel = new SessionArtifactReadChannel({ sessions: { get: () => record("session-1", root) } });
  channel.negotiated(true, {}, output.sender);

  for (const [index, name] of ["index.html", "vector.svg", "script.js"].entries()) {
    channel.receive({
      type: "file_open", protocol: 1, requestId: `123e4567-e89b-42d3-a456-42661417401${index}`,
      scope: "session", sessionId: "session-1", path: name,
      actor: { userId: "operator", email: "operator@example.com" },
    }, output.sender);
  }
  for (const [index, range] of [{ start: -1 }, { start: 3, end: 2 }, { start: 1.5 }].entries()) {
    channel.receive({
      type: "file_open", protocol: 1, requestId: `123e4567-e89b-42d3-a456-42661417402${index}`,
      scope: "session", sessionId: "session-1", path: "index.html", range,
      actor: { userId: "operator", email: "operator@example.com" },
    }, output.sender);
  }
  await waitFor(() => output.frames.filter((frame) => frame.type === "file_meta").length === 3);
  assert.deepEqual(output.frames.filter((frame) => frame.type === "file_meta").map((frame) => frame.contentType), [
    "application/octet-stream", "application/octet-stream", "application/octet-stream",
  ]);
  assert.deepEqual(output.frames.filter((frame) => frame.type === "file_error").map((frame) => frame.code), [
    "INVALID_RANGE", "INVALID_RANGE", "INVALID_RANGE",
  ]);
});

test("session artifact open rejects swaps, deletion, directories, and oversized files before metadata", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-session-artifact-race-"));
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  writeFileSync(first, "first");
  writeFileSync(second, "second");
  mkdirSync(path.join(root, "directory"));
  let resolves = 0;
  const output = capture();
  const channel = new SessionArtifactReadChannel({
    sessions: { get: () => record("session-1", root) },
    resolvePath: (_base, requested) => requested === "swapped.txt" ? (++resolves === 1 ? first : second) : path.join(root, requested),
    fileSystem: {
      open: async (file, flags) => {
        if (String(file).endsWith("oversized.bin")) {
          return {
            stat: async () => ({ isFile: () => true, isDirectory: () => false, size: SESSION_ARTIFACT_MAX_BYTES + 1, dev: 1, ino: 1 }),
            close: async () => {},
          } as never;
        }
        return await import("node:fs/promises").then((module) => module.open(file, flags));
      },
      stat: async (file) => {
        if (String(file).endsWith("deleted.txt")) {
          const error = new Error("deleted") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        if (String(file).endsWith("oversized.bin")) return { dev: 1, ino: 1 } as never;
        return await import("node:fs/promises").then((module) => module.stat(file));
      },
    },
  });
  channel.negotiated(true, {}, output.sender);
  for (const [index, artifactPath] of ["swapped.txt", "deleted.txt", "directory", "oversized.bin"].entries()) {
    if (artifactPath === "deleted.txt") writeFileSync(path.join(root, artifactPath), "gone");
    channel.receive({
      type: "file_open", protocol: 1, requestId: `123e4567-e89b-42d3-a456-42661417403${index}`,
      scope: "session", sessionId: "session-1", path: artifactPath,
      actor: { userId: "operator", email: "operator@example.com" },
    }, output.sender);
  }
  await waitFor(() => output.frames.filter((frame) => frame.type === "file_error").length === 4);
  assert.deepEqual(output.frames.filter((frame) => frame.type === "file_error").map((frame) => frame.code).sort(), [
    "FILE_CHANGED", "FILE_TOO_LARGE", "IS_DIRECTORY", "NOT_FOUND",
  ].sort());
  assert.equal(output.frames.some((frame) => frame.type === "file_meta"), false);
});
