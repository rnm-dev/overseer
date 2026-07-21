import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { broadcast } from "./eventLog.js";
import { authenticatePeonUpgrade } from "./peonSocketAuth.js";
import {
  claimPeonTransferConnection,
  PROJECT_FILE_READ_CAPABILITY,
  releasePeonTransferConnection,
} from "./peonTransferConnections.js";
import { toView, type PeonRecord } from "./registry.js";
import { failPeonFileTransfers, handlePeonFileBinary, handlePeonFileJson } from "./peonFileStream.js";

export const PEON_TRANSFER_SOCKET_PATH = "/api/v1/peons/transfer/ws";

const PROTOCOL = 1;
const CHANNEL = "file-transfer";
const MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_CONNECTION_CHECK_MS = 30_000;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

interface TransferClient {
  ws: WebSocket;
  record: PeonRecord;
  alive: boolean;
  ready: boolean;
}

interface TransferSocketOptions {
  connectionCheckMs?: number;
  helloTimeoutMs?: number;
}

function publishPresence(record: PeonRecord): void {
  broadcast({ workspaceId: record.workspaceId, peonId: record.peonId, kind: "peon", payload: toView(record) });
}

// Dedicated data-plane socket. For now it only authenticates, handshakes, and
// proves liveness; request multiplexing and binary file frames arrive later.
export function attachPeonTransferSocket(server: Server, options: TransferSocketOptions = {}): WebSocketServer {
  const connectionCheckMs = options.connectionCheckMs ?? DEFAULT_CONNECTION_CHECK_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const authenticated = new WeakMap<IncomingMessage, PeonRecord>();
  const clients = new Set<TransferClient>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? "", "http://overseer.local").pathname;
    if (pathname !== PEON_TRANSFER_SOCKET_PATH) return;
    socket.on("error", () => {});

    void (async () => {
      const record = await authenticatePeonUpgrade(req, socket);
      if (!record || socket.destroyed) return;
      authenticated.set(req, record);
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    })();
  };
  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws, req) => {
    const record = authenticated.get(req);
    if (!record) return ws.close(1011, "authentication state unavailable");

    const client: TransferClient = { ws, record, alive: true, ready: false };
    clients.add(client);
    const helloTimeout = setTimeout(() => ws.close(1008, "hello timeout"), helloTimeoutMs);
    helloTimeout.unref();

    ws.on("pong", () => {
      client.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!client.ready || !handlePeonFileBinary(record.peonId, ws, Buffer.from(data as ArrayBuffer))) ws.close(1008, "invalid file transfer frame");
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        ws.close(1007, "invalid JSON");
        return;
      }
      if (!message || typeof message !== "object") {
        ws.close(1002, "invalid protocol frame");
        return;
      }
      const frame = message as Record<string, unknown>;
      if (!client.ready) {
        if (frame.type !== "hello" || frame.protocol !== PROTOCOL || frame.channel !== CHANNEL) {
          ws.close(1002, "expected file-transfer hello protocol 1");
          return;
        }
        if (frame.peonId !== undefined && frame.peonId !== record.peonId) {
          ws.close(1008, "Peon identity mismatch");
          return;
        }
        const advertised = Array.isArray(frame.capabilities)
          ? frame.capabilities.filter((value): value is string => typeof value === "string")
          : [];
        const accepted = advertised.includes(PROJECT_FILE_READ_CAPABILITY) ? [PROJECT_FILE_READ_CAPABILITY] : [];
        clearTimeout(helloTimeout);
        client.ready = true;
        const previous = claimPeonTransferConnection(record.peonId, ws, accepted);
        if (previous && previous.readyState !== WebSocket.CLOSED) {
          failPeonFileTransfers(record.peonId, previous, "PEON_TRANSFER_REPLACED");
          previous.close(4001, "replaced by a newer transfer connection");
        }
        publishPresence(record);
        ws.send(JSON.stringify({ type: "hello_ack", protocol: PROTOCOL, channel: CHANNEL, capabilities: accepted }));
        return;
      }
      if (!handlePeonFileJson(record.peonId, ws, frame)) ws.close(1008, "invalid file transfer frame");
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      clearTimeout(helloTimeout);
      clients.delete(client);
      if (client.ready && releasePeonTransferConnection(record.peonId, ws)) {
        failPeonFileTransfers(record.peonId, ws);
        publishPresence(record);
      }
    });
  });

  const connectionCheck = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, connectionCheckMs);
  connectionCheck.unref();

  wss.on("close", () => {
    clearInterval(connectionCheck);
    server.off("upgrade", onUpgrade);
  });

  return wss;
}
