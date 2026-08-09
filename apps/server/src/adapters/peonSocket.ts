import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { broadcast } from "../infrastructure/events/index.js";
import {
  activatePeonCommandConnection,
  claimPeonConnection,
  peonConnectionGeneration,
  releasePeonConnection,
} from "../modules/fleet/index.js";
import { authenticatePeonUpgrade } from "./peonSocketAuth.js";
import {
  DURABLE_DELIVERY_CAPABILITY,
  PeonCatalogSync,
  PROJECT_CATALOG_CAPABILITY,
  SESSION_CATALOG_CAPABILITY,
  SessionSyncProtocolError,
  parseSessionCatalogHello,
} from "./peonSessionSync.js";
import {
  SESSION_TRANSCRIPT_CAPABILITY,
  validTranscriptChannelHello,
} from "./peonTranscriptSync.js";
import { toView, type PeonRecord } from "../modules/fleet/index.js";
import {
  parseReverseCommandHello,
  REVERSE_COMMAND_CAPABILITY,
  ReverseCommandCorrelationError,
  ReverseCommandProtocolError,
  reverseCommandGateway,
  type ReverseCommandGateway,
  type ReverseCommandOperation,
} from "../modules/reverseCommands/index.js";
import { RUNTIME_STATE_CAPABILITY } from "../modules/fleet/index.js";

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
  beforeCanonicalHelloAck?: () => Promise<void>;
  commandGateway?: ReverseCommandGateway;
}

function publishPresence(record: PeonRecord): void {
  broadcast({ workspaceId: record.workspaceId, peonId: record.peonId, kind: "peon", payload: toView(record) });
}

function transcriptFailureContext(
  peonId: string,
  frame: Record<string, unknown>,
): { peonId: string; sessionId: string | null; eventId: string | null; cursor: string | null } | null {
  if (frame.type !== "durable_message"
    || frame.capability !== SESSION_TRANSCRIPT_CAPABILITY
    || !frame.payload
    || typeof frame.payload !== "object"
    || Array.isArray(frame.payload)) {
    return null;
  }
  const payload = frame.payload as Record<string, unknown>;
  return {
    peonId,
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : null,
    eventId: typeof payload.eventId === "string" ? payload.eventId : null,
    cursor: typeof frame.cursor === "string" ? frame.cursor : null,
  };
}

function safeControlFailure(error: unknown, fallback: string): string {
  const raw = error instanceof Error && error.message ? error.message : fallback;
  const printable = Array.from(raw, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : character;
  }).join("");
  return printable.slice(0, 300) || fallback;
}

// North-bound Peon transport. Authentication happens before the WebSocket
// upgrade so invalid/revoked credentials never become accepted connections.
export function attachPeonSocket(server: Server, options: PeonSocketOptions = {}): WebSocketServer {
  const commandGateway = options.commandGateway ?? reverseCommandGateway;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const authenticated = new WeakMap<IncomingMessage, { record: PeonRecord }>();
  const clients = new Set<PeonClient>();
  let globalQueuedBytes = 0;

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "", "http://overseer.local").pathname;
    if (path !== ENDPOINT) return;
    socket.on("error", () => {});

    void (async () => {
      const auth = await authenticatePeonUpgrade(req, socket);
      if (!auth || socket.destroyed) return;
      authenticated.set(req, auth);
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    })();
  };
  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws, req) => {
    const auth = authenticated.get(req);
    if (!auth) return ws.close(1011, "authentication state unavailable");
    const { record } = auth;

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
      let projectionFailureContext: ReturnType<typeof transcriptFailureContext> = null;
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
        projectionFailureContext = transcriptFailureContext(record.peonId, frame);
        if (!client.ready) {
          if (frame.type !== "hello" || frame.protocol !== PROTOCOL) {
            ws.close(1002, "expected hello protocol 1");
            return;
          }
          if (frame.peonId !== undefined && frame.peonId !== record.peonId) {
            ws.close(1008, "Peon identity mismatch");
            return;
          }
          const daemonVersion = typeof frame.version === "string"
            && /^(?:v)?\d+\.\d+\.\d+$/.test(frame.version)
            ? frame.version
            : undefined;
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
          const advertisesReverseCommands = advertised.includes(REVERSE_COMMAND_CAPABILITY);
          const advertisesTranscripts = advertised.includes(SESSION_TRANSCRIPT_CAPABILITY);
          const advertisesRuntime = advertised.includes(RUNTIME_STATE_CAPABILITY);
          const advertisedChannels = frame.channels && typeof frame.channels === "object" && !Array.isArray(frame.channels)
            ? frame.channels as Record<string, unknown>
            : {};
          const supportsCanonical = advertisesCatalog && advertisesDelivery;
          if (supportsCanonical
            && advertisesTranscripts
            && !validTranscriptChannelHello(advertisedChannels[SESSION_TRANSCRIPT_CAPABILITY])) {
            throw new SessionSyncProtocolError("invalid transcript channel state");
          }
          let commandOperations: ReverseCommandOperation[] = [];
          if (advertisesReverseCommands && advertisesDelivery) {
            try {
              commandOperations = parseReverseCommandHello(frame);
            } catch (error) {
              throw new SessionSyncProtocolError(
                error instanceof ReverseCommandProtocolError ? error.message : "invalid reverse command hello",
              );
            }
          }
          // reverse-command-v1 terminal results share the same durable frontier.
          // Until that coordinator is independent of catalogs, echo it only on
          // the canonical durable control connection that can commit the ACK.
          const acceptsReverseCommands = supportsCanonical
            && advertisesReverseCommands
            && commandOperations.length > 0;
          const additionalCapabilities = [
            ...(supportsCanonical && advertisesTranscripts ? [SESSION_TRANSCRIPT_CAPABILITY] : []),
            ...(supportsCanonical && advertisesRuntime ? [RUNTIME_STATE_CAPABILITY] : []),
            ...(acceptsReverseCommands ? [REVERSE_COMMAND_CAPABILITY] : []),
          ];
          const negotiatedCapabilities = supportsCanonical
            ? [
                SESSION_CATALOG_CAPABILITY,
                DURABLE_DELIVERY_CAPABILITY,
                ...(advertisesProjects ? [PROJECT_CATALOG_CAPABILITY] : []),
                ...additionalCapabilities,
              ]
            : [];
          const acceptedConnectionFeatures = [...negotiatedCapabilities];
          const stagedConnectionFeatures = acceptedConnectionFeatures.filter(
            (feature) => feature !== REVERSE_COMMAND_CAPABILITY,
          );
          const claimed = claimPeonConnection(
            record.peonId,
            ws,
            stagedConnectionFeatures,
            [],
            daemonVersion,
          );
          if (!claimed.accepted) {
            ws.close(4001, "connection rejected");
            return;
          }
          const previous = claimed.previous;
          if (previous && previous.readyState !== WebSocket.CLOSED) {
            previous.close(4001, "replaced by a newer connection");
          }
          publishPresence(record);
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
              additionalCapabilities,
              {},
              peonConnectionGeneration(ws) ?? undefined,
            );
            await client.sessionSync.start(options.beforeCanonicalHelloAck);
            const generation = peonConnectionGeneration(ws);
            if (acceptsReverseCommands && generation
              && activatePeonCommandConnection(
                record.peonId,
                ws,
                generation,
                REVERSE_COMMAND_CAPABILITY,
                commandOperations,
              )) {
              await commandGateway.connectionReady(record.workspaceId, record.peonId, ws);
            }
          } else {
            // Capability dependency is all-or-nothing. Legacy Peons retain HTTP
            // reconciliation and are never given a partial canonical contract.
            ws.send(JSON.stringify({
              type: "hello_ack",
              protocol: PROTOCOL,
              capabilities: negotiatedCapabilities,
            }));
          }
          return;
        }
        if (await commandGateway.handleEphemeralFrame(record.workspaceId, record.peonId, ws, frame)) return;
        if (client.sessionSync && await client.sessionSync.handle(frame, frameBytes)) return;
        ws.close(1008, "unexpected Peon frame");
      }).catch((error) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (error instanceof ReverseCommandCorrelationError) {
          console.warn(
            `overseer: Peon socket ${record.peonId} ignored recoverable command frame: ${safeControlFailure(error, "stale command frame")}`,
          );
          return;
        }
        const protocolError = error instanceof SessionSyncProtocolError
          || error instanceof ReverseCommandProtocolError;
        const reason = safeControlFailure(
          error,
          protocolError ? "invalid control frame" : "session sync failed",
        );
        console.warn(
          `overseer: Peon socket ${record.peonId} failed: ${reason}`,
          ...(projectionFailureContext ? [JSON.stringify(projectionFailureContext)] : []),
        );
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
      const commandGeneration = peonConnectionGeneration(ws);
      if (commandGeneration) {
        void commandGateway.connectionClosed(
          record.workspaceId,
          record.peonId,
          commandGeneration,
        ).catch(() => undefined);
      }
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
