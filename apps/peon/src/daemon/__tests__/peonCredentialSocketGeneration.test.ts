import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { PeonSocketPool, PeonSocketSupervisor } from "../overseer/socket/peonSocket.js";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("credential generation replacement fences both old socket channels immediately", async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const auth: string[] = [];
  wss.on("connection", (socket, request) => {
    sockets.add(socket);
    auth.push(request.headers.authorization ?? "");
    socket.once("message", (data) => {
      const hello = JSON.parse(data.toString()) as { protocol: number };
      socket.send(JSON.stringify({ type: "hello_ack", protocol: hello.protocol }));
    });
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  const base = await listen(server);
  const config = { overseerUrl: base, overseerToken: "old-bearer", peonId: "stable-peon" };
  const listeners = new Set<() => void>();
  const options = {
    readSettings: () => config,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    random: () => 0.5,
    retryBaseMs: 10,
    retryMaxMs: 20,
    handshakeTimeoutMs: 100,
    maintenanceIntervalMs: 10,
    channels: [],
  };
  const control = new PeonSocketSupervisor(options);
  const transfer = new PeonSocketSupervisor({ ...options, socketChannel: "file-transfer" });
  const pool = new PeonSocketPool([control, transfer]);
  try {
    pool.start();
    await waitFor(() => pool.getState().connectedConnections === 2, "old credential sockets did not connect");
    const oldSockets = [...sockets];

    // PeonClaimClient installs the acknowledged bearer through one settings
    // update. Both supervisors observe that same edge, increment their local
    // generation, terminate the old sockets, and authenticate successors.
    config.overseerToken = "new-bearer";
    for (const listener of listeners) listener();
    await waitFor(
      () => auth.filter((value) => value === "Bearer new-bearer").length === 2
        && pool.getState().connectedConnections === 2,
      "new credential did not replace both socket channels",
    );
    await waitFor(
      () => oldSockets.every((socket) => socket.readyState === WebSocket.CLOSED),
      "old credential sockets were not evicted",
    );

    // Their delayed close callbacks are fenced by supervisor generation/socket
    // identity and cannot tear down the ready successors.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(pool.getState().connectedConnections, 2);
    assert.deepEqual(
      auth.filter((value) => value === "Bearer new-bearer"),
      ["Bearer new-bearer", "Bearer new-bearer"],
    );
  } finally {
    pool.stop();
    for (const socket of sockets) socket.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
