import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { broadcast } from "./eventLog.js";
import { claimPeonConnection, releasePeonConnection } from "./peonConnections.js";
import { FOLDER_LISTING_CAPABILITY, folderListingOperations } from "./peonFolderListing.js";
import { authenticatePeonUpgrade } from "./peonSocketAuth.js";
import {
  DURABLE_DELIVERY_CAPABILITY,
  PeonCatalogSync,
  PROJECT_CATALOG_CAPABILITY,
  SESSION_CATALOG_CAPABILITY,
  SessionSyncProtocolError,
  parseSessionCatalogHello,
} from "./peonSessionSync.js";
import { toView, type PeonRecord } from "./registry.js";

const ENDPOINT = "/api/v1/peons/ws";
const PROTOCOL = 1;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const CONNECTION_CHECK_MS = 30_000;
const HELLO_TIMEOUT_MS = 10_000;
const MAX_QUEUED_MESSAGES = 64;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const MAX_GLOBAL_QUEUED_BYTES = 8 * 1024 * 1024;

interface PeonClient {
  ws: WebSocket;
  record: PeonRecord;
  alive: boolean;
  ready: boolean;
  sessionSync: PeonCatalogSync | null;
  messages: Promise<void>;
  queuedMessages: number;
  queuedBytes: number;
}

interface PeonSocketOptions {
  folderOperations?: typeof folderListingOperations;
}

function publishPresence(record: PeonRecord): void {
  broadcast({ workspaceId: record.workspaceId, peonId: record.peonId, kind: "peon", payload: toView(record) });
}

// North-bound Peon transport. Authentication happens before the WebSocket
// upgrade so invalid/revoked credentials never become accepted connections.
export function attachPeonSocket(server: Server, options: PeonSocketOptions = {}): WebSocketServer {
  const folderOperations = options.folderOperations ?? folderListingOperations;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const authenticated = new WeakMap<IncomingMessage, PeonRecord>();
  const clients = new Set<PeonClient>();
  let globalQueuedBytes = 0;

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "", "http://overseer.local").pathname;
    if (path !== ENDPOINT) return;
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

    const client: PeonClient = {
      ws, record, alive: true, ready: false, sessionSync: null, messages: Promise.resolve(), queuedMessages: 0, queuedBytes: 0,
    };
    clients.add(client);
    const helloTimeout = setTimeout(() => ws.close(1008, "hello timeout"), HELLO_TIMEOUT_MS);
    helloTimeout.unref();

    ws.on("pong", () => {
      client.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "text frames only");
      const raw = data.toString();
      const frameBytes = Buffer.byteLength(raw);
      if (frameBytes > MAX_PAYLOAD_BYTES) {
        ws.close(1009, "Peon frame exceeds 1 MiB");
        return;
      }
      if (client.queuedMessages >= MAX_QUEUED_MESSAGES
        || client.queuedBytes + frameBytes > MAX_QUEUED_BYTES
        || globalQueuedBytes + frameBytes > MAX_GLOBAL_QUEUED_BYTES) {
        ws.close(1008, "too many queued Peon messages");
        return;
      }
      client.queuedMessages += 1;
      client.queuedBytes += frameBytes;
      globalQueuedBytes += frameBytes;
      client.messages = client.messages.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        let message: unknown;
        try {
          message = JSON.parse(raw);
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
          if (frame.type !== "hello" || frame.protocol !== PROTOCOL) {
            ws.close(1002, "expected hello protocol 1");
            return;
          }
          if (frame.peonId !== undefined && frame.peonId !== record.peonId) {
            ws.close(1008, "Peon identity mismatch");
            return;
          }
          clearTimeout(helloTimeout);
          client.ready = true;
          const advertised = Array.isArray(frame.capabilities)
            ? frame.capabilities.filter((value): value is string => typeof value === "string")
            : [];
          // Reverse-socket capabilities belong to this authenticated hello. The
          // registry capability list describes the Peon's HTTP API and older
          // Peons do not put transport channels there. Requiring both sources
          // creates a circular negotiation: the Peon cannot enable the channel
          // until we echo it, while we refuse to echo it until it is enabled.
          const advertisesCatalog = advertised.includes(SESSION_CATALOG_CAPABILITY);
          const advertisesDelivery = advertised.includes(DURABLE_DELIVERY_CAPABILITY);
          const advertisesProjects = advertised.includes(PROJECT_CATALOG_CAPABILITY);
          const advertisesFolderListing = advertised.includes(FOLDER_LISTING_CAPABILITY);
          const ephemeralCapabilities = advertisesFolderListing ? [FOLDER_LISTING_CAPABILITY] : [];
          const previous = claimPeonConnection(record.peonId, ws, ephemeralCapabilities);
          if (previous && previous.readyState !== WebSocket.CLOSED) {
            folderOperations.connectionClosed(record.peonId, previous, "CONNECTION_LOST");
            previous.close(4001, "replaced by a newer connection");
          }
          publishPresence(record);
          const supportsCanonical = advertisesCatalog && advertisesDelivery;
          console.info(
            `overseer: Peon socket ${record.peonId} canonical session sync ${supportsCanonical
              ? "negotiated"
              : `not negotiated (catalog=${advertisesCatalog}, delivery=${advertisesDelivery})`}`,
          );
          if (supportsCanonical) {
            if (frame.peonId !== record.peonId) throw new SessionSyncProtocolError("missing or invalid Peon identity");
            const hello = parseSessionCatalogHello(frame);
            if (advertisesProjects && !hello.projectCatalog) throw new SessionSyncProtocolError("missing project catalog channel state");
            client.sessionSync = new PeonCatalogSync(
              record,
              ws,
              hello.catalog,
              hello.delivery,
              advertisesProjects ? hello.projectCatalog : null,
              ephemeralCapabilities,
            );
            await client.sessionSync.start();
          } else {
            // Capability dependency is all-or-nothing. Legacy Peons retain HTTP
            // reconciliation and are never given a partial canonical contract.
            ws.send(JSON.stringify({ type: "hello_ack", protocol: PROTOCOL, capabilities: ephemeralCapabilities }));
          }
          return;
        }
        if (folderOperations.handleFrame(record.peonId, ws, frame, frameBytes)) return;
        if (client.sessionSync && await client.sessionSync.handle(frame, frameBytes)) return;
        ws.close(1008, "unexpected Peon frame");
      }).catch((error) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const protocolError = error instanceof SessionSyncProtocolError;
        const reason = protocolError ? error.message : "session sync failed";
        console.warn(`overseer: Peon socket ${record.peonId} failed: ${reason}`);
        ws.close(protocolError ? 1002 : 1011, reason);
      }).finally(() => {
        client.queuedMessages -= 1;
        client.queuedBytes -= frameBytes;
        globalQueuedBytes -= frameBytes;
      });
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      clearTimeout(helloTimeout);
      client.sessionSync?.dispose();
      folderOperations.connectionClosed(record.peonId, ws);
      clients.delete(client);
      if (client.ready) {
        releasePeonConnection(record.peonId, ws);
        // Re-read current connection presence when publishing. For a replaced
        // socket this remains online; for an administratively evicted socket it
        // becomes offline without allowing a stale close to overwrite either.
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
  }, CONNECTION_CHECK_MS);
  connectionCheck.unref();

  wss.on("close", () => {
    clearInterval(connectionCheck);
    server.off("upgrade", onUpgrade);
  });

  return wss;
}
