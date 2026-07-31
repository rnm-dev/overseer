import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import WebSocket from "ws";
import { bindPeon, mintCredential, revokeCredentialForPeon } from "./credentials.js";
import { initDb, query } from "./db.js";
import { attachPeonSocket } from "./peonSocket.js";
import { evictPeonTransferConnectionsBelowGeneration, isPeonTransferConnected } from "./peonTransferConnections.js";
import { attachPeonTransferSocket, PEON_TRANSFER_SOCKET_PATH } from "./peonTransferSocket.js";
import { registry, toView, type PeonRecord } from "./registry.js";
import { encodePeonFileChunk, openPeonProjectFile, openPeonSandboxFile, openPeonSessionArtifact, PeonFileStreamError, requestPeonSessionArtifact } from "./peonFileStream.js";
import { sessionArtifactContentType } from "./modules/projects/projectFileHttp.js";
import { PATH_ESCAPE_PUBLIC_MESSAGE } from "./fileErrorSafety.js";
import { peonsRouter } from "./routes/peons.js";
import {
  isolateProjectFileResponse,
  projectFileContentType,
  projectFileProxyQuery,
  projectFileReadChannel,
  PROJECT_FILE_CSP,
} from "./modules/projects/index.js";

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

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 1006, reason: "" });
  return new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}

function message(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>)));
}

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("timed out waiting for server state"));
    }, timeoutMs);
    const interval = setInterval(() => {
      if (!predicate()) return;
      clearTimeout(timeout);
      clearInterval(interval);
      resolve();
    }, 5);
  });
}

async function transferHello(ws: WebSocket, peonId?: string, capabilities = ["project-file-read-v1"]): Promise<void> {
  const reply = message(ws);
  ws.send(JSON.stringify({ type: "hello", protocol: 1, channel: "file-transfer", capabilities, ...(peonId ? { peonId } : {}) }));
  assert.deepEqual(await reply, { type: "hello_ack", protocol: 1, channel: "file-transfer", capabilities });
}

async function controlHello(ws: WebSocket): Promise<void> {
  const reply = message(ws);
  ws.send(JSON.stringify({ type: "hello", protocol: 1 }));
  assert.deepEqual(await reply, { type: "hello_ack", protocol: 1, capabilities: [] });
}

async function fixture(suffix: string): Promise<{ record: PeonRecord; token: string }> {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);
  const workspaceId = `transfer-workspace-${suffix}`;
  const peonId = `transfer-peon-${suffix}`;
  await query(
    `INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES ($1, 'Transfer socket', $2, 'owner', $3)`,
    [workspaceId, `transfer-${suffix}`, Date.now()],
  );
  const { credential, token } = await mintCredential(workspaceId, "Transfer Peon", "owner");
  assert.equal(await bindPeon(credential.id, peonId), true);
  const record = await registry.register({
    peonId, credentialId: credential.id, workspaceId, name: "Transfer Peon",
    hostname: null, address: "127.0.0.1", controlPort: 4570, publicUrl: null,
    protocol: 1, capabilities: [], token, load: null,
  });
  return { record, token };
}

test("Peon transfer WebSocket authenticates, handshakes, replaces generations, and stays separate from control presence", async () => {
  const { record, token } = await fixture("lifecycle");
  const server = http.createServer();
  const controlWss = attachPeonSocket(server);
  const transferWss = attachPeonTransferSocket(server, { helloTimeoutMs: 50 });
  const port = await listen(server);
  const transferUrl = `ws://127.0.0.1:${port}${PEON_TRANSFER_SOCKET_PATH}`;
  const controlUrl = `ws://127.0.0.1:${port}/api/v1/peons/ws`;

  await assert.rejects(open(transferUrl, "invalid-token"), /401/);

  const unready = await open(transferUrl, token);
  assert.equal(isPeonTransferConnected(record.peonId), false);
  assert.deepEqual(await closed(unready), { code: 1008, reason: "hello timeout" });

  const control = await open(controlUrl, token);
  await controlHello(control);
  assert.equal(toView(record).online, true);

  const first = await open(transferUrl, token);
  await transferHello(first, record.peonId);
  assert.equal(isPeonTransferConnected(record.peonId), true);
  assert.equal(toView(record).transferConnected, true);
  assert.equal(typeof toView(record).transferConnectedAt, "number");

  const firstClosed = closed(first);
  const second = await open(transferUrl, token);
  await transferHello(second);
  assert.deepEqual(await firstClosed, { code: 4001, reason: "replaced by a newer transfer connection" });
  assert.equal(isPeonTransferConnected(record.peonId), true, "a stale close must not release its replacement");
  assert.equal(toView(record).online, true, "transfer replacement must not affect control presence");

  const unsupported = closed(second);
  second.send(JSON.stringify({ type: "file_request" }));
  assert.deepEqual(await unsupported, { code: 1008, reason: "invalid file transfer frame" });
  await waitFor(() => !isPeonTransferConnected(record.peonId));
  assert.equal(isPeonTransferConnected(record.peonId), false);
  assert.equal(toView(record).transferConnected, false);
  assert.equal(toView(record).online, true);

  const current = await open(transferUrl, token);
  await transferHello(current);
  const controlClosed = closed(control);
  const transferClosed = closed(current);
  await revokeCredentialForPeon(record.workspaceId, record.peonId);
  await Promise.all([controlClosed, transferClosed]);
  assert.equal(toView(record).online, false);
  assert.equal(isPeonTransferConnected(record.peonId), false);
  await assert.rejects(open(transferUrl, token), /401/);

  await new Promise<void>((resolve) => transferWss.close(() => resolve()));
  await new Promise<void>((resolve) => controlWss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("Peon transfer WebSocket terminates a connection that stops answering ping frames", async () => {
  const { record, token } = await fixture("heartbeat");
  const server = http.createServer();
  const transferWss = attachPeonTransferSocket(server, { connectionCheckMs: 20 });
  const port = await listen(server);
  const ws = await open(`ws://127.0.0.1:${port}${PEON_TRANSFER_SOCKET_PATH}`, token);
  await transferHello(ws);
  assert.equal(isPeonTransferConnected(record.peonId), true);

  // Simulate a half-open client: the TCP socket remains established but cannot
  // consume the server ping and therefore cannot emit the automatic pong.
  const socket = (ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
  socket.pause();
  const closeResult = closed(ws);
  await waitFor(() => !isPeonTransferConnected(record.peonId));
  socket.resume();
  const result = await closeResult;
  assert.equal(result.code, 1006);
  assert.equal(isPeonTransferConnected(record.peonId), false);

  await new Promise<void>((resolve) => transferWss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("project file service opens by stable project ID and streams correlated binary chunks", async () => {
  const { record, token } = await fixture("file-stream");
  const server = http.createServer();
  const transferWss = attachPeonTransferSocket(server);
  const port = await listen(server);
  const ws = await open(`ws://127.0.0.1:${port}${PEON_TRANSFER_SOCKET_PATH}`, token);
  await transferHello(ws);

  const openFramePromise = message(ws);
  const openedPromise = openPeonProjectFile({
    peonId: record.peonId,
    projectId: "stable-project-id",
    relativePath: "dist/index.html",
    actor: { userId: "operator-id", email: "operator@example.com" },
    range: { start: 2, end: 10 },
  });
  const openFrame = await openFramePromise;
  assert.equal(openFrame.type, "file_open");
  assert.equal(openFrame.projectId, "stable-project-id");
  assert.equal(openFrame.relativePath, "dist/index.html");
  assert.deepEqual(openFrame.range, { start: 2, end: 10 });
  assert.deepEqual(openFrame.actor, { userId: "operator-id", email: "operator@example.com" });
  const requestId = String(openFrame.requestId);

  const creditPromise = message(ws);
  ws.send(JSON.stringify({
    type: "file_meta", requestId, status: 206, contentType: "text/html; charset=utf-8",
    contentLength: 9, contentRange: "bytes 2-10/20", acceptRanges: "bytes", etag: "\"v1\"",
  }));
  const opened = await openedPromise;
  assert.deepEqual({
    status: opened.status, contentType: opened.contentType, contentLength: opened.contentLength,
    contentRange: opened.contentRange, acceptRanges: opened.acceptRanges, etag: opened.etag,
  }, {
    status: 206, contentType: "text/html; charset=utf-8", contentLength: 9,
    contentRange: "bytes 2-10/20", acceptRanges: "bytes", etag: "\"v1\"",
  });
  assert.deepEqual(await creditPromise, { type: "file_credit", requestId, bytes: 262_144 });

  const bytes = Buffer.from("abcdefghi");
  ws.send(encodePeonFileChunk(requestId, 0, bytes.subarray(0, 4)));
  ws.send(encodePeonFileChunk(requestId, 1, bytes.subarray(4)));
  ws.send(JSON.stringify({ type: "file_end", requestId }));
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "abcdefghi");

  ws.close();
  await closed(ws);
  await new Promise<void>((resolve) => transferWss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("sandbox file service negotiates separately and sends absolute or relative sandbox paths", async () => {
  const { record, token } = await fixture("sandbox-file-stream");
  const server = http.createServer();
  const transferWss = attachPeonTransferSocket(server);
  const port = await listen(server);
  const ws = await open(`ws://127.0.0.1:${port}${PEON_TRANSFER_SOCKET_PATH}`, token);
  await transferHello(ws, record.peonId, ["project-file-read-v1", "sandbox-file-read-v1"]);

  const openFramePromise = message(ws);
  const openedPromise = openPeonSandboxFile({
    peonId: record.peonId,
    path: "/tmp/peon-files/uploads/session/attachment.png",
    actor: { userId: "operator-id", email: "operator@example.com" },
  });
  const openFrame = await openFramePromise;
  assert.equal(openFrame.type, "file_open");
  assert.equal(openFrame.scope, "sandbox");
  assert.equal(openFrame.path, "/tmp/peon-files/uploads/session/attachment.png");
  assert.equal(openFrame.projectId, undefined);
  const requestId = String(openFrame.requestId);

  const creditPromise = message(ws);
  ws.send(JSON.stringify({
    type: "file_meta", requestId, status: 200, contentType: "image/png",
    contentLength: 3, acceptRanges: "bytes",
  }));
  const opened = await openedPromise;
  assert.equal(opened.contentType, "image/png");
  assert.deepEqual(await creditPromise, { type: "file_credit", requestId, bytes: 262_144 });
  const replenishedCredit = message(ws);
  ws.send(encodePeonFileChunk(requestId, 0, Buffer.from("png")));
  ws.send(JSON.stringify({ type: "file_end", requestId }));
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "png");
  assert.deepEqual(await replenishedCredit, { type: "file_credit", requestId, bytes: 3 });

  const sentinelRoot = "/srv/__OVSR249_SOCKET_ROOT_SENTINEL__/transfer";
  const sentinelPath = "/srv/__OVSR249_SOCKET_PATH_SENTINEL__/secret";
  const rejectedFramePromise = message(ws);
  const rejected = openPeonSandboxFile({
    peonId: record.peonId,
    path: sentinelPath,
    actor: { userId: "operator-id", email: "operator@example.com" },
  });
  const rejectedRequestId = String((await rejectedFramePromise).requestId);
  ws.send(JSON.stringify({
    type: "file_error",
    requestId: rejectedRequestId,
    status: 400,
    code: "PATH_ESCAPE",
    message: `${sentinelPath} is outside ${sentinelRoot}`,
  }));
  await assert.rejects(rejected, (error: unknown) => error instanceof PeonFileStreamError
    && error.status === 400
    && error.code === "PATH_ESCAPE"
    && error.message === PATH_ESCAPE_PUBLIC_MESSAGE
    && !error.message.includes(sentinelRoot)
    && !error.message.includes(sentinelPath));

  ws.close();
  await closed(ws);
  await new Promise<void>((resolve) => transferWss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("session artifact service routes stable session identity and contained path over transfer", async () => {
  const { record, token } = await fixture("session-artifact-stream");
  const server = http.createServer();
  const transferWss = attachPeonTransferSocket(server);
  const port = await listen(server);
  const ws = await open(`ws://127.0.0.1:${port}${PEON_TRANSFER_SOCKET_PATH}`, token);
  await transferHello(ws, record.peonId, ["session-artifact-v1"]);

  const openFramePromise = message(ws);
  const openedPromise = openPeonSessionArtifact({
    peonId: record.peonId,
    sessionId: "session-1",
    path: "dist/report.pdf",
    actor: { userId: "operator-id", email: "operator@example.com" },
  });
  const openFrame = await openFramePromise;
  assert.equal(openFrame.type, "file_open");
  assert.equal(openFrame.scope, "session");
  assert.equal(openFrame.sessionId, "session-1");
  assert.equal(openFrame.path, "dist/report.pdf");
  const requestId = String(openFrame.requestId);

  const creditPromise = message(ws);
  ws.send(JSON.stringify({
    type: "file_meta", requestId, status: 200, contentType: "application/pdf",
    contentLength: 3, acceptRanges: "bytes",
  }));
  const opened = await openedPromise;
  assert.equal(opened.contentType, "application/pdf");
  assert.deepEqual(await creditPromise, { type: "file_credit", requestId, bytes: 262_144 });
  ws.send(encodePeonFileChunk(requestId, 0, Buffer.from("pdf")));
  ws.send(JSON.stringify({ type: "file_end", requestId }));
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "pdf");

  ws.close();
  await closed(ws);
  await new Promise<void>((resolve) => transferWss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("session artifact metadata and preview handoff stay correlated on transfer", async () => {
  const { record, token } = await fixture("session-artifact-operation");
  const server = http.createServer();
  const transferWss = attachPeonTransferSocket(server);
  const port = await listen(server);
  const ws = await open(`ws://127.0.0.1:${port}${PEON_TRANSFER_SOCKET_PATH}`, token);
  await transferHello(ws, record.peonId, ["session-artifact-v1"]);

  const requestFramePromise = message(ws);
  const resultPromise = requestPeonSessionArtifact({
    peonId: record.peonId,
    sessionId: "session-1",
    operation: "preview",
    path: "dist/report.pdf",
    actor: { userId: "operator-id", email: "operator@example.com" },
  });
  const requestFrame = await requestFramePromise;
  assert.equal(requestFrame.type, "artifact_request");
  assert.equal(requestFrame.sessionId, "session-1");
  assert.equal(requestFrame.operation, "preview");
  assert.equal(requestFrame.path, "dist/report.pdf");
  ws.send(JSON.stringify({
    type: "artifact_result",
    requestId: requestFrame.requestId,
    status: 201,
    code: "OK",
    message: null,
    body: { event: { type: "preview", name: "report.pdf" } },
  }));
  assert.deepEqual(await resultPromise, {
    status: 201,
    body: { event: { type: "preview", name: "report.pdf" } },
  });

  ws.close();
  await closed(ws);
  await new Promise<void>((resolve) => transferWss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("credential generation eviction immediately fails its in-flight sandbox read", async () => {
  const { record, token } = await fixture("sandbox-generation-eviction");
  const server = http.createServer();
  const transferWss = attachPeonTransferSocket(server);
  const port = await listen(server);
  const ws = await open(`ws://127.0.0.1:${port}${PEON_TRANSFER_SOCKET_PATH}`, token);
  await transferHello(ws, record.peonId, ["sandbox-file-read-v1"]);

  const openFramePromise = message(ws);
  const opened = openPeonSandboxFile({
    peonId: record.peonId,
    path: "uploads/session/attachment.png",
    actor: { userId: "operator-id", email: "operator@example.com" },
  });
  assert.equal((await openFramePromise).type, "file_open");

  const rejected = assert.rejects(
    opened,
    (error: unknown) => error instanceof PeonFileStreamError
      && error.code === "PEON_TRANSFER_DISCONNECTED"
      && error.status === 502,
  );
  const socketClosed = closed(ws);
  assert.equal(evictPeonTransferConnectionsBelowGeneration(record.peonId, 1), true);
  await Promise.all([socketClosed, rejected]);
  assert.equal(isPeonTransferConnected(record.peonId), false);

  await new Promise<void>((resolve) => transferWss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("browser viewer infers inline MIME types when Peon reports generic bytes", () => {
  assert.equal(projectFileContentType("dist/index.html", "application/octet-stream"), "text/html; charset=utf-8");
  assert.equal(projectFileContentType("assets/app.js", "application/octet-stream"), "text/javascript; charset=utf-8");
  assert.equal(projectFileContentType("archive.bin", "application/octet-stream"), "application/octet-stream");
  assert.equal(projectFileContentType("index.html", "text/plain; charset=utf-8"), "text/plain; charset=utf-8");
});

test("session artifact raw responses keep active content download-only", () => {
  assert.equal(sessionArtifactContentType("report.pdf"), "application/pdf");
  assert.equal(sessionArtifactContentType("diagram.PNG"), "image/png");
  assert.equal(sessionArtifactContentType("index.html"), "application/octet-stream");
  assert.equal(sessionArtifactContentType("vector.svg"), "application/octet-stream");
  assert.equal(sessionArtifactContentType("script.js"), "application/octet-stream");
});

test("project file service rejects unsafe paths, propagates Peon errors, and cancels aborted opens", async () => {
  await assert.rejects(
    openPeonProjectFile({ peonId: "none", projectId: "project", relativePath: "../secret", actor: { userId: "u", email: "u@example.com" } }),
    (error: unknown) => error instanceof PeonFileStreamError && error.code === "INVALID_PROJECT_PATH" && error.status === 400,
  );
  await assert.rejects(
    openPeonProjectFile({ peonId: "none", projectId: "project", relativePath: "/absolute", actor: { userId: "u", email: "u@example.com" } }),
    (error: unknown) => error instanceof PeonFileStreamError && error.code === "INVALID_PROJECT_PATH",
  );

  const { record, token } = await fixture("file-errors");
  const server = http.createServer();
  const transferWss = attachPeonTransferSocket(server);
  const port = await listen(server);
  const ws = await open(`ws://127.0.0.1:${port}${PEON_TRANSFER_SOCKET_PATH}`, token);
  await transferHello(ws);

  const errorOpenFrame = message(ws);
  const errored = openPeonProjectFile({
    peonId: record.peonId, projectId: "project", relativePath: "missing.txt",
    actor: { userId: "u", email: "u@example.com" },
  });
  const errorRequestId = String((await errorOpenFrame).requestId);
  ws.send(JSON.stringify({ type: "file_error", requestId: errorRequestId, status: 404, code: "NOT_FOUND", message: "file does not exist" }));
  await assert.rejects(errored, (error: unknown) => error instanceof PeonFileStreamError
    && error.status === 404 && error.code === "NOT_FOUND" && error.message === "file does not exist");

  const controller = new AbortController();
  const cancelOpenFrame = message(ws);
  const cancelled = openPeonProjectFile({
    peonId: record.peonId, projectId: "project", relativePath: "slow.bin",
    actor: { userId: "u", email: "u@example.com" }, signal: controller.signal,
  });
  const cancelRequestId = String((await cancelOpenFrame).requestId);
  const cancelFrame = message(ws);
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof PeonFileStreamError && error.code === "TRANSFER_CANCELLED");
  assert.deepEqual(await cancelFrame, { type: "file_cancel", requestId: cancelRequestId, reason: "TRANSFER_CANCELLED" });
  ws.send(JSON.stringify({ type: "file_error", requestId: cancelRequestId, status: 499, code: "CANCELLED", message: "cancelled" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ws.readyState, WebSocket.OPEN, "a late cancellation response must not close the shared socket");

  const revokedOpenFrame = message(ws);
  const revoked = openPeonProjectFile({
    peonId: record.peonId, projectId: "project", relativePath: "revoked.bin",
    actor: { userId: "u", email: "u@example.com" },
  });
  await revokedOpenFrame;
  const revokedClose = closed(ws);
  await revokeCredentialForPeon(record.workspaceId, record.peonId);
  await assert.rejects(revoked, (error: unknown) => error instanceof PeonFileStreamError && error.code === "PEON_TRANSFER_DISCONNECTED");
  await revokedClose;
  await new Promise<void>((resolve) => transferWss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("project file service requires the negotiated project-file-read capability", async () => {
  const { record, token } = await fixture("file-capability");
  const server = http.createServer();
  const transferWss = attachPeonTransferSocket(server);
  const port = await listen(server);
  const ws = await open(`ws://127.0.0.1:${port}${PEON_TRANSFER_SOCKET_PATH}`, token);
  await transferHello(ws, record.peonId, []);
  await assert.rejects(
    openPeonProjectFile({
      peonId: record.peonId, projectId: "project", relativePath: "file.txt",
      actor: { userId: "u", email: "u@example.com" },
    }),
    (error: unknown) => error instanceof PeonFileStreamError && error.code === "PEON_TRANSFER_UNAVAILABLE" && error.status === 503,
  );
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
  await closed(ws);
  await new Promise<void>((resolve) => transferWss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("sandbox file service requires its own negotiated capability", async () => {
  const { record, token } = await fixture("sandbox-capability");
  const server = http.createServer();
  const transferWss = attachPeonTransferSocket(server);
  const port = await listen(server);
  const ws = await open(`ws://127.0.0.1:${port}${PEON_TRANSFER_SOCKET_PATH}`, token);
  await transferHello(ws, record.peonId, ["project-file-read-v1"]);
  await assert.rejects(
    openPeonSandboxFile({
      peonId: record.peonId,
      path: "uploads/session/file.txt",
      actor: { userId: "u", email: "u@example.com" },
    }),
    (error: unknown) => error instanceof PeonFileStreamError
      && error.code === "PEON_TRANSFER_UNAVAILABLE"
      && error.status === 503,
  );
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
  await closed(ws);
  await new Promise<void>((resolve) => transferWss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("stable project-ID file route is registered separately from project-key routes", () => {
  const router = peonsRouter() as unknown as { stack: { route?: { path?: string; methods?: Record<string, boolean> } }[] };
  const route = router.stack.find((layer) => layer.route?.path === "/workspaces/:wsId/peons/:id/projects/by-id/:projectId/files/{*rest}");
  assert.equal(route?.route?.methods?.get, true);
});

test("project file responses sandbox active content away from the authenticated Overseer origin", () => {
  const headers = new Map<string, string>();
  isolateProjectFileResponse({ setHeader: (name, value) => {
    headers.set(name.toLowerCase(), String(value));
    return undefined as never;
  } });
  assert.equal(headers.get("content-security-policy"), PROJECT_FILE_CSP);
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("cache-control"), "no-store");
});

test("project HTTP fallback removes only the private directory marker from the raw query", () => {
  assert.equal(
    projectFileProxyQuery("/files/src?stat=1&stat=2&encoded=a%2Bb&array%5B%5D=x&directory=1&array%5B%5D=y"),
    "?stat=1&stat=2&encoded=a%2Bb&array%5B%5D=x&array%5B%5D=y",
  );
  assert.equal(
    projectFileProxyQuery("/files/src?%64irectory=1&value=%2520&flag&directory=2"),
    "?value=%2520&flag",
  );
  assert.equal(projectFileProxyQuery("/files/src?directory=1"), "");
  assert.equal(projectFileProxyQuery("/files/src?directory%ZZ=1&stat=1"), "?directory%ZZ=1&stat=1");
});

test("a project file read takes one authority and retains HTTP only for an older Peon", () => {
  // The Peon's HTTP API is going away, so the socket is the default read path.
  assert.equal(projectFileReadChannel({ transportReady: false, projectId: "p" }), "proxy");
  assert.equal(projectFileReadChannel({ transportReady: true, projectId: null }), "unavailable");
  assert.equal(projectFileReadChannel({ transportReady: true, projectId: "p" }), "socket");
});

test("the project-key file route is the one that changes channel", () => {
  const router = peonsRouter() as unknown as { stack: { route?: { path?: string; methods?: Record<string, boolean> } }[] };
  const route = router.stack.find((layer) => layer.route?.path === "/workspaces/:wsId/peons/:id/projects/:key/files/{*rest}");
  assert.equal(route?.route?.methods?.get, true);
});
