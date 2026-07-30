import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http, { type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import type { PeonSocketChannel, PeonSocketFrame } from "../overseer/socket/peonSocketProtocol.js";
import { PeonSocketOutbox } from "../overseer/socket/peonSocketOutbox.js";
import { PeonSocketPool, PeonSocketSupervisor, peonSocketUrl } from "../overseer/socket/peonSocket.js";

interface MutableConfig {
  overseerUrl: string;
  overseerToken: string;
  peonId?: string;
}

async function listen(server: Server, port = 0): Promise<string> {
  server.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server, sockets: Set<WebSocket> = new Set()): Promise<void> {
  for (const socket of sockets) socket.terminate();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function testSupervisor(
  config: MutableConfig,
  subscribe: (listener: () => void) => () => void = () => () => {},
  channels: PeonSocketChannel[] = [],
  outbox?: PeonSocketOutbox,
  socketChannel: "control" | "file-transfer" = "control",
) {
  return new PeonSocketSupervisor({
    readSettings: () => config,
    subscribe,
    random: () => 0.5,
    retryBaseMs: 10,
    retryMaxMs: 40,
    stableMs: 25,
    handshakeTimeoutMs: 25,
    pingIntervalMs: 20,
    pongTimeoutMs: 15,
    maintenanceIntervalMs: 10,
    // Lifecycle tests isolate the transport supervisor. Channel negotiation is
    // covered independently so new features do not make every socket test know
    // their hello payload.
    channels,
    socketChannel,
    ...(outbox ? { outbox } : {}),
  });
}

function acceptingServer(options: { autoPong?: boolean } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true, autoPong: options.autoPong ?? true });
  const sockets = new Set<WebSocket>();
  const auth: string[] = [];
  const hellos: Array<Record<string, unknown>> = [];
  const paths: string[] = [];
  let connections = 0;
  wss.on("connection", (socket, request) => {
    connections += 1;
    sockets.add(socket);
    auth.push(request.headers.authorization ?? "");
    paths.push(request.url ?? "");
    socket.once("message", (data) => {
      const hello = JSON.parse(data.toString()) as Record<string, unknown>;
      assert.equal(hello.type, "hello");
      assert.equal(hello.protocol, 1);
      hellos.push(hello);
      socket.send(JSON.stringify({ type: "hello_ack", protocol: 1 }));
    });
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/v1/peons/ws" && request.url !== "/api/v1/peons/transfer/ws") return socket.destroy();
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  return { server, sockets, auth, hellos, paths, get connections() { return connections; } };
}

test("converts Overseer HTTP URLs to the Peon WebSocket endpoint", () => {
  assert.equal(peonSocketUrl("https://fleet.example.test"), "wss://fleet.example.test/api/v1/peons/ws");
  assert.equal(peonSocketUrl("http://fleet.example.test/root/"), "ws://fleet.example.test/root/api/v1/peons/ws");
  assert.equal(
    peonSocketUrl("https://fleet.example.test", "file-transfer"),
    "wss://fleet.example.test/api/v1/peons/transfer/ws",
  );
});

test("default control hello advertises the folder listing capability", async () => {
  const target = acceptingServer();
  const base = await listen(target.server);
  const config = { overseerUrl: base, overseerToken: "secret-token", peonId: "peon-folder" };
  const supervisor = new PeonSocketSupervisor({
    readSettings: () => config,
    subscribe: () => () => {},
    random: () => 0.5,
    retryBaseMs: 10,
    retryMaxMs: 40,
    stableMs: 25,
    handshakeTimeoutMs: 25,
    pingIntervalMs: 20,
    pongTimeoutMs: 15,
    maintenanceIntervalMs: 10,
  });
  try {
    supervisor.start();
    await waitFor(() => supervisor.getState().connected, "default control socket did not connect");
    const hello = target.hellos[0]!;
    assert.ok((hello.capabilities as string[]).includes("folder-listing-v1"));
    assert.deepEqual((hello.channels as Record<string, unknown>)["folder-listing-v1"], { entryMetadata: "entry-metadata-v1" });
  } finally {
    supervisor.stop();
    await closeServer(target.server, target.sockets);
  }
});

test("durable control hello advertises bounded transcript synchronization", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-transcript-hello-"));
  const target = acceptingServer();
  const base = await listen(target.server);
  const config = { overseerUrl: base, overseerToken: "secret-token", peonId: "peon-transcript" };
  const supervisor = new PeonSocketSupervisor({
    readSettings: () => config,
    subscribe: () => () => {},
    outbox: new PeonSocketOutbox({ fileBase: path.join(directory, "outbox") }),
    random: () => 0.5,
    retryBaseMs: 10,
    retryMaxMs: 40,
    stableMs: 25,
    handshakeTimeoutMs: 25,
    pingIntervalMs: 20,
    pongTimeoutMs: 15,
    maintenanceIntervalMs: 10,
  });
  try {
    supervisor.start();
    await waitFor(() => supervisor.getState().connected, "durable control socket did not connect");
    const hello = target.hellos[0]!;
    assert.ok((hello.capabilities as string[]).includes("transcript-sync-v1"));
    assert.deepEqual((hello.channels as Record<string, PeonSocketFrame>)["transcript-sync-v1"], {
      snapshotPageEvents: 100,
      snapshotPageBytes: 768 * 1024,
      snapshotEvents: 20_000,
      snapshotBytes: 16 * 1024 * 1024,
      activeSnapshots: 4,
      subscriptions: 64,
      subscriptionTtlMs: 5 * 60_000,
      eventBytes: 192 * 1024,
    });
  } finally {
    supervisor.stop();
    await closeServer(target.server, target.sockets);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("default transfer hello advertises project and sandbox file reads", async () => {
  const target = acceptingServer();
  const base = await listen(target.server);
  const config = { overseerUrl: base, overseerToken: "secret-token", peonId: "peon-files" };
  const supervisor = new PeonSocketSupervisor({
    readSettings: () => config,
    subscribe: () => () => {},
    socketChannel: "file-transfer",
    retryBaseMs: 10,
    retryMaxMs: 40,
    handshakeTimeoutMs: 25,
    maintenanceIntervalMs: 10,
  });
  try {
    supervisor.start();
    await waitFor(() => supervisor.getState().connected, "default transfer socket did not connect");
    assert.deepEqual(target.hellos[0], {
      type: "hello", protocol: 1, channel: "file-transfer", peonId: "peon-files",
      capabilities: ["project-file-read-v1", "sandbox-file-read-v1", "session-artifact-v1", "file-write-v1"],
    });
  } finally {
    supervisor.stop();
    await closeServer(target.server, target.sockets);
  }
});

test("authenticates, handshakes, and reconnects after disconnect", async () => {
  const target = acceptingServer();
  const base = await listen(target.server);
  const config = { overseerUrl: base, overseerToken: "secret-token" };
  const supervisor = testSupervisor(config);
  try {
    supervisor.start();
    await waitFor(() => supervisor.getState().connected, "initial socket did not connect");
    assert.deepEqual(target.auth, ["Bearer secret-token"]);

    [...target.sockets][0]?.terminate();
    await waitFor(() => target.connections >= 2 && supervisor.getState().connected, "socket did not reconnect");
    assert.equal(supervisor.getState().derecruited, false);
  } finally {
    supervisor.stop();
    await closeServer(target.server, target.sockets);
  }
});

test("pool opens and independently maintains control and transfer WebSockets", async () => {
  const target = acceptingServer();
  const base = await listen(target.server);
  const config = { overseerUrl: base, overseerToken: "secret-token", peonId: "peon-1" };
  const first = testSupervisor(config);
  const second = testSupervisor(config, undefined, [], undefined, "file-transfer");
  const pool = new PeonSocketPool([first, second]);
  try {
    pool.start();
    await waitFor(() => pool.getState().connectedConnections === 2, "pool did not open two sockets");
    assert.equal(pool.getState().targetConnections, 2);
    assert.equal(pool.getState().connected, true);
    assert.ok(target.auth.length >= 2);
    assert.ok(target.auth.every((authorization) => authorization === "Bearer secret-token"));
    assert.deepEqual(target.hellos.map((hello) => hello.peonId), ["peon-1", "peon-1"]);
    assert.deepEqual(target.paths.sort(), ["/api/v1/peons/transfer/ws", "/api/v1/peons/ws"]);
    const transferHello = target.hellos.find((hello) => hello.channel === "file-transfer");
    assert.deepEqual(transferHello, {
      type: "hello",
      protocol: 1,
      channel: "file-transfer",
      peonId: "peon-1",
    });

    const survivingSocket = [...target.sockets][1];
    [...target.sockets][0]?.terminate();
    await waitFor(() => pool.getState().connectedConnections === 1, "pool did not report its degraded state");
    assert.equal(survivingSocket?.readyState, WebSocket.OPEN);
    await waitFor(
      () => target.connections >= 3 && pool.getState().connectedConnections === 2,
      "dropped pool member was not independently restored",
    );
    assert.equal(pool.getState().connected, true);
  } finally {
    pool.stop();
    await closeServer(target.server, target.sockets);
  }
});

test("configuration replacement is immediate and stale close cannot disconnect its successor", async () => {
  const first = acceptingServer();
  const second = acceptingServer();
  const firstBase = await listen(first.server);
  const secondBase = await listen(second.server);
  const config = { overseerUrl: firstBase, overseerToken: "first-token" };
  let listener = () => {};
  const supervisor = testSupervisor(config, (next) => {
    listener = next;
    return () => { listener = () => {}; };
  });
  try {
    supervisor.start();
    await waitFor(() => supervisor.getState().connected, "first socket did not connect");
    config.overseerUrl = secondBase;
    config.overseerToken = "second-token";
    listener();
    await waitFor(() => second.connections === 1 && supervisor.getState().connected, "replacement did not connect");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(supervisor.getState().connected, true);
    assert.deepEqual(second.auth, ["Bearer second-token"]);
  } finally {
    supervisor.stop();
    await closeServer(first.server, first.sockets);
    await closeServer(second.server, second.sockets);
  }
});

test("stable Peon identity is carried in hello and identity replacement reconnects", async () => {
  const target = acceptingServer();
  const base = await listen(target.server);
  const config: MutableConfig = { overseerUrl: base, overseerToken: "token", peonId: "peon-one" };
  let listener = () => {};
  const supervisor = testSupervisor(config, (next) => {
    listener = next;
    return () => { listener = () => {}; };
  });
  try {
    supervisor.start();
    await waitFor(() => supervisor.getState().connected, "identity socket did not connect");
    assert.equal(target.hellos[0]?.peonId, "peon-one");
    config.peonId = "peon-two";
    listener();
    await waitFor(() => target.connections >= 2 && supervisor.getState().connected, "identity replacement did not reconnect");
    assert.equal(target.hellos.at(-1)?.peonId, "peon-two");
  } finally {
    supervisor.stop();
    await closeServer(target.server, target.sockets);
  }
});

test("negotiates and routes a feature channel over the established socket", async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const calls: string[] = [];
  const channel: PeonSocketChannel = {
    capability: "test-channel-v1",
    helloState: () => ({ revision: 2 }),
    started: () => {},
    connecting: () => calls.push("connecting"),
    negotiated: (accepted) => calls.push(`negotiated:${accepted}`),
    disconnected: (reset) => calls.push(`disconnected:${reset}`),
    handles: (frame) => frame.type === "test_event",
    receive: (frame) => calls.push(`received:${frame.value}`),
  };
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("message", (data) => {
      const hello = JSON.parse(data.toString()) as Record<string, unknown>;
      assert.deepEqual(hello.capabilities, ["test-channel-v1"]);
      assert.deepEqual((hello.channels as Record<string, unknown>)["test-channel-v1"], { revision: 2 });
      socket.send(JSON.stringify({ type: "hello_ack", protocol: 1, capabilities: ["test-channel-v1"] }));
      socket.send(JSON.stringify({ type: "test_event", value: 9 }));
    });
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  const base = await listen(server);
  const supervisor = testSupervisor({ overseerUrl: base, overseerToken: "token" }, () => () => {}, [channel]);
  try {
    supervisor.start();
    await waitFor(() => calls.includes("received:9"), "negotiated channel did not receive its frame");
    assert.deepEqual(calls.slice(0, 3), ["disconnected:true", "connecting", "negotiated:true"]);
  } finally {
    supervisor.stop();
    await closeServer(server, sockets);
  }
});

test("replays one durable message after disconnect until its cumulative acknowledgement", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-socket-replay-"));
  const outbox = new PeonSocketOutbox({ fileBase: path.join(directory, "outbox") });
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const deliveries: Array<Record<string, unknown>> = [];
  let connections = 0;
  const channel: PeonSocketChannel = {
    capability: "durable-test-v1",
    helloState: () => ({}),
    started: () => {},
    connecting: () => {},
    negotiated: (_accepted, _ack, sender) => {
      sender.sendDurable(
        { type: "durable_test_event", value: 7 },
        { capability: "durable-test-v1", dedupeKey: "logical-event-1" },
      );
    },
    disconnected: () => {},
    handles: () => false,
    receive: () => {},
  };
  wss.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.type === "hello") {
        socket.send(JSON.stringify({
          type: "hello_ack",
          protocol: 1,
          capabilities: ["durable-test-v1", "durable-delivery-v1"],
        }));
        return;
      }
      if (frame.type !== "durable_message") return;
      deliveries.push(frame);
      if (deliveries.length === 1) socket.terminate();
      else socket.send(JSON.stringify({ type: "durable_ack", epoch: frame.epoch, cursor: frame.cursor }));
    });
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  const base = await listen(server);
  const supervisor = testSupervisor({ overseerUrl: base, overseerToken: "token" }, () => () => {}, [channel], outbox);
  try {
    supervisor.start();
    await waitFor(() => connections >= 2 && deliveries.length >= 2, "durable message was not replayed");
    await waitFor(() => outbox.status().pendingMessages === 0, "durable acknowledgement did not compact outbox");
    assert.equal(deliveries[0]?.messageId, deliveries[1]?.messageId);
    assert.equal(deliveries[0]?.cursor, deliveries[1]?.cursor);
    assert.deepEqual(deliveries[1]?.payload, { type: "durable_test_event", value: 7 });
  } finally {
    supervisor.stop();
    await closeServer(server, sockets);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("handshake cumulative acknowledgement notifies channels for every removed cursor", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-socket-handshake-ack-"));
  const outbox = new PeonSocketOutbox({ fileBase: path.join(directory, "outbox") });
  const first = outbox.enqueue({ type: "durable_test_event", value: 1 });
  const second = outbox.enqueue({ type: "durable_test_event", value: 2 });
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  if (!first.accepted || !second.accepted) return;
  const acknowledged: string[] = [];
  const acknowledging: string[] = [];
  const channel: PeonSocketChannel = {
    capability: "durable-test-v1",
    helloState: () => ({}),
    started: () => {},
    connecting: () => {},
    negotiated: () => {},
    disconnected: () => {},
    handles: () => false,
    receive: () => {},
    durableAcknowledging: (cursor) => { acknowledging.push(cursor); return true; },
    durableAcknowledged: (cursor) => acknowledged.push(cursor),
  };
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("message", () => {
      socket.send(JSON.stringify({
        type: "hello_ack",
        protocol: 1,
        capabilities: ["durable-test-v1", "durable-delivery-v1"],
        delivery: { epoch: second.epoch, acknowledgedCursor: second.cursor },
      }));
    });
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  const base = await listen(server);
  const supervisor = testSupervisor({ overseerUrl: base, overseerToken: "token" }, () => () => {}, [channel], outbox);
  try {
    supervisor.start();
    await waitFor(() => supervisor.getState().connected, "socket did not accept handshake acknowledgement");
    assert.deepEqual(acknowledging, [first.cursor, second.cursor]);
    assert.deepEqual(acknowledged, [first.cursor, second.cursor]);
    assert.equal(outbox.status().pendingMessages, 0);
  } finally {
    supervisor.stop();
    await closeServer(server, sockets);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("durable acknowledgement leaves outbox intact when a channel cannot persist its cursor", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-socket-ack-fence-"));
  const outbox = new PeonSocketOutbox({ fileBase: path.join(directory, "outbox") });
  const message = outbox.enqueue({ type: "durable_test_event", value: 1 });
  assert.equal(message.accepted, true);
  if (!message.accepted) return;
  let attempted = 0;
  const channel: PeonSocketChannel = {
    capability: "durable-test-v1",
    helloState: () => ({}),
    started: () => {},
    connecting: () => {},
    negotiated: () => {},
    disconnected: () => {},
    handles: () => false,
    receive: () => {},
    durableAcknowledging: () => { attempted += 1; return false; },
  };
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("message", () => {
      socket.send(JSON.stringify({
        type: "hello_ack",
        protocol: 1,
        capabilities: ["durable-test-v1", "durable-delivery-v1"],
        delivery: { epoch: message.epoch, acknowledgedCursor: message.cursor },
      }));
    });
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  const base = await listen(server);
  const supervisor = testSupervisor({ overseerUrl: base, overseerToken: "token" }, () => () => {}, [channel], outbox);
  try {
    supervisor.start();
    await waitFor(() => attempted === 1, "channel acknowledgement fence was not called");
    assert.equal(outbox.status().pendingMessages, 1);
  } finally {
    supervisor.stop();
    await closeServer(server, sockets);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retains a durable head message until its owning capability is negotiated", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-socket-capability-fence-"));
  const outbox = new PeonSocketOutbox({ fileBase: path.join(directory, "outbox") });
  assert.equal(outbox.enqueue(
    { type: "blocked_feature_event", value: 4 },
    { capability: "blocked-feature-v1" },
  ).accepted, true);
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  let durableMessages = 0;
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.type === "hello") {
        socket.send(JSON.stringify({
          type: "hello_ack",
          protocol: 1,
          capabilities: ["durable-delivery-v1"],
        }));
      } else if (frame.type === "durable_message") {
        durableMessages += 1;
      }
    });
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  const base = await listen(server);
  const supervisor = testSupervisor({ overseerUrl: base, overseerToken: "token" }, () => () => {}, [], outbox);
  try {
    supervisor.start();
    await waitFor(() => supervisor.getState().connected, "socket did not negotiate durable delivery");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(durableMessages, 0);
    assert.equal(outbox.status().pendingMessages, 1);
    assert.match(supervisor.getState().lastError ?? "", /waiting for capability blocked-feature-v1/);
  } finally {
    supervisor.stop();
    await closeServer(server, sockets);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects outbox acknowledgements when durability was not negotiated", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-socket-unnegotiated-ack-"));
  const outbox = new PeonSocketOutbox({ fileBase: path.join(directory, "outbox") });
  const accepted = outbox.enqueue({ type: "durable_test_event", value: 3 });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  let closed = false;
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); closed = true; });
    socket.once("message", () => {
      socket.send(JSON.stringify({ type: "hello_ack", protocol: 1, capabilities: [] }));
      socket.send(JSON.stringify({ type: "durable_ack", epoch: accepted.epoch, cursor: accepted.cursor }));
    });
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  const base = await listen(server);
  const supervisor = testSupervisor({ overseerUrl: base, overseerToken: "token" }, () => () => {}, [], outbox);
  try {
    supervisor.start();
    await waitFor(() => closed, "unnegotiated acknowledgement did not close the socket");
    assert.equal(outbox.status().pendingMessages, 1);
    assert.match(supervisor.getState().lastError ?? "", /unnegotiated durable socket acknowledgement/);
  } finally {
    supervisor.stop();
    await closeServer(server, sockets);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restored outbox negotiation persists channel events before network reconnect", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-socket-offline-"));
  const fileBase = path.join(directory, "outbox");
  const initialOutbox = new PeonSocketOutbox({ fileBase });
  initialOutbox.setNegotiated(true);
  // Model a full daemon restart, not merely a new socket connection.
  const outbox = new PeonSocketOutbox({ fileBase });
  const channel: PeonSocketChannel = {
    capability: "offline-durable-v1",
    helloState: () => ({}),
    started: (sender) => {
      if (sender.durable) sender.sendDurable({ type: "offline_event", value: 11 });
    },
    connecting: () => {},
    negotiated: () => {},
    disconnected: () => {},
    handles: () => false,
    receive: () => {},
  };
  const supervisor = testSupervisor({
    overseerUrl: "http://127.0.0.1:65530",
    overseerToken: "offline-token",
    peonId: "offline-peon",
  }, () => () => {}, [channel], outbox);
  try {
    supervisor.start();
    assert.deepEqual(outbox.pending().map((message) => message.payload), [{ type: "offline_event", value: 11 }]);
  } finally {
    supervisor.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a transient 401 reconnects without a credential change", async () => {
  let requests = 0;
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("message", () => {
      socket.send(JSON.stringify({ type: "hello_ack", protocol: 1 }));
    });
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request: IncomingMessage, socket) => {
    requests += 1;
    if (requests === 1) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, Buffer.alloc(0), (client) => wss.emit("connection", client, request));
  });
  const base = await listen(server);
  const config = { overseerUrl: base, overseerToken: "revoked-token" };
  const supervisor = testSupervisor(config);
  try {
    supervisor.start();
    await waitFor(() => supervisor.getState().connected, "connector did not recover from a transient 401");
    assert.ok(requests >= 2);
    assert.equal(supervisor.getState().derecruited, false);
    assert.equal(config.overseerToken, "revoked-token");
  } finally {
    supervisor.stop();
    await closeServer(server, sockets);
  }
});

test("a black-holed HTTP upgrade times out and reconnects", async () => {
  const server = http.createServer();
  const stalledSockets = new Set<Socket>();
  let upgrades = 0;
  server.on("upgrade", (_request, socket) => {
    upgrades += 1;
    stalledSockets.add(socket);
    socket.once("close", () => stalledSockets.delete(socket));
    // Deliberately send no HTTP response. This simulates a proxy or network
    // path that accepted TCP but swallowed the WebSocket upgrade.
  });
  const base = await listen(server);
  const supervisor = testSupervisor({ overseerUrl: base, overseerToken: "token" });
  try {
    supervisor.start();
    await waitFor(() => upgrades >= 2, "stalled HTTP upgrade suppressed reconnect");
    assert.equal(supervisor.getState().derecruited, false);
  } finally {
    supervisor.stop();
    for (const socket of stalledSockets) socket.destroy();
    await closeServer(server);
  }
});

test("recovers after a sustained outage and after a full supervisor restart", async () => {
  // Reserve an ephemeral address, then take it offline before starting the
  // connector so several real ECONNREFUSED attempts occur first.
  const reservation = http.createServer();
  const base = await listen(reservation);
  const address = reservation.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await closeServer(reservation);

  const config = { overseerUrl: base, overseerToken: "token" };
  const firstSupervisor = testSupervisor(config);
  const target = acceptingServer();
  try {
    firstSupervisor.start();
    await waitFor(() => firstSupervisor.getState().reconnectAttempt >= 2, "offline endpoint was not retried");

    await listen(target.server, port);
    await waitFor(() => firstSupervisor.getState().connected, "connector did not recover when network returned");
    await waitFor(() => firstSupervisor.getState().reconnectAttempt === 0, "stable recovery did not reset backoff");
    firstSupervisor.stop();

    // A daemon restart reconstructs the supervisor from persisted settings. It
    // must reconnect without any in-memory state from the previous instance.
    const restartedSupervisor = testSupervisor(config);
    try {
      restartedSupervisor.start();
      await waitFor(() => restartedSupervisor.getState().connected, "fresh supervisor did not reconnect after restart");
      assert.ok(target.connections >= 2);
    } finally {
      restartedSupervisor.stop();
    }
  } finally {
    firstSupervisor.stop();
    await closeServer(target.server, target.sockets);
  }
});

test("maintenance watchdog recovers when a settings notification is missed", async () => {
  const target = acceptingServer();
  const base = await listen(target.server);
  const config = { overseerUrl: "", overseerToken: "" };
  // No subscription callback is provided: only the independent maintenance
  // loop can notice this configuration transition.
  const supervisor = testSupervisor(config);
  try {
    supervisor.start();
    config.overseerUrl = base;
    config.overseerToken = "token";
    await waitFor(() => supervisor.getState().connected, "maintenance watchdog did not recover missed settings change");
  } finally {
    supervisor.stop();
    await closeServer(target.server, target.sockets);
  }
});

test("handshake stalls and half-open sockets are terminated and retried", async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true, autoPong: false });
  const sockets = new Set<WebSocket>();
  let connections = 0;
  wss.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("message", () => {
      // First connection deliberately stalls the hello. Later connections ack
      // but never pong, exercising the established-socket lease as well.
      if (connections > 1) socket.send(JSON.stringify({ type: "hello_ack", protocol: 1 }));
    });
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  const base = await listen(server);
  const supervisor = testSupervisor({ overseerUrl: base, overseerToken: "token" });
  try {
    supervisor.start();
    await waitFor(() => connections >= 2 && supervisor.getState().connected, "handshake timeout did not retry");
    await waitFor(() => connections >= 3, "heartbeat timeout did not retry", 3_000);
    assert.equal(supervisor.getState().derecruited, false);
  } finally {
    supervisor.stop();
    await closeServer(server, sockets);
  }
});
