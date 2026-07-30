import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import WebSocket from "ws";
import { bindPeon, mintCredential } from "./credentials.js";
import { initDb, query } from "./db.js";
import { issueDevice, WEB_SESSION_COOKIE } from "./modules/auth/index.js";
import { attachPeonSocket } from "./peonSocket.js";
import { attachPeonTransferSocket, PEON_TRANSFER_SOCKET_PATH } from "./peonTransferSocket.js";
import { registry } from "./registry.js";
import { createServer } from "./server.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function collect(ws: WebSocket) {
  const frames: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  ws.on("message", (data) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    for (const waiter of waiters) waiter();
  });
  const next = (predicate: (frame: Record<string, unknown>) => boolean) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const inspect = () => {
      const index = frames.findIndex(predicate);
      if (index < 0) return;
      clearTimeout(timeout);
      waiters.delete(inspect);
      resolve(frames.splice(index, 1)[0]!);
    };
    const timeout = setTimeout(() => {
      waiters.delete(inspect);
      reject(new Error(`timed out waiting for control frame: ${JSON.stringify(frames)}`));
    }, 2_000);
    waiters.add(inspect);
    inspect();
  });
  return { frames, next };
}

function get(port: number, path: string, cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, headers: { cookie } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) as Record<string, unknown> : {} });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function getRaw(
  port: number,
  path: string,
  cookie: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, headers: { cookie, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks),
        headers: res.headers,
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

function mutate(
  port: number,
  method: "PUT" | "PATCH",
  path: string,
  cookie: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const encoded = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        cookie,
        origin: "https://overseer.rnm.dev",
        ...(body ? { "content-type": "application/json", "content-length": String(encoded.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) as Record<string, unknown> : {} });
      });
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

test("project-key file route selects one transport and preserves the legacy listing contract", async () => {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,created_at) VALUES ('route-owner','route-owner@test',1)`);
  await query(`INSERT INTO workspaces (id,name,slug,created_by,created_at)
    VALUES ('route-workspace','Route','route-workspace','route-owner',1)`);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at)
    VALUES ('route-workspace','route-owner','owner',1)`);
  const device = await issueDevice("route-owner", "test", { ip: null, userAgent: null });
  const cookie = `${WEB_SESSION_COOKIE}=${device.token}`;

  const httpRequests: string[] = [];
  const fakePeon = http.createServer((req, res) => {
    httpRequests.push(req.url ?? "");
    res.setHeader("Content-Type", "application/json");
    if (req.url?.includes("README.md")) {
      res.end(JSON.stringify({ path: "README.md", size: 7, mtimeMs: 10, sha256: "abc" }));
      return;
    }
    res.end(JSON.stringify({
      path: "src",
      entries: [{ name: "legacy.ts", type: "file", size: 3, mtimeMs: 11 }],
    }));
  });
  const fakePeonPort = await listen(fakePeon);

  const { credential, token } = await mintCredential("route-workspace", "Route Peon", "route-owner");
  assert.equal(await bindPeon(credential.id, "route-peon"), true);
  await registry.register({
    peonId: "route-peon",
    credentialId: credential.id,
    workspaceId: "route-workspace",
    name: "Route Peon",
    hostname: null,
    address: "127.0.0.1",
    controlPort: fakePeonPort,
    publicUrl: `http://127.0.0.1:${fakePeonPort}`,
    protocol: 1,
    capabilities: [],
    token,
    load: null,
  });
  await query(`INSERT INTO projects (peon_id,project_id,project_key,name,dir,metadata,synced_at)
    VALUES ('route-peon','route-project','project-key','Route Project','/projects/route',NULL,1)`);

  const appServer = http.createServer(createServer());
  const wss = attachPeonSocket(appServer);
  const transferWss = attachPeonTransferSocket(appServer);
  const appPort = await listen(appServer);
  const ws = new WebSocket(`ws://127.0.0.1:${appPort}/api/v1/peons/ws`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const control = collect(ws);
  ws.send(JSON.stringify({
    type: "hello",
    protocol: 1,
    peonId: "route-peon",
    capabilities: ["folder-listing-v1", "file-write-v1"],
    channels: { "folder-listing-v1": { entryMetadata: "entry-metadata-v1" } },
  }));
  await control.next((frame) => frame.type === "hello_ack");
  const transfer = new WebSocket(`ws://127.0.0.1:${appPort}${PEON_TRANSFER_SOCKET_PATH}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    transfer.once("open", resolve);
    transfer.once("error", reject);
  });
  const transferControl = collect(transfer);
  transfer.send(JSON.stringify({
    type: "hello",
    protocol: 1,
    channel: "file-transfer",
    peonId: "route-peon",
    capabilities: ["project-file-read-v1", "file-write-v1"],
  }));
  await transferControl.next((frame) => frame.type === "hello_ack");

  const base = "/api/workspaces/route-workspace/peons/route-peon/projects/project-key/files";
  try {
    const fileResponse = getRaw(appPort, `${base}/README.md`, cookie, { range: "bytes=2-5" });
    const fileRequest = await transferControl.next((frame) => frame.type === "file_open");
    assert.equal(fileRequest.projectId, "route-project", "the mutable project key must resolve to its stable catalog ID");
    assert.equal(fileRequest.relativePath, "README.md");
    assert.deepEqual(fileRequest.range, { start: 2, end: 5 });
    assert.deepEqual(fileRequest.actor, { userId: "route-owner", email: "route-owner@test" });
    const fileRequestId = String(fileRequest.requestId);
    transfer.send(JSON.stringify({
      type: "file_meta",
      requestId: fileRequestId,
      status: 206,
      contentType: "application/octet-stream",
      contentLength: 4,
      contentRange: "bytes 2-5/7",
      acceptRanges: "bytes",
    }));
    await transferControl.next((frame) => frame.type === "file_credit" && frame.requestId === fileRequestId);
    const requestIdBytes = Buffer.from(fileRequestId.replaceAll("-", ""), "hex");
    const chunk = Buffer.alloc(26);
    chunk[0] = 1;
    chunk[1] = 1;
    requestIdBytes.copy(chunk, 2);
    chunk.writeUInt32BE(0, 18);
    chunk.write("cket", 22);
    transfer.send(chunk);
    transfer.send(JSON.stringify({ type: "file_end", requestId: fileRequestId }));
    const streamed = await fileResponse;
    assert.equal(streamed.status, 206);
    assert.equal(streamed.body.toString(), "cket");
    assert.equal(streamed.headers["content-type"], "text/markdown; charset=utf-8");
    assert.equal(streamed.headers["content-range"], "bytes 2-5/7");
    assert.equal(streamed.headers["content-security-policy"], "sandbox allow-scripts allow-forms allow-modals allow-downloads");
    assert.equal(streamed.headers["referrer-policy"], "no-referrer");
    assert.equal(streamed.headers["x-content-type-options"], "nosniff");
    assert.equal(streamed.headers["cache-control"], "no-store");
    assert.deepEqual(httpRequests, [], "a selected socket read must not probe legacy HTTP");

    const failedFileResponse = getRaw(appPort, `${base}/missing.txt`, cookie);
    const failedFileRequest = await transferControl.next((frame) => frame.type === "file_open");
    transfer.send(JSON.stringify({
      type: "file_error",
      requestId: failedFileRequest.requestId,
      status: 404,
      code: "NOT_FOUND",
      message: "file does not exist",
    }));
    const failedFile = await failedFileResponse;
    assert.equal(failedFile.status, 404);
    assert.deepEqual(JSON.parse(failedFile.body.toString()), { error: "file does not exist", code: "NOT_FOUND" });
    assert.deepEqual(httpRequests, [], "a socket file error must never fall through to HTTP");

    const directoryResponse = get(appPort, `${base}/src?stat=1&directory=1`, cookie);
    const directoryRequest = await control.next((frame) => frame.type === "folder_list_request");
    assert.equal(directoryRequest.projectId, "route-project");
    assert.equal(directoryRequest.relativePath, "src");
    ws.send(JSON.stringify({
      type: "folder_list_page",
      requestId: directoryRequest.requestId,
      path: "/projects/route/src",
      projectId: "route-project",
      entries: [
        { name: "lib", type: "directory", size: null, mtimeMs: 20 },
        { name: "main.ts", type: "file", size: 12, mtimeMs: 21 },
        { name: "outside-link", type: "other", size: null, mtimeMs: null },
      ],
      nextCursor: null,
      hasMore: false,
    }));
    assert.deepEqual(await directoryResponse, {
      status: 200,
      body: {
        path: "src",
        entries: [
          { name: "lib", type: "dir", size: null, mtimeMs: 20 },
          { name: "main.ts", type: "file", size: 12, mtimeMs: 21 },
          { name: "outside-link", type: "other", size: null, mtimeMs: null },
        ],
      },
    });
    assert.deepEqual(httpRequests, []);

    assert.deepEqual(await get(appPort, `${base}/README.md?stat=1`, cookie), {
      status: 200,
      body: { path: "README.md", size: 7, mtimeMs: 10, sha256: "abc" },
    });
    assert.equal(httpRequests.length, 1);
    assert.equal(String(httpRequests[0]).includes("directory="), false);

    assert.deepEqual(await get(
      appPort,
      `${base}/src?stat=1&stat=2&encoded=a%2Bb&array%5B%5D=x&array%5B%5D=y`,
      cookie,
    ), {
      status: 200,
      body: {
        path: "src",
        entries: [{ name: "legacy.ts", type: "file", size: 3, mtimeMs: 11 }],
      },
    });
    assert.equal(httpRequests.length, 2, "unconfirmed stat requests must stay exclusively on HTTP");
    assert.equal(
      String(httpRequests[1]).endsWith("?stat=1&stat=2&encoded=a%2Bb&array%5B%5D=x&array%5B%5D=y"),
      true,
      "repeated, array-shaped, and encoded query values must survive the HTTP proxy unchanged",
    );

    const busyResponse = get(appPort, `${base}/src?stat=1&directory=1`, cookie);
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const busyRequest = await control.next((frame) => frame.type === "folder_list_request");
      ws.send(JSON.stringify({
        type: "folder_list_error",
        requestId: busyRequest.requestId,
        code: "SYNC_IN_PROGRESS",
        error: "another folder listing is already active",
      }));
    }
    assert.deepEqual(await busyResponse, {
      status: 409,
      body: { error: "another folder listing is already active", code: "SYNC_IN_PROGRESS" },
    });
    assert.equal(httpRequests.length, 2, "socket contention must not fall through to HTTP");

    const wrongKindResponse = get(appPort, `${base}/README.md?stat=1&directory=1`, cookie);
    const wrongKindRequest = await control.next((frame) => frame.type === "folder_list_request");
    ws.send(JSON.stringify({
      type: "folder_list_error",
      requestId: wrongKindRequest.requestId,
      code: "NOT_DIRECTORY",
      error: "filesystem path is not a directory",
    }));
    assert.deepEqual(await wrongKindResponse, {
      status: 400,
      body: { error: "filesystem path is not a directory", code: "NOT_DIRECTORY" },
    });
    assert.equal(httpRequests.length, 2, "a confirmed socket request must never probe HTTP");

    const legacyTransfer = new WebSocket(`ws://127.0.0.1:${appPort}${PEON_TRANSFER_SOCKET_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await new Promise<void>((resolve, reject) => {
      legacyTransfer.once("open", resolve);
      legacyTransfer.once("error", reject);
    });
    const legacyTransferControl = collect(legacyTransfer);
    transfer.once("close", () => {});
    legacyTransfer.send(JSON.stringify({
      type: "hello",
      protocol: 1,
      channel: "file-transfer",
      peonId: "route-peon",
      capabilities: ["file-write-v1"],
    }));
    await legacyTransferControl.next((frame) => frame.type === "hello_ack");
    const legacyRead = await getRaw(appPort, `${base}/README.md`, cookie);
    assert.equal(legacyRead.status, 200);
    assert.deepEqual(JSON.parse(legacyRead.body.toString()), { path: "README.md", size: 7, mtimeMs: 10, sha256: "abc" });
    assert.equal(httpRequests.length, 3, "a Peon without project-file-read-v1 must retain the HTTP fallback");

    await query(`DELETE FROM projects WHERE peon_id='route-peon'`);
    const beforeIdentityRefusals = httpRequests.length;
    assert.deepEqual(await mutate(appPort, "PUT", `${base}/missing.txt`, cookie), {
      status: 409,
      body: {
        error: "canonical project identity is temporarily unavailable",
        code: "PROJECT_IDENTITY_UNAVAILABLE",
      },
    });
    assert.deepEqual(await mutate(appPort, "PATCH", `${base}/README.md`, cookie, { destination: "renamed.md" }), {
      status: 409,
      body: {
        error: "canonical project identity is temporarily unavailable",
        code: "PROJECT_IDENTITY_UNAVAILABLE",
      },
    });
    assert.equal(
      httpRequests.length,
      beforeIdentityRefusals,
      "negotiated project mutations with missing canonical identity must never probe legacy HTTP",
    );
    await query(`INSERT INTO projects (peon_id,project_id,project_key,name,dir,metadata,synced_at)
      VALUES ('route-peon','route-project','project-key','Route Project','/projects/route',NULL,2)`);

    const disconnectedResponse = get(appPort, `${base}/src?stat=1&directory=1`, cookie);
    await control.next((frame) => frame.type === "folder_list_request");
    ws.terminate();
    assert.deepEqual(await disconnectedResponse, {
      status: 502,
      body: { error: "Peon connection was lost", code: "CONNECTION_LOST" },
    });
    assert.equal(httpRequests.length, 3, "a lost chosen socket must not fall through to HTTP");
    legacyTransfer.terminate();
  } finally {
    ws.terminate();
    transfer.terminate();
    await new Promise<void>((resolve) => transferWss.close(() => resolve()));
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await close(appServer);
    await close(fakePeon);
  }
});
