import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { getPeonConnection, peonConnectionSupports } from "./peonConnections.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFERED_OUTPUT_BYTES = 4 * 1024 * 1024;

export type PeonOperationFrame = Record<string, unknown>;

export class PeonOperationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 502) {
    super(message);
    this.name = "PeonOperationError";
  }
}

export type PeonOperationStep<TState, TResult> =
  | { done: true; result: TResult }
  | { done: false; state: TState; next: PeonOperationFrame };

export interface PeonOperationProtocol<TInput, TState, TResult> {
  readonly capability: string;
  handles(frame: PeonOperationFrame): boolean;
  start(requestId: string, input: TInput): { frame: PeonOperationFrame; state: TState };
  receive(requestId: string, state: TState, frame: PeonOperationFrame, frameBytes: number): PeonOperationStep<TState, TResult>;
  cancel(requestId: string): PeonOperationFrame;
  isCancellationAcknowledgement(frame: PeonOperationFrame): boolean;
}

interface Pending<TState, TResult> {
  peonId: string;
  requestId: string;
  socket: WebSocket;
  state: TState;
  resolve: (result: TResult) => void;
  reject: (error: PeonOperationError) => void;
  timer: NodeJS.Timeout;
  abort?: () => void;
}

export interface PeonOperationChannelOptions {
  timeoutMs?: number;
  id?: () => string;
}

export class PeonOperationChannel<TInput, TState, TResult> {
  private readonly timeoutMs: number;
  private readonly id: () => string;
  private readonly pending = new Map<string, Pending<TState, TResult>>();
  private readonly recentlyCancelled = new Map<string, number>();

  constructor(readonly protocol: PeonOperationProtocol<TInput, TState, TResult>, options: PeonOperationChannelOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.id = options.id ?? randomUUID;
  }

  request(peonId: string, input: TInput, signal?: AbortSignal): Promise<TResult> {
    const socket = getPeonConnection(peonId);
    if (!socket) return Promise.reject(new PeonOperationError("PEON_OFFLINE", "Peon is offline", 503));
    if (!peonConnectionSupports(socket, this.protocol.capability)) {
      return Promise.reject(new PeonOperationError("UNSUPPORTED_CAPABILITY", `Peon does not support ${this.protocol.capability}`, 409));
    }
    if (this.pending.has(peonId)) return Promise.reject(new PeonOperationError("SYNC_IN_PROGRESS", "another Peon operation is already in progress", 409));
    if (signal?.aborted) return Promise.reject(new PeonOperationError("CANCELLED", "operation was cancelled", 499));

    const requestId = this.id();
    let started: { frame: PeonOperationFrame; state: TState };
    try {
      started = this.protocol.start(requestId, input);
    } catch (error) {
      return Promise.reject(error instanceof PeonOperationError ? error : new PeonOperationError("PROTOCOL_ERROR", "invalid operation request", 400));
    }
    return new Promise<TResult>((resolve, reject) => {
      const item: Pending<TState, TResult> = {
        peonId, requestId, socket, state: started.state, resolve, reject,
        timer: setTimeout(() => {}, this.timeoutMs),
      };
      clearTimeout(item.timer);
      item.timer = setTimeout(() => this.fail(item, new PeonOperationError("TIMEOUT", "Peon operation timed out", 504), true), this.timeoutMs);
      item.timer.unref();
      if (signal) {
        const onAbort = () => this.fail(item, new PeonOperationError("CANCELLED", "operation was cancelled", 499), true);
        signal.addEventListener("abort", onAbort, { once: true });
        item.abort = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(peonId, item);
      try {
        this.send(socket, started.frame);
      } catch (error) {
        this.fail(item, error instanceof PeonOperationError ? error : new PeonOperationError("CONNECTION_LOST", "Peon connection was lost", 502));
      }
    });
  }

  handleFrame(peonId: string, socket: WebSocket, frame: PeonOperationFrame, frameBytes: number): boolean {
    if (!this.protocol.handles(frame)) return false;
    const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
    const item = this.pending.get(peonId);
    if (!item || item.socket !== socket || !requestId || item.requestId !== requestId) {
      const key = `${peonId}\0${requestId}`;
      if (this.protocol.isCancellationAcknowledgement(frame) && this.consumeRecentCancellation(key)) return true;
      socket.close(1002, "unsolicited Peon operation frame");
      if (item && item.socket === socket) this.fail(item, new PeonOperationError("PROTOCOL_ERROR", "Peon returned an uncorrelated operation frame"));
      return true;
    }
    try {
      const step = this.protocol.receive(requestId, item.state, frame, frameBytes);
      if (step.done) {
        this.cleanup(item);
        item.resolve(step.result);
      } else {
        item.state = step.state;
        this.resetTimer(item);
        this.send(socket, step.next);
      }
    } catch (error) {
      const typed = error instanceof PeonOperationError ? error : new PeonOperationError("PROTOCOL_ERROR", "invalid Peon operation response");
      this.fail(item, typed, typed.code === "PROTOCOL_ERROR" || typed.code === "LISTING_TOO_LARGE");
    }
    return true;
  }

  connectionClosed(peonId: string, socket: WebSocket, code = "CONNECTION_LOST"): void {
    const item = this.pending.get(peonId);
    if (item?.socket === socket) this.fail(item, new PeonOperationError(code, "Peon connection was lost", 502));
  }

  private send(socket: WebSocket, frame: PeonOperationFrame): void {
    if (socket.readyState !== WebSocket.OPEN) throw new PeonOperationError("CONNECTION_LOST", "Peon connection was lost", 502);
    const payload = JSON.stringify(frame);
    const bytes = Buffer.byteLength(payload, "utf8");
    if (socket.bufferedAmount + bytes > MAX_BUFFERED_OUTPUT_BYTES) {
      throw new PeonOperationError("SYNC_IN_PROGRESS", "Peon operation output is backpressured", 429);
    }
    socket.send(payload);
  }

  private resetTimer(item: Pending<TState, TResult>): void {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => this.fail(item, new PeonOperationError("TIMEOUT", "Peon operation timed out", 504), true), this.timeoutMs);
    item.timer.unref();
  }

  private fail(item: Pending<TState, TResult>, error: PeonOperationError, notifyPeon = false): void {
    if (this.pending.get(item.peonId) !== item) return;
    if (notifyPeon && item.socket.readyState === WebSocket.OPEN) {
      try {
        this.send(item.socket, this.protocol.cancel(item.requestId));
        this.rememberCancellation(`${item.peonId}\0${item.requestId}`);
      } catch {
        // The local failure remains authoritative when cancellation cannot be sent.
      }
    }
    this.cleanup(item);
    item.reject(error);
  }

  private cleanup(item: Pending<TState, TResult>): void {
    clearTimeout(item.timer);
    item.abort?.();
    if (this.pending.get(item.peonId) === item) this.pending.delete(item.peonId);
  }

  private rememberCancellation(key: string): void {
    const now = Date.now();
    this.recentlyCancelled.set(key, now + 30_000);
    for (const [candidate, expires] of this.recentlyCancelled) {
      if (expires <= now || this.recentlyCancelled.size > 512) this.recentlyCancelled.delete(candidate);
    }
  }

  private consumeRecentCancellation(key: string): boolean {
    const expires = this.recentlyCancelled.get(key);
    this.recentlyCancelled.delete(key);
    return expires !== undefined && expires > Date.now();
  }
}
