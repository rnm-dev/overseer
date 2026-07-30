import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionArtifactChannel } from "../overseer/socket/channels/sessionArtifactChannel.js";
import type { SessionRecord } from "../sessions/index.js";
import type { PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

test("session artifact metadata and preview handoff remain session-contained", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-session-artifact-operation-"));
  writeFileSync(path.join(root, "report.txt"), "report");
  const frames: PeonSocketFrame[] = [];
  const previews: Array<{ id: string; path: string; author?: string }> = [];
  const sender: PeonSocketSender = {
    durable: false,
    send: (frame) => { frames.push(frame); return true; },
    sendBinary: () => true,
    sendDurable: () => ({ accepted: false, code: "PERSIST_FAILED", error: "disabled" }),
    disconnect: (reason) => assert.fail(reason),
  };
  const channel = new SessionArtifactChannel({
    get: (id) => id === "session-1" ? ({ id, dir: root } as SessionRecord) : undefined,
    preview: (id, filePath, author) => {
      previews.push({ id, path: filePath, author });
      return { type: "preview", name: path.basename(filePath), author };
    },
  });
  channel.negotiated(true, {}, sender);
  const request = (operation: string, artifactPath: string, requestId = REQUEST_ID) => channel.receive({
    type: "artifact_request", protocol: 1, requestId, sessionId: "session-1",
    operation, path: artifactPath,
    actor: { userId: "operator", email: "operator@example.com" },
  }, sender);

  request("view", "report.txt");
  request("preview", "report.txt", "123e4567-e89b-42d3-a456-426614174001");
  request("view", "../secret", "123e4567-e89b-42d3-a456-426614174002");

  assert.equal(frames[0]?.status, 200);
  assert.deepEqual(frames[0]?.body, {
    size: 6,
    mtimeMs: (frames[0]?.body as { mtimeMs: number }).mtimeMs,
    binary: false,
    truncated: false,
    content: "report",
    path: "report.txt",
  });
  assert.equal(frames[1]?.status, 201);
  assert.equal(frames[2]?.code, "INVALID_PATH");
  assert.deepEqual(previews, [{ id: "session-1", path: realpathSync(path.join(root, "report.txt")), author: "operator@example.com" }]);
});
