import WebSocket from "ws";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../../protocol.js";
import {
  PeonSocketMultiplexer,
  PEON_SOCKET_MAX_FRAME_BYTES,
  type PeonSocketChannel,
  type PeonSocketDurableOptions,
  type PeonSocketDurableResult,
  type PeonSocketFrame,
  type PeonSocketSender,
} from "./peonSocketProtocol.js";
import {
  PEON_SOCKET_DURABLE_DELIVERY_CAPABILITY,
  PeonSocketOutbox,
  type PeonSocketOutboxStatus,
} from "./peonSocketOutbox.js";
import { SessionCatalogChannel } from "./channels/sessionCatalogChannel.js";
import { SessionWarningChannel } from "./channels/sessionWarningChannel.js";
import { ProjectCatalogChannel } from "./channels/projectCatalogChannel.js";
import { ReverseCommandChannel } from "./channels/reverseCommandChannel.js";
import type { ReverseCommandHandler } from "./channels/reverseCommandChannel.js";
import { RuntimeStateChannel } from "./channels/runtimeStateChannel.js";
import { TranscriptChannel } from "./channels/transcriptChannel.js";
import { settings, type PeonSocketSettings } from "../../settings/index.js";

const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_STABLE_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_PING_INTERVAL_MS = 15_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 5_000;
const CONTROL_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const OUTBOX_RETRY_MS = 50;
const OUTBOX_ACK_TIMEOUT_MS = 10_000;

function daemonVersion(): string {
  try {
    const path = fileURLToPath(new URL("../../../../package.json", import.meta.url));
    return String((JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

type Timer = ReturnType<typeof setTimeout>;

interface PeonSocketConfig {
  base: string;
  token: string;
  peonId?: string;
}

export interface PeonSocketState {
  enabled: boolean;
  connecting: boolean;
  connected: boolean;
  derecruited: boolean;
  connectedAt: number | null;
  lastDisconnectedAt: number | null;
  reconnectAttempt: number;
  nextRetryAt: number | null;
  lastError: string | null;
  outbox: PeonSocketOutboxStatus | null;
}

export interface PeonSocketPoolState extends PeonSocketState {
  targetConnections: number;
  connectedConnections: number;
  connectingConnections: number;
}

interface PeonSocketOptions {
  readSettings?: () => PeonSocketSettings;
  subscribe?: (listener: () => void) => () => void;
  random?: () => number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  stableMs?: number;
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  maintenanceIntervalMs?: number;
  channels?: PeonSocketChannel[];
  outbox?: PeonSocketOutbox;
  outboxFactory?: () => PeonSocketOutbox;
}

function defaultSubscribe(listener: () => void): () => void {
  settings.on("change", listener);
  return () => settings.off("change", listener);
}

export function peonSocketUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else throw new Error("overseerUrl must use http or https");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/v1/peons/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

// Owns exactly one outbound Peon socket generation. Every callback checks both
// the generation and socket identity so a replaced socket can never tear down,
// reschedule, or otherwise mutate its successor.
export class PeonSocketSupervisor {
  private readonly readSettings: () => PeonSocketSettings;
  private readonly subscribe: (listener: () => void) => () => void;
  private readonly random: () => number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly stableMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private socket: WebSocket | null = null;
  private generation = 0;
  private credentials = "";
  private retryTimer: Timer | null = null;
  private handshakeTimer: Timer | null = null;
  private stableTimer: Timer | null = null;
  private pingTimer: Timer | null = null;
  private pongTimer: Timer | null = null;
  private maintenanceTimer: Timer | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private readonly multiplexer: PeonSocketMultiplexer;
  private outbox: PeonSocketOutbox | null;
  private readonly outboxFactory: (() => PeonSocketOutbox) | null;
  private outboxFlushTimer: Timer | null = null;
  private outboxAckTimer: Timer | null = null;
  private sentOutboxCursors = new Set<string>();
  private acceptedCapabilities = new Set<string>();
  private state: PeonSocketState = {
    enabled: false,
    connecting: false,
    connected: false,
    derecruited: false,
    connectedAt: null,
    lastDisconnectedAt: null,
    reconnectAttempt: 0,
    nextRetryAt: null,
    lastError: null,
    outbox: null,
  };
  private readonly reverseCommandChannel: ReverseCommandChannel | null;

  constructor(options: PeonSocketOptions = {}) {
    this.readSettings = options.readSettings ?? (() => settings.getPeonSocketSettings());
    this.subscribe = options.subscribe ?? defaultSubscribe;
    this.random = options.random ?? Math.random;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    this.maxFrameBytes = PEON_SOCKET_MAX_FRAME_BYTES;
    this.maxBufferedBytes = CONTROL_MAX_BUFFERED_BYTES;
    const hasDurableOutbox = Boolean(options.outbox || options.outboxFactory);
    this.reverseCommandChannel = hasDurableOutbox
      ? new ReverseCommandChannel({ peonId: () => this.configured()?.peonId })
      : null;
    const defaultChannels = [
          new SessionCatalogChannel(),
          ...(hasDurableOutbox ? [new ProjectCatalogChannel()] : []),
          new SessionWarningChannel(),
          ...(hasDurableOutbox ? [new TranscriptChannel()] : []),
          ...(this.reverseCommandChannel ? [this.reverseCommandChannel] : []),
          ...(hasDurableOutbox ? [new RuntimeStateChannel()] : []),
        ];
    this.multiplexer = new PeonSocketMultiplexer(options.channels ?? defaultChannels);
    this.outbox = options.outbox ?? null;
    this.outboxFactory = options.outboxFactory ?? null;
  }

  registerReverseCommandHandlers(handlers: Record<string, ReverseCommandHandler>): void {
    this.reverseCommandChannel?.registerHandlers(handlers);
  }

  start(): void {
    if (this.started) return;
    this.outbox ??= this.outboxFactory?.() ?? null;
    this.started = true;
    this.unsubscribe = this.subscribe(() => this.refresh());
    // Resolve and destination-bind current settings before restoring offline
    // producers. A changed enrollment clears persisted negotiation; an unchanged
    // one may resume durable production while the first reconnect is in flight.
    this.refresh();
    const supervisor = this;
    const offlineSender: PeonSocketSender = {
      get durable() { return supervisor.outbox?.status().negotiated === true; },
      get authority() {
        const configured = supervisor.configured();
        return configured ? supervisor.destinationHash(configured) : null;
      },
      get generation() { return supervisor.generation; },
      send: () => false,
      sendBinary: () => false,
      sendDurable: (frame, options) => supervisor.enqueueDurable(frame, options),
      disconnect: (reason) => { supervisor.state.lastError = reason; },
    };
    this.multiplexer.started(offlineSender);
    this.scheduleMaintenance();
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer("maintenanceTimer");
    this.replaceSocket(true);
    this.credentials = "";
    this.state.enabled = false;
  }

  refresh(): void {
    if (!this.started) return;
    const config = this.configured();
    const credentials = config ? this.configKey(config) : "";
    if (credentials === this.credentials) return;

    this.credentials = credentials;
    this.generation += 1;
    this.replaceSocket(true);
    this.state = {
      ...this.state,
      enabled: Boolean(config),
      connecting: false,
      connected: false,
      derecruited: false,
      connectedAt: null,
      reconnectAttempt: 0,
      nextRetryAt: null,
      lastError: null,
    };
    if (config) this.connect(config, this.generation);
  }

  getState(): PeonSocketState {
    return { ...this.state, outbox: this.outbox?.status() ?? null };
  }

  private configured(): PeonSocketConfig | null {
    const current = this.readSettings();
    const base = current.overseerUrl.trim();
    const token = current.overseerToken.trim();
    const peonId = current.peonId?.trim();
    return base && token ? { base, token, ...(peonId ? { peonId } : {}) } : null;
  }

  private connect(config: PeonSocketConfig, generation: number): void {
    if (!this.started || generation !== this.generation || this.socket) return;
    if (this.outbox && !this.outbox.bindDestination(this.destinationHash(config))) {
      this.state.lastError = "unable to bind durable socket outbox to Overseer destination";
      this.scheduleReconnect(generation);
      return;
    }
    this.multiplexer.connecting();

    let socket: WebSocket;
    try {
      socket = new WebSocket(peonSocketUrl(config.base), {
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Peon-Protocol": String(PROTOCOL_VERSION),
        },
        followRedirects: false,
        // Covers DNS/TCP/TLS/HTTP-upgrade stalls. The application hello timer
        // below only begins after `open`, so both phases need an independent
        // deadline or a black-holed proxy can suppress reconnect forever.
        handshakeTimeout: this.handshakeTimeoutMs,
        maxPayload: this.maxFrameBytes,
      });
    } catch (error) {
      this.state.lastError = this.errorText(error);
      this.scheduleReconnect(generation);
      return;
    }

    this.socket = socket;
    this.state.connecting = true;
    this.state.nextRetryAt = null;

    const current = () => this.started && generation === this.generation && this.socket === socket;
    socket.once("open", () => {
      if (!current()) return;
      try {
        const identity = config.peonId ? { peonId: config.peonId } : {};
        const hello: PeonSocketFrame = this.multiplexer.hello(PROTOCOL_VERSION, identity);
        hello.version = daemonVersion();
        if (this.outbox) {
          hello.capabilities = [...new Set([
            ...(Array.isArray(hello.capabilities) ? hello.capabilities.filter((value): value is string => typeof value === "string") : []),
            PEON_SOCKET_DURABLE_DELIVERY_CAPABILITY,
          ])];
          hello.delivery = this.outbox.status();
        }
        socket.send(JSON.stringify(hello), (error) => {
          if (!error || !current()) return;
          this.state.lastError = this.errorText(error);
          socket.terminate();
        });
      } catch (error) {
        this.state.lastError = this.errorText(error);
        socket.terminate();
        return;
      }
      this.handshakeTimer = setTimeout(() => {
        if (!current() || this.state.connected) return;
        this.state.lastError = "WebSocket hello timed out";
        socket.terminate();
      }, this.handshakeTimeoutMs);
    });

    let durableAccepted = false;
    const socketSupervisor = this;
    const sender: PeonSocketSender = {
      get durable() { return durableAccepted; },
      get authority() { return socketSupervisor.destinationHash(config); },
      get generation() { return generation; },
      send: (frame) => this.sendFrame(socket, current, frame),
      sendBinary: (frame) => this.sendBinaryFrame(socket, current, frame),
      sendDurable: (frame, options) => this.sendDurable(socket, current, frame, options),
      disconnect: (reason) => {
        if (!current()) return;
        this.state.lastError = reason;
        socket.terminate();
      },
    };
    socket.on("message", (data, isBinary) => {
      if (!current()) return;
      if (isBinary) {
        if (!this.state.connected || !this.multiplexer.receiveBinary(Buffer.from(data as ArrayBuffer), sender)) {
          sender.disconnect("unsupported binary Peon socket frame");
        }
        return;
      }
      let frame: PeonSocketFrame;
      try {
        const parsed = JSON.parse(data.toString()) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid Peon socket frame");
        frame = parsed as PeonSocketFrame;
        if (this.state.connected) {
          if (frame.type === "durable_ack") {
            if (!durableAccepted) return sender.disconnect("unnegotiated durable socket acknowledgement");
            this.handleOutboxAck(frame, socket, current);
            return;
          }
          this.multiplexer.receive(frame, sender);
          return;
        }
        if (frame.type !== "hello_ack" || frame.protocol !== PROTOCOL_VERSION) {
          throw new Error("unexpected hello response");
        }
      } catch (error) {
        this.state.lastError = this.errorText(error);
        // Do not wait for a close handshake from a peer that has already
        // violated the opening protocol; immediate disposal starts recovery.
        socket.terminate();
        return;
      }
      this.clearTimer("handshakeTimer");
      this.state.connecting = false;
      this.state.connected = true;
      this.state.derecruited = false;
      this.state.connectedAt = Date.now();
      this.state.lastError = null;
      durableAccepted = Array.isArray(frame.capabilities) && frame.capabilities.includes(PEON_SOCKET_DURABLE_DELIVERY_CAPABILITY);
      this.acceptedCapabilities = new Set(
        Array.isArray(frame.capabilities)
          ? frame.capabilities.filter((value): value is string => typeof value === "string")
          : [],
      );
      this.outbox?.setNegotiated(durableAccepted);
      this.sentOutboxCursors.clear();
      if (durableAccepted && this.outbox) {
        const acknowledgement = frame.delivery as PeonSocketFrame | undefined;
        const acknowledgedEpoch = acknowledgement?.epoch;
        const acknowledgedCursor = acknowledgement?.acknowledgedCursor;
        if (acknowledgedEpoch === this.outbox.status().epoch && typeof acknowledgedCursor === "string") {
          if (!this.acknowledgeOutbox(acknowledgedEpoch, acknowledgedCursor)) {
            this.state.lastError = "invalid durable socket handshake acknowledgement";
          }
        }
      }
      this.multiplexer.negotiated(frame, sender);
      if (durableAccepted && this.outbox) this.flushOutbox(socket, current);
      console.log(`overseer: control WebSocket connected to ${new URL(config.base).origin}`);
      this.startLiveness(socket, generation);
      this.stableTimer = setTimeout(() => {
        if (current() && this.state.connected) this.state.reconnectAttempt = 0;
      }, this.stableMs);
    });

    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      if (!current()) return;
      if (response.statusCode === 401) {
        const firstAuthFailure = !this.state.derecruited;
        this.state.derecruited = true;
        this.state.lastError = "credential rejected (401); retrying";
        if (firstAuthFailure) {
          console.warn("overseer: WebSocket credential rejected (401) — reconnecting with backoff");
        }
      } else {
        this.state.lastError = `WebSocket upgrade -> ${response.statusCode}`;
      }
      // With an `unexpected-response` listener ws leaves disposal to us. End
      // the handshake explicitly so the normal close path can retry (or stay
      // parked for a revoked credential) instead of hanging in CONNECTING.
      socket.terminate();
    });

    socket.on("error", (error) => {
      if (!current()) return;
      if (!this.state.derecruited) this.state.lastError = this.errorText(error);
      // `ws` normally follows errors with close, but recovery must not depend
      // on that implementation detail. Termination guarantees the fenced close
      // handler runs and schedules the next attempt.
      socket.terminate();
    });

    socket.once("close", () => {
      if (!current()) return;
      this.socket = null;
      this.clearConnectionTimers();
      this.state.connecting = false;
      this.state.connected = false;
      this.state.connectedAt = null;
      this.state.lastDisconnectedAt = Date.now();
      this.clearOutboxTimers();
      this.sentOutboxCursors.clear();
      this.multiplexer.disconnected(false);
      this.scheduleReconnect(generation);
    });
  }

  private startLiveness(socket: WebSocket, generation: number): void {
    const current = () => this.started && generation === this.generation && this.socket === socket;
    const ping = () => {
      if (!current() || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.ping(undefined, undefined, (error) => {
          if (!error || !current()) return;
          this.state.lastError = this.errorText(error);
          socket.terminate();
        });
      } catch (error) {
        this.state.lastError = this.errorText(error);
        socket.terminate();
        return;
      }
      this.pongTimer = setTimeout(() => {
        if (!current()) return;
        this.state.lastError = "WebSocket heartbeat timed out";
        socket.terminate();
      }, this.pongTimeoutMs);
      this.pingTimer = setTimeout(ping, this.pingIntervalMs);
    };
    socket.on("pong", () => {
      if (current()) this.clearTimer("pongTimer");
    });
    this.pingTimer = setTimeout(ping, this.pingIntervalMs);
  }

  private scheduleReconnect(generation: number): void {
    if (!this.started || generation !== this.generation || this.retryTimer) return;
    const config = this.configured();
    if (!config || this.configKey(config) !== this.credentials) {
      this.refresh();
      return;
    }
    const attempt = this.state.reconnectAttempt;
    const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(attempt, 30)));
    const delay = Math.max(1, Math.round(exponential * (0.8 + this.random() * 0.4)));
    this.state.reconnectAttempt = attempt + 1;
    this.state.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.state.nextRetryAt = null;
      const latest = this.configured();
      if (latest && generation === this.generation) this.connect(latest, generation);
    }, delay);
  }

  // Independent belt-and-suspenders loop. Normal operation is event-driven,
  // but durable presence should recover even if an OS/socket edge fails to
  // deliver a close callback or a future settings source misses a notification.
  // It also repairs an impossible-but-safe CLOSED socket reference rather than
  // allowing one lost transition to suppress retries forever.
  private scheduleMaintenance(): void {
    if (!this.started || this.maintenanceTimer) return;
    this.maintenanceTimer = setTimeout(() => {
      this.maintenanceTimer = null;
      if (!this.started) return;

      const config = this.configured();
      const credentials = config ? this.configKey(config) : "";
      if (credentials !== this.credentials) {
        this.refresh();
      } else if (this.socket?.readyState === WebSocket.CLOSED) {
        this.socket = null;
        this.clearConnectionTimers();
        this.state.connecting = false;
        this.state.connected = false;
      }

      if (config && !this.socket && !this.retryTimer) {
        this.connect(config, this.generation);
      }
      this.scheduleMaintenance();
    }, this.maintenanceIntervalMs);
  }

  private replaceSocket(resetAuthority = false): void {
    this.clearTimer("retryTimer");
    this.clearConnectionTimers();
    const old = this.socket;
    this.socket = null;
    this.multiplexer.disconnected(resetAuthority);
    this.clearOutboxTimers();
    this.sentOutboxCursors.clear();
    this.acceptedCapabilities.clear();
    // Configuration changes and shutdown must not retain a half-open old TCP
    // connection for ws's close-handshake grace period. Identity fencing makes
    // its resulting callbacks inert, and terminate releases it immediately.
    if (old && old.readyState !== WebSocket.CLOSED) old.terminate();
  }

  private clearConnectionTimers(): void {
    this.clearTimer("handshakeTimer");
    this.clearTimer("stableTimer");
    this.clearTimer("pingTimer");
    this.clearTimer("pongTimer");
  }

  private clearTimer(key: "retryTimer" | "handshakeTimer" | "stableTimer" | "pingTimer" | "pongTimer" | "maintenanceTimer" | "outboxFlushTimer" | "outboxAckTimer"): void {
    const timer = this[key];
    if (timer) clearTimeout(timer);
    this[key] = null;
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private configKey(config: PeonSocketConfig): string {
    return `${config.base}\n${config.token}\n${config.peonId ?? ""}`;
  }

  private destinationHash(config: PeonSocketConfig): string {
    return createHash("sha256")
      .update(config.base)
      .update("\0")
      .update(config.token)
      .update("\0")
      .update(config.peonId ?? "")
      .digest("hex");
  }

  private sendDurable(
    socket: WebSocket,
    current: () => boolean,
    frame: PeonSocketFrame,
    options?: PeonSocketDurableOptions,
  ): PeonSocketDurableResult {
    const result = this.enqueueDurable(frame, options);
    if (result.accepted && current() && this.state.connected) this.flushOutbox(socket, current);
    return result;
  }

  private enqueueDurable(frame: PeonSocketFrame, options?: PeonSocketDurableOptions): PeonSocketDurableResult {
    if (!this.outbox) return { accepted: false, code: "PERSIST_FAILED", error: "durable socket outbox is unavailable" };
    const coalescedCursor = options?.coalesceKey
      ? this.outbox.pendingForDelivery().find((message) => message.coalesceKey === options.coalesceKey)?.cursor
      : undefined;
    // Once a cursor has crossed this connection it is immutable: Overseer may
    // already have committed those exact bytes. A later replaceable projection
    // receives a new cursor instead of rewriting an in-flight message.
    const safeOptions = coalescedCursor && this.sentOutboxCursors.has(coalescedCursor)
      ? { ...options, coalesceKey: undefined }
      : options;
    const result = this.outbox.enqueue(frame, safeOptions);
    return result;
  }

  private flushOutbox(socket: WebSocket, current: () => boolean): void {
    if (!this.outbox || !current() || !this.state.connected) return;
    this.clearTimer("outboxFlushTimer");
    for (const message of this.outbox.pendingForDelivery()) {
      if (this.sentOutboxCursors.has(message.cursor)) continue;
      if (message.capability && !this.acceptedCapabilities.has(message.capability)) {
        this.state.lastError = `durable delivery is waiting for capability ${message.capability}`;
        return;
      }
      const sent = this.sendFrame(socket, current, {
        type: "durable_message",
        epoch: message.epoch,
        cursor: message.cursor,
        messageId: message.messageId,
        priority: message.priority,
        ...(message.capability ? { capability: message.capability } : {}),
        payload: message.payload,
      });
      if (!sent) {
        this.outboxFlushTimer = setTimeout(() => this.flushOutbox(socket, current), OUTBOX_RETRY_MS);
        return;
      }
      this.sentOutboxCursors.add(message.cursor);
    }
    if (this.outbox.status().pendingMessages > 0 && !this.outboxAckTimer) {
      this.outboxAckTimer = setTimeout(() => {
        this.outboxAckTimer = null;
        this.sentOutboxCursors.clear();
        this.flushOutbox(socket, current);
      }, OUTBOX_ACK_TIMEOUT_MS);
    }
  }

  private handleOutboxAck(frame: PeonSocketFrame, socket: WebSocket, current: () => boolean): void {
    if (!this.outbox || typeof frame.epoch !== "string" || typeof frame.cursor !== "string"
      || !this.acknowledgeOutbox(frame.epoch, frame.cursor)) {
      this.state.lastError = "invalid durable socket acknowledgement";
      return;
    }
    const pending = new Set(this.outbox.pendingForDelivery().map((message) => message.cursor));
    this.sentOutboxCursors = new Set([...this.sentOutboxCursors].filter((cursor) => pending.has(cursor)));
    if (this.outboxAckTimer) clearTimeout(this.outboxAckTimer);
    this.outboxAckTimer = null;
    this.flushOutbox(socket, current);
  }

  private acknowledgeOutbox(epoch: string, cursor: string): boolean {
    if (!this.outbox) return false;
    const pending = this.outbox.pendingForDelivery();
    const index = pending.findIndex((message) => message.cursor === cursor);
    const acknowledged = index < 0 ? [] : pending.slice(0, index + 1).map((message) => message.cursor);
    for (const removedCursor of acknowledged) {
      if (!this.multiplexer.durableAcknowledging(removedCursor)) return false;
    }
    if (!this.outbox.acknowledge(epoch, cursor)) return false;
    for (const removedCursor of acknowledged) this.multiplexer.durableAcknowledged(removedCursor);
    return true;
  }

  private clearOutboxTimers(): void {
    if (this.outboxFlushTimer) clearTimeout(this.outboxFlushTimer);
    if (this.outboxAckTimer) clearTimeout(this.outboxAckTimer);
    this.outboxFlushTimer = null;
    this.outboxAckTimer = null;
  }

  private sendFrame(socket: WebSocket, current: () => boolean, frame: PeonSocketFrame): boolean {
    if (!current() || socket.readyState !== WebSocket.OPEN) return false;
    const payload = JSON.stringify(frame);
    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes > this.maxFrameBytes || socket.bufferedAmount + payloadBytes > this.maxBufferedBytes) return false;
    try {
      socket.send(payload, (error) => {
        if (!error || !current()) return;
        this.state.lastError = this.errorText(error);
        socket.terminate();
      });
      return true;
    } catch (error) {
      this.state.lastError = this.errorText(error);
      socket.terminate();
      return false;
    }
  }

  private sendBinaryFrame(socket: WebSocket, current: () => boolean, frame: Uint8Array): boolean {
    if (!current() || socket.readyState !== WebSocket.OPEN || frame.byteLength > this.maxFrameBytes
      || socket.bufferedAmount + frame.byteLength > this.maxBufferedBytes) return false;
    try {
      socket.send(frame, { binary: true }, (error) => {
        if (!error || !current()) return;
        this.state.lastError = this.errorText(error);
        socket.terminate();
      });
      return true;
    } catch (error) {
      this.state.lastError = this.errorText(error);
      socket.terminate();
      return false;
    }
  }
}

// Overseer uses one control/realtime socket for capabilities and durable
// delivery. File bytes use Fleet HTTP and do not participate in this pool.
export class PeonSocketPool {
  constructor(private readonly supervisors: PeonSocketSupervisor[]) {
    if (supervisors.length === 0) throw new Error("Peon socket pool requires at least one connection");
  }

  start(): void {
    for (const supervisor of this.supervisors) supervisor.start();
  }

  stop(): void {
    for (const supervisor of this.supervisors) supervisor.stop();
  }

  refresh(): void {
    for (const supervisor of this.supervisors) supervisor.refresh();
  }

  getState(): PeonSocketPoolState {
    const states = this.supervisors.map((supervisor) => supervisor.getState());
    const enabled = states.some((state) => state.enabled);
    const connectedConnections = states.filter((state) => state.connected).length;
    const connectingConnections = states.filter((state) => state.connecting).length;
    const connected = enabled && connectedConnections === states.length;
    const connectedTimes = states
      .map((state) => state.connectedAt)
      .filter((value): value is number => value !== null);
    const disconnectedTimes = states
      .map((state) => state.lastDisconnectedAt)
      .filter((value): value is number => value !== null);
    const retryTimes = states
      .map((state) => state.nextRetryAt)
      .filter((value): value is number => value !== null);
    const unhealthy = states.find((state) => !state.connected && state.lastError);
    const primary = states[0];

    return {
      enabled,
      connecting: connectingConnections > 0,
      connected,
      derecruited: states.some((state) => state.derecruited),
      connectedAt: connected && connectedTimes.length > 0 ? Math.max(...connectedTimes) : null,
      lastDisconnectedAt: disconnectedTimes.length > 0 ? Math.max(...disconnectedTimes) : null,
      reconnectAttempt: Math.max(...states.map((state) => state.reconnectAttempt)),
      nextRetryAt: retryTimes.length > 0 ? Math.min(...retryTimes) : null,
      lastError: unhealthy?.lastError ?? primary?.lastError ?? null,
      outbox: primary?.outbox ?? null,
      targetConnections: states.length,
      connectedConnections,
      connectingConnections,
    };
  }

  registerReverseCommandHandlers(handlers: Record<string, ReverseCommandHandler>): void {
    for (const supervisor of this.supervisors) supervisor.registerReverseCommandHandlers(handlers);
  }
}

export const peonSocket = new PeonSocketPool([
  new PeonSocketSupervisor({ outboxFactory: () => new PeonSocketOutbox() }),
]);
