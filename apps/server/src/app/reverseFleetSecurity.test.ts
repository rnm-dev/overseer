import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("reverse WebSocket is control/realtime only and exposes no transfer endpoint", async () => {
  const [index, socket, projects, sessions] = await Promise.all([
    readFile(new URL("../index.ts", import.meta.url), "utf8"),
    readFile(new URL("../adapters/peonSocket.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/peons/projects.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/peons/sessions.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(index, /attachPeonTransferSocket|transfer\/ws/);
  assert.doesNotMatch(socket, /file-transfer|project-file-read-v1|sandbox-file-read-v1|file-write-v1|session-artifact-v1/);
  assert.doesNotMatch(projects, /peonTransfer|FileTransport/);
  assert.doesNotMatch(sessions, /SessionArtifactTransport|peonFileStream/);
});
