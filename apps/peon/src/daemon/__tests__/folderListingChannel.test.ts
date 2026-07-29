import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FOLDER_LISTING_CAPABILITY,
  FOLDER_LISTING_MAX_PAGE_BYTES,
  FolderListingChannel,
} from "../overseer/socket/channels/folderListingChannel.js";
import { PEON_SOCKET_MAX_FRAME_BYTES, type PeonSocketFrame, type PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";
import type { ProjectRecord } from "../projects/contracts.js";

function capture(sendResult = true) {
  const frames: PeonSocketFrame[] = [];
  const durableFrames: PeonSocketFrame[] = [];
  const disconnects: string[] = [];
  const sender: PeonSocketSender = {
    durable: true,
    send: (frame) => { frames.push(frame); return sendResult; },
    sendBinary: () => sendResult,
    sendDurable: (frame) => {
      durableFrames.push(frame);
      return { accepted: true, epoch: "epoch", cursor: "cursor", messageId: "message" };
    },
    disconnect: (reason) => disconnects.push(reason),
  };
  return { frames, durableFrames, disconnects, sender };
}

async function waitForFrame(output: ReturnType<typeof capture>, predicate: (frame: PeonSocketFrame) => boolean): Promise<PeonSocketFrame> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = output.frames.find(predicate);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for frame: ${JSON.stringify(output.frames)}`);
}

function project(projectId: string, dir: string): ProjectRecord {
  return { projectId, key: "project-key", label: "Project", dir, lastSyncedAt: 1 };
}

test("lists a project root by immutable ID with deterministic file and directory entries", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-folder-listing-"));
  mkdirSync(path.join(root, "Beta"));
  mkdirSync(path.join(root, "alpha"));
  writeFileSync(path.join(root, "z.txt"), "z");
  writeFileSync(path.join(root, ".hidden"), "hidden");
  symlinkSync(path.join(root, "alpha"), path.join(root, "directory-link"));
  symlinkSync(path.join(root, "z.txt"), path.join(root, "file-link"));
  symlinkSync(path.join(root, "missing"), path.join(root, "broken-link"));
  const channel = new FolderListingChannel({ projects: { list: () => [project("project-id", root)] } });
  const output = capture();

  assert.equal(channel.capability, FOLDER_LISTING_CAPABILITY);
  channel.negotiated(true, {}, output.sender);
  channel.receive({ type: "folder_list_request", requestId: "project-root", projectId: "project-id" }, output.sender);
  const frame = await waitForFrame(output, (candidate) => candidate.type === "folder_list_page");

  assert.equal(frame.path, root);
  assert.equal(frame.projectId, "project-id");
  assert.deepEqual(frame.entries, [
    { name: "alpha", type: "directory" },
    { name: "Beta", type: "directory" },
    { name: "directory-link", type: "directory" },
    { name: ".hidden", type: "file" },
    { name: "file-link", type: "file" },
    { name: "z.txt", type: "file" },
  ]);
  assert.equal(frame.hasMore, false);
  assert.deepEqual(output.durableFrames, [], "folder listings must remain ephemeral");
});

test("absolute paths take precedence and invalid selectors return stable errors", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-folder-selection-"));
  const file = path.join(root, "file.txt");
  writeFileSync(file, "file");
  const channel = new FolderListingChannel({ projects: { list: () => [] } });
  const output = capture();
  channel.negotiated(true, {}, output.sender);

  channel.receive({ type: "folder_list_request", requestId: "absolute", projectId: "unknown", path: root }, output.sender);
  const absolute = await waitForFrame(output, (frame) => frame.requestId === "absolute");
  assert.equal(absolute.type, "folder_list_page");
  assert.equal(absolute.projectId, null);

  channel.receive({ type: "folder_list_request", requestId: "relative", path: "relative/path" }, output.sender);
  channel.receive({ type: "folder_list_request", requestId: "missing" }, output.sender);
  channel.receive({ type: "folder_list_request", requestId: "unknown", projectId: "missing" }, output.sender);
  channel.receive({ type: "folder_list_request", requestId: "file", path: file }, output.sender);
  await waitForFrame(output, (frame) => frame.requestId === "file");

  const errors = Object.fromEntries(output.frames.filter((frame) => frame.type === "folder_list_error").map((frame) => [frame.requestId, frame.code]));
  assert.deepEqual(errors, {
    relative: "BAD_REQUEST",
    missing: "BAD_REQUEST",
    unknown: "UNKNOWN_PROJECT",
    file: "NOT_DIRECTORY",
  });

  channel.receive({ type: "folder_list_request", requestId: "invalid-limit", path: root, limit: 0 }, output.sender);
  assert.equal(output.frames.at(-1)?.code, "BAD_REQUEST");
  channel.receive({ type: "folder_list_request", requestId: "x".repeat(201), path: root }, output.sender);
  assert.deepEqual(output.frames.at(-1), {
    type: "folder_list_error",
    requestId: null,
    code: "BAD_REQUEST",
    error: "requestId is required",
  });
});

test("unreadable target directories return FORBIDDEN", async (t) => {
  if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) return t.skip();
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-folder-forbidden-"));
  chmodSync(root, 0o000);
  const channel = new FolderListingChannel();
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  try {
    channel.receive({ type: "folder_list_request", requestId: "forbidden", path: root }, output.sender);
    const frame = await waitForFrame(output, (candidate) => candidate.requestId === "forbidden");
    assert.equal(frame.code, "FORBIDDEN");
  } finally {
    chmodSync(root, 0o700);
  }
});

test("pages a frozen listing with request-scoped cursors and supports cancellation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-folder-pages-"));
  for (const name of ["a", "b", "c"]) writeFileSync(path.join(root, name), name);
  const channel = new FolderListingChannel();
  const output = capture();
  channel.negotiated(true, {}, output.sender);

  channel.receive({ type: "folder_list_request", requestId: "paged", path: root, limit: 1 }, output.sender);
  const first = await waitForFrame(output, (frame) => frame.type === "folder_list_page" && frame.requestId === "paged");
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, "string");

  channel.receive({ type: "folder_list_request", requestId: "competing", path: root }, output.sender);
  assert.equal(output.frames.at(-1)?.code, "SYNC_IN_PROGRESS");
  channel.receive({ type: "folder_list_request", requestId: "paged", cursor: "wrong", limit: 1 }, output.sender);
  assert.equal(output.frames.at(-1)?.code, "BAD_CURSOR");

  channel.receive({ type: "folder_list_request", requestId: "paged", cursor: first.nextCursor, limit: 1 }, output.sender);
  const pages = output.frames.filter((frame) => frame.type === "folder_list_page" && frame.requestId === "paged");
  const second = pages[1]!;
  assert.deepEqual(second.entries, [{ name: "b", type: "file" }]);
  channel.receive({ type: "folder_list_cancel", requestId: "paged" }, output.sender);
  assert.equal(output.frames.at(-1)?.type, "folder_list_cancelled");

  channel.receive({ type: "folder_list_request", requestId: "after-cancel", path: root }, output.sender);
  await waitForFrame(output, (frame) => frame.type === "folder_list_page" && frame.requestId === "after-cancel");
});

test("expiry and disconnect release active listings and unnegotiated traffic disconnects", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-folder-lease-"));
  for (const name of ["a", "b"]) writeFileSync(path.join(root, name), name);
  const channel = new FolderListingChannel({ leaseMs: 15 });
  const output = capture();

  channel.receive({ type: "folder_list_request", requestId: "early", path: root }, output.sender);
  assert.deepEqual(output.disconnects, ["unnegotiated folder listing frame"]);
  channel.negotiated(true, {}, output.sender);
  channel.receive({ type: "folder_list_request", requestId: "expires", path: root, limit: 1 }, output.sender);
  await waitForFrame(output, (frame) => frame.requestId === "expires" && frame.type === "folder_list_page");
  await new Promise((resolve) => setTimeout(resolve, 30));
  channel.receive({ type: "folder_list_request", requestId: "after-expiry", path: root }, output.sender);
  await waitForFrame(output, (frame) => frame.requestId === "after-expiry" && frame.type === "folder_list_page");

  channel.disconnected(false);
  channel.receive({ type: "folder_list_request", requestId: "disconnected", path: root }, output.sender);
  assert.equal(output.disconnects.at(-1), "unnegotiated folder listing frame");
});

test("socket and listing limits leave bounded headroom and backpressure disconnects", async () => {
  assert.equal(PEON_SOCKET_MAX_FRAME_BYTES, 1024 * 1024);
  assert.ok(FOLDER_LISTING_MAX_PAGE_BYTES < PEON_SOCKET_MAX_FRAME_BYTES);
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-folder-pressure-"));
  writeFileSync(path.join(root, "file"), "file");
  const channel = new FolderListingChannel();
  const output = capture(false);
  channel.negotiated(true, {}, output.sender);
  channel.receive({ type: "folder_list_request", requestId: "pressure", path: root }, output.sender);
  await waitForFrame(output, (frame) => frame.requestId === "pressure");
  assert.deepEqual(output.disconnects, ["folder listing backpressure limit exceeded"]);
});
