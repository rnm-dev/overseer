import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import WebSocket from "ws";
import { bindPeon, mintCredential } from "./credentials.js";
import { initDb, query } from "./db.js";
import { bus, type LiveEvent } from "./eventLog.js";
import { PATH_ESCAPE_PUBLIC_MESSAGE } from "./fileErrorSafety.js";
import {
  createOrGetReverseCommand,
  getReverseCommand,
  ReverseCommandGateway,
} from "./modules/reverseCommands/index.js";
import { issueDevice, WEB_SESSION_COOKIE } from "./modules/auth/index.js";
import { clearFileTransferRootCache } from "./peonFileSandbox.js";
import { getPeonConnection } from "./peonConnections.js";
import { attachPeonSocket } from "./peonSocket.js";
import {
  getPeonTransferConnection,
  PROJECT_FILE_READ_CAPABILITY,
} from "./peonTransferConnections.js";
import {
  attachPeonTransferSocket,
  PEON_TRANSFER_SOCKET_PATH,
} from "./peonTransferSocket.js";
import { registry, toView, type PeonRecord } from "./registry.js";
import { createServer } from "./server.js";
import { upsertSession } from "./sessionIndex.js";

const USER_ID = "b169219d-45f6-4f42-b78f-3fb931dac7ee";
const OTHER_USER_ID = "c269219d-45f6-4f42-b78f-3fb931dac7ee";
const PEON_A = "f4de920f-e33e-4cf5-97d0-3a75e9266090";
const PEON_B = "a4de920f-e33e-4cf5-97d0-3a75e9266090";
const SESSION_A = "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5";
const COMMAND_ID = "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
const WORKSPACE_A = "reverse-security-workspace-a";
const WORKSPACE_B = "reverse-security-workspace-b";

interface RegisteredPeon {
  record: PeonRecord;
  token: string;
}

async function freshDatabase(): Promise<void> {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);
  await query(
    `INSERT INTO users (id,email,created_at) VALUES ($1,'operator@example.test',1),($2,'other@example.test',1)`,
    [USER_ID, OTHER_USER_ID],
  );
  await query(
    `INSERT INTO workspaces (id,name,slug,created_by,created_at)
     VALUES ($1,'Security A','reverse-security-a',$3,1),($2,'Security B','reverse-security-b',$3,1)`,
    [WORKSPACE_A, WORKSPACE_B, USER_ID],
  );
  await query(
    `INSERT INTO workspace_members (workspace_id,user_id,role,added_at)
     VALUES ($1,$3,'owner',1),($2,$3,'owner',1),($1,$4,'member',1)`,
    [WORKSPACE_A, WORKSPACE_B, USER_ID, OTHER_USER_ID],
  );
}

async function registerPeon(workspaceId: string, peonId: string, label: string): Promise<RegisteredPeon> {
  const { credential, token } = await mintCredential(workspaceId, label, USER_ID);
  assert.equal(await bindPeon(credential.id, peonId), true);
  const record = await registry.register({
    peonId,
    credentialId: credential.id,
    workspaceId,
    name: label,
    hostname: null,
    address: "127.0.0.1",
    controlPort: 4570,
    publicUrl: null,
    protocol: 1,
    capabilities: [],
    token,
    load: null,
  });
  return { record, token };
}

function open(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function rejectedUpgrade(url: string, token: string): Promise<Error> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(new Error(`unexpected server response ${response.statusCode}`));
    });
    ws.once("error", resolve);
  });
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("error", () => {});
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => {
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

async function controlHello(ws: WebSocket, peonId: string): Promise<void> {
  const reply = nextJson(ws);
  ws.send(JSON.stringify({ type: "hello", protocol: 1, peonId }));
  assert.deepEqual(await reply, {
    type: "hello_ack",
    protocol: 1,
    capabilities: [],
  });
}

async function transferHello(ws: WebSocket, peonId: string): Promise<void> {
  const reply = nextJson(ws);
  ws.send(JSON.stringify({
    type: "hello",
    protocol: 1,
    channel: "file-transfer",
    peonId,
    capabilities: [PROJECT_FILE_READ_CAPABILITY],
  }));
  assert.deepEqual(await reply, {
    type: "hello_ack",
    protocol: 1,
    channel: "file-transfer",
    capabilities: [PROJECT_FILE_READ_CAPABILITY],
  });
}

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function stop(
  server: http.Server,
  ...sockets: Array<ReturnType<typeof attachPeonSocket> | ReturnType<typeof attachPeonTransferSocket>>
): Promise<void> {
  await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => socket.close(() => resolve()))));
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("stable command admission hides cross-workspace/Peon state, rejects actor spoofing, and fences ID reuse", async () => {
  await freshDatabase();
  const a = await registerPeon(WORKSPACE_A, PEON_A, "Security A");
  await registerPeon(WORKSPACE_B, PEON_B, "Security B");
  await upsertSession(WORKSPACE_A, PEON_A, {
    id: SESSION_A,
    status: "running",
    projectKey: "shared",
    projectId: "project-a",
  });
  const gateway = new ReverseCommandGateway();
  const auth = {
    userId: USER_ID,
    email: "browser-supplied@example.test",
    githubLogin: null,
    avatarUrl: null,
    deviceId: "reverse-security",
  };

  const validButOffline = await gateway.submit({
    workspaceId: WORKSPACE_A,
    peonId: PEON_A,
    auth,
    operation: "session.delete",
    target: { sessionId: SESSION_A },
    commandId: COMMAND_ID,
    waitMs: 0,
  });
  assert.deepEqual(
    { status: validButOffline.status, code: validButOffline.body.code },
    { status: 503, code: "PEON_OFFLINE" },
  );

  const crossWorkspace = await gateway.submit({
    workspaceId: WORKSPACE_B,
    peonId: PEON_A,
    auth,
    operation: "session.delete",
    target: { sessionId: SESSION_A },
    commandId: "118f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    waitMs: 0,
  });
  assert.deepEqual(
    { status: crossWorkspace.status, code: crossWorkspace.body.code },
    { status: 404, code: "UNKNOWN_PEON" },
  );

  const crossPeon = await gateway.submit({
    workspaceId: WORKSPACE_B,
    peonId: PEON_B,
    auth,
    operation: "session.delete",
    target: { sessionId: SESSION_A },
    commandId: "218f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    waitMs: 0,
  });
  assert.deepEqual(
    { status: crossPeon.status, code: crossPeon.body.code },
    { status: 404, code: "UNKNOWN_SESSION" },
  );

  const ungrantedMember = await gateway.submit({
    workspaceId: WORKSPACE_A,
    peonId: PEON_A,
    auth: { ...auth, userId: OTHER_USER_ID },
    operation: "session.delete",
    target: { sessionId: SESSION_A },
    commandId: "318f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    waitMs: 0,
  });
  assert.deepEqual(
    { status: ungrantedMember.status, code: ungrantedMember.body.code },
    { status: 404, code: "UNKNOWN_PEON" },
  );

  const spoofed = await gateway.submit({
    workspaceId: WORKSPACE_A,
    peonId: PEON_A,
    auth,
    actor: { userId: OTHER_USER_ID, email: "attacker@example.test" },
    operation: "session.delete",
    target: { sessionId: SESSION_A },
    commandId: "418f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    waitMs: 0,
  } as never);
  assert.deepEqual(
    { status: spoofed.status, code: spoofed.body.code },
    { status: 400, code: "BAD_COMMAND" },
  );

  const command = {
    workspaceId: WORKSPACE_A,
    peonId: PEON_A,
    commandId: COMMAND_ID,
    requestHash: "a".repeat(64),
    operation: "session.delete" as const,
    actor: { userId: USER_ID, email: "operator@example.test" },
    target: { peonId: PEON_A, sessionId: SESSION_A },
    payload: {},
    expected: null,
    requestBytes: 256,
    requestedAt: Date.now(),
  };
  assert.equal((await createOrGetReverseCommand(command)).kind, "created");
  assert.equal((await createOrGetReverseCommand(command)).kind, "existing");
  assert.equal((await createOrGetReverseCommand({ ...command, requestHash: "b".repeat(64) })).kind, "reused");
  assert.equal((await getReverseCommand(WORKSPACE_A, PEON_A, COMMAND_ID))?.requestHash, "a".repeat(64));
  assert.equal(await gateway.status(WORKSPACE_A, PEON_A, COMMAND_ID, OTHER_USER_ID), null);
  assert.equal(await gateway.status(WORKSPACE_B, PEON_A, COMMAND_ID, USER_ID), null);

  const publicView = JSON.stringify(toView(a.record));
  assert.doesNotMatch(publicView, new RegExp(a.token));
  assert.equal(Object.hasOwn(toView(a.record), "token"), false);
});

test("control and transfer sockets close malformed, binary, and oversized frames without reflecting credentials", async () => {
  await freshDatabase();
  const { record, token } = await registerPeon(WORKSPACE_A, PEON_A, "Frame limits");
  const server = http.createServer();
  const controlWss = attachPeonSocket(server);
  const transferWss = attachPeonTransferSocket(server);
  const port = await listen(server);
  const controlUrl = `ws://127.0.0.1:${port}/api/v1/peons/ws`;
  const transferUrl = `ws://127.0.0.1:${port}${PEON_TRANSFER_SOCKET_PATH}`;
  const rejectedSecret = "pn_rejected_secret_must_not_echo";

  try {
    const rejected = await rejectedUpgrade(controlUrl, rejectedSecret);
    assert.doesNotMatch(rejected.message, new RegExp(rejectedSecret));
    assert.match(rejected.message, /401/);

    const invalidJson = await open(controlUrl, token);
    const invalidJsonClose = closed(invalidJson);
    invalidJson.send("{not-json");
    assert.deepEqual(await invalidJsonClose, { code: 1007, reason: "invalid JSON" });

    const binaryControl = await open(controlUrl, token);
    const binaryControlClose = closed(binaryControl);
    binaryControl.send(Buffer.from([1]));
    assert.deepEqual(await binaryControlClose, { code: 1003, reason: "text frames only" });

    const oversizedControl = await open(controlUrl, token);
    const oversizedControlClose = closed(oversizedControl);
    oversizedControl.send("x".repeat(1024 * 1024 + 1));
    const controlResult = await oversizedControlClose;
    assert.equal(controlResult.code, 1009);
    assert.doesNotMatch(controlResult.reason, new RegExp(token));

    const malformedTransfer = await open(transferUrl, token);
    const malformedTransferClose = closed(malformedTransfer);
    malformedTransfer.send("{not-json");
    assert.deepEqual(await malformedTransferClose, { code: 1007, reason: "invalid JSON" });

    const oversizedTransfer = await open(transferUrl, token);
    const oversizedTransferClose = closed(oversizedTransfer);
    oversizedTransfer.send(Buffer.alloc(64 * 1024 + 1));
    const transferResult = await oversizedTransferClose;
    assert.equal(transferResult.code, 1009);
    assert.doesNotMatch(transferResult.reason, new RegExp(token));
    assert.equal(getPeonConnection(record.peonId), undefined);
    assert.equal(getPeonTransferConnection(record.peonId), undefined);
  } finally {
    await stop(server, controlWss, transferWss);
  }
});

test("new ready control and transfer sockets replace stale generations without stale-close rollback", async () => {
  await freshDatabase();
  const { record, token } = await registerPeon(WORKSPACE_A, PEON_A, "Generation fence");
  const server = http.createServer();
  const controlWss = attachPeonSocket(server);
  const transferWss = attachPeonTransferSocket(server);
  const port = await listen(server);
  const controlUrl = `ws://127.0.0.1:${port}/api/v1/peons/ws`;
  const transferUrl = `ws://127.0.0.1:${port}${PEON_TRANSFER_SOCKET_PATH}`;
  let currentControl: WebSocket | null = null;
  let currentTransfer: WebSocket | null = null;

  try {
    const oldControl = await open(controlUrl, token);
    await controlHello(oldControl, record.peonId);
    const oldOwnedControl = getPeonConnection(record.peonId);
    assert.ok(oldOwnedControl);
    const oldControlClosed = closed(oldControl);
    currentControl = await open(controlUrl, token);
    await controlHello(currentControl, record.peonId);
    assert.deepEqual(await oldControlClosed, {
      code: 4001,
      reason: "replaced by a newer connection",
    });
    const currentOwnedControl = getPeonConnection(record.peonId);
    assert.ok(currentOwnedControl);
    assert.notEqual(currentOwnedControl, oldOwnedControl);

    const oldTransfer = await open(transferUrl, token);
    await transferHello(oldTransfer, record.peonId);
    const oldOwnedTransfer = getPeonTransferConnection(record.peonId);
    assert.ok(oldOwnedTransfer);
    const oldTransferClosed = closed(oldTransfer);
    currentTransfer = await open(transferUrl, token);
    await transferHello(currentTransfer, record.peonId);
    assert.deepEqual(await oldTransferClosed, {
      code: 4001,
      reason: "replaced by a newer transfer connection",
    });
    const currentOwnedTransfer = getPeonTransferConnection(record.peonId);
    assert.ok(currentOwnedTransfer);
    assert.notEqual(currentOwnedTransfer, oldOwnedTransfer);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(getPeonConnection(record.peonId), currentOwnedControl);
    assert.equal(getPeonTransferConnection(record.peonId), currentOwnedTransfer);
  } finally {
    currentControl?.close();
    currentTransfer?.close();
    await stop(server, controlWss, transferWss);
  }
});

test("OVSR-249: PATH_ESCAPE omits sentinel roots and rejected paths from HTTP, browser events, and routine logs", async () => {
  const sentinelRoot = "/srv/__OVSR249_ROOT_SENTINEL__/transfer";
  const sentinelPath = "/srv/__OVSR249_REJECTED_PATH_SENTINEL__/secret.txt";
  await freshDatabase();
  const device = await issueDevice(USER_ID, "reverse-security", { ip: null, userAgent: null });
  const cookie = `${WEB_SESSION_COOKIE}=${device.token}`;
  const peonRequests: string[] = [];
  const fakePeon = http.createServer((req, res) => {
    peonRequests.push(req.url ?? "");
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/settings") {
      res.end(JSON.stringify({ fileTransferRoot: sentinelRoot }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "unexpected upstream request", code: "UNEXPECTED_REQUEST" }));
  });
  const fakePeonPort = await listen(fakePeon);
  const registered = await registerPeon(WORKSPACE_A, PEON_A, "PATH_ESCAPE sentinel");
  assert.ok(await registry.updateConnection(registered.record.peonId, `http://127.0.0.1:${fakePeonPort}`));
  clearFileTransferRootCache();

  const appServer = http.createServer(createServer());
  const appPort = await listen(appServer);
  const browserEvents: LiveEvent[] = [];
  const routineLogs: string[] = [];
  const onBrowserEvent = (event: LiveEvent) => browserEvents.push(event);
  const originalConsole = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  const captureLog = (...parts: unknown[]) => {
    routineLogs.push(parts.map((part) => {
      if (typeof part === "string") return part;
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    }).join(" "));
  };
  bus.on("event", onBrowserEvent);
  console.debug = captureLog;
  console.error = captureLog;
  console.info = captureLog;
  console.log = captureLog;
  console.warn = captureLog;

  try {
    const queryString = new URLSearchParams({ path: sentinelPath });
    const response = await fetch(
      `http://127.0.0.1:${appPort}/api/workspaces/${WORKSPACE_A}/peons/${PEON_A}/attachments?${queryString}`,
      { headers: { cookie } },
    );
    const bodyText = await response.text();
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(bodyText), {
      error: PATH_ESCAPE_PUBLIC_MESSAGE,
      code: "PATH_ESCAPE",
    });
    assert.deepEqual(peonRequests, ["/api/v1/settings"], "a rejected path must not reach the Peon's file reader");

    const { rows: storedEvents } = await query<{ payload: unknown }>("SELECT payload FROM events ORDER BY cursor");
    const observed = JSON.stringify({ bodyText, browserEvents, storedEvents, routineLogs });
    for (const sentinel of [sentinelRoot, sentinelPath]) {
      assert.equal(observed.includes(sentinel), false, `observable output leaked ${sentinel}`);
    }
  } finally {
    console.debug = originalConsole.debug;
    console.error = originalConsole.error;
    console.info = originalConsole.info;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    bus.off("event", onBrowserEvent);
    clearFileTransferRootCache();
    await stop(appServer);
    await stop(fakePeon);
  }
});
