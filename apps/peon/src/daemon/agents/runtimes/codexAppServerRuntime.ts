import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import semver from "semver";

export const MIN_CODEX_APP_SERVER_VERSION = "0.144.0";

export const CODEX_APP_SERVER_LIMITS = {
  maxPendingRequests: 128,
  maxQueuedNotifications: 1_024,
  maxPayloadBytes: 4 * 1024 * 1024,
  maxInboundPayloadBytes: 64 * 1024 * 1024,
  maxOutboundQueueBytes: 4 * 1024 * 1024,
  maxConcurrentServerRequests: 32,
  requestTimeoutMs: 30_000,
  versionTimeoutMs: 5_000,
  restartInitialDelayMs: 250,
  restartMaxDelayMs: 10_000,
  restartStabilityMs: 30_000,
  maxRestartAttempts: 5,
} as const;

export type CodexAppServerErrorCode =
  | "spawn_failed"
  | "version_unavailable"
  | "incompatible_version"
  | "not_running"
  | "overloaded"
  | "request_timeout"
  | "protocol_error"
  | "runtime_exited"
  | "server_error"
  | "stopped";

export class CodexAppServerError extends Error {
  readonly code: CodexAppServerErrorCode;
  readonly details?: unknown;

  constructor(code: CodexAppServerErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
    this.details = details;
  }
}

export interface CodexAppServerNotification {
  method: string;
  params?: unknown;
  generation: number;
  threadId?: string;
  turnId?: string;
}

export type CodexAppServerStatus = "stopped" | "starting" | "healthy" | "restarting" | "failed" | "incompatible";

export interface CodexAppServerHealth {
  status: CodexAppServerStatus;
  generation: number;
  version: string | null;
  minimumVersion: string;
  capabilities: { experimentalApi: boolean };
  restartAttempts: number;
  pendingRequests: number;
  queuedNotifications: number;
  lastError: { code: CodexAppServerErrorCode; message: string } | null;
  startedAt: number | null;
}

export type CodexAppServerRequestHandler = (params: unknown, context: {
  method: string;
  generation: number;
}) => unknown | Promise<unknown>;

interface RegisteredRequestHandler {
  handler: CodexAppServerRequestHandler;
  timeoutMs: number;
}

export interface CodexAppServerRuntimeOptions {
  command: string;
  args?: string[];
  versionArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientInfo?: { name: string; title: string; version: string };
  experimentalApi?: boolean;
  minimumVersion?: string;
  maxPendingRequests?: number;
  maxQueuedNotifications?: number;
  maxPayloadBytes?: number;
  maxInboundPayloadBytes?: number;
  maxOutboundQueueBytes?: number;
  maxConcurrentServerRequests?: number;
  requestTimeoutMs?: number;
  versionTimeoutMs?: number;
  restartInitialDelayMs?: number;
  restartMaxDelayMs?: number;
  restartStabilityMs?: number;
  maxRestartAttempts?: number;
}

interface PendingRequest {
  method: string;
  generation: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface RpcMessage extends Record<string, unknown> {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function extractIdentity(params: unknown): { threadId?: string; turnId?: string } {
  if (!params || typeof params !== "object") return {};
  const record = params as Record<string, unknown>;
  const thread = record.thread && typeof record.thread === "object" ? record.thread as Record<string, unknown> : null;
  const turn = record.turn && typeof record.turn === "object" ? record.turn as Record<string, unknown> : null;
  const threadId = typeof record.threadId === "string" ? record.threadId
    : typeof thread?.id === "string" ? thread.id : undefined;
  const turnId = typeof record.turnId === "string" ? record.turnId
    : typeof turn?.id === "string" ? turn.id : undefined;
  return { threadId, turnId };
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `Codex app-server exited from signal ${signal}`;
  return `Codex app-server exited with code ${code ?? "unknown"}`;
}

export class CodexAppServerRuntime extends EventEmitter {
  private readonly options: Required<Omit<CodexAppServerRuntimeOptions,
    "cwd" | "env" | "clientInfo" | "args" | "versionArgs">> & Pick<CodexAppServerRuntimeOptions,
      "cwd" | "env" | "clientInfo" | "args" | "versionArgs">;
  private child: ChildProcessWithoutNullStreams | null = null;
  private status: CodexAppServerStatus = "stopped";
  private generation = 0;
  private version: string | null = null;
  private startedAt: number | null = null;
  private restartAttempts = 0;
  private lastError: CodexAppServerError | null = null;
  private nextRequestId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private expiredRequestIds = new Set<string | number>();
  private notificationQueue: CodexAppServerNotification[] = [];
  private processingNotifications = false;
  private activeServerRequests = 0;
  private requestHandlers = new Map<string, RegisteredRequestHandler>();
  private startPromise: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartStabilityTimer: NodeJS.Timeout | null = null;
  private stoppedByUser = true;

  constructor(options: CodexAppServerRuntimeOptions) {
    super();
    this.options = {
      ...options,
      minimumVersion: options.minimumVersion ?? MIN_CODEX_APP_SERVER_VERSION,
      experimentalApi: options.experimentalApi ?? false,
      maxPendingRequests: positiveInteger(options.maxPendingRequests, CODEX_APP_SERVER_LIMITS.maxPendingRequests),
      maxQueuedNotifications: positiveInteger(options.maxQueuedNotifications, CODEX_APP_SERVER_LIMITS.maxQueuedNotifications),
      maxPayloadBytes: positiveInteger(options.maxPayloadBytes, CODEX_APP_SERVER_LIMITS.maxPayloadBytes),
      maxInboundPayloadBytes: positiveInteger(options.maxInboundPayloadBytes, CODEX_APP_SERVER_LIMITS.maxInboundPayloadBytes),
      maxOutboundQueueBytes: positiveInteger(options.maxOutboundQueueBytes, CODEX_APP_SERVER_LIMITS.maxOutboundQueueBytes),
      maxConcurrentServerRequests: positiveInteger(options.maxConcurrentServerRequests, CODEX_APP_SERVER_LIMITS.maxConcurrentServerRequests),
      requestTimeoutMs: positiveInteger(options.requestTimeoutMs, CODEX_APP_SERVER_LIMITS.requestTimeoutMs),
      versionTimeoutMs: positiveInteger(options.versionTimeoutMs, CODEX_APP_SERVER_LIMITS.versionTimeoutMs),
      restartInitialDelayMs: positiveInteger(options.restartInitialDelayMs, CODEX_APP_SERVER_LIMITS.restartInitialDelayMs),
      restartMaxDelayMs: positiveInteger(options.restartMaxDelayMs, CODEX_APP_SERVER_LIMITS.restartMaxDelayMs),
      restartStabilityMs: positiveInteger(options.restartStabilityMs, CODEX_APP_SERVER_LIMITS.restartStabilityMs),
      maxRestartAttempts: positiveInteger(options.maxRestartAttempts, CODEX_APP_SERVER_LIMITS.maxRestartAttempts),
    };
  }

  getHealth(): CodexAppServerHealth {
    return {
      status: this.status,
      generation: this.generation,
      version: this.version,
      minimumVersion: this.options.minimumVersion,
      capabilities: { experimentalApi: this.options.experimentalApi },
      restartAttempts: this.restartAttempts,
      pendingRequests: this.pending.size,
      queuedNotifications: this.notificationQueue.length,
      lastError: this.lastError ? { code: this.lastError.code, message: this.lastError.message } : null,
      startedAt: this.startedAt,
    };
  }

  async start(): Promise<void> {
    this.stoppedByUser = false;
    if (this.status === "healthy") return;
    if (this.startPromise) return this.startPromise;
    this.clearRestartTimer();
    this.clearRestartStabilityTimer();
    this.startPromise = this.startRuntime();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.stoppedByUser = true;
    this.clearRestartTimer();
    this.clearRestartStabilityTimer();
    const child = this.child;
    this.child = null;
    this.status = "stopped";
    this.startedAt = null;
    this.rejectPending(new CodexAppServerError("stopped", "Codex app-server runtime stopped"));
    this.emitHealth();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceKill);
        clearTimeout(giveUp);
        child.off("exit", finish);
        resolve();
      };
      const forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 500);
      const giveUp = setTimeout(finish, 900);
      forceKill.unref?.();
      giveUp.unref?.();
      child.once("exit", finish);
      if (!child.killed) child.kill("SIGTERM");
    });
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs): Promise<T> {
    const child = this.child;
    const generation = this.generation;
    if (!child || !["starting", "restarting", "healthy"].includes(this.status)) {
      throw new CodexAppServerError("not_running", `Codex app-server is not ready for ${method}`);
    }
    if (this.pending.size >= this.options.maxPendingRequests) {
      throw new CodexAppServerError("overloaded", `Codex app-server pending request limit (${this.options.maxPendingRequests}) reached`);
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.rememberExpiredRequest(id);
        reject(new CodexAppServerError("request_timeout", `Codex app-server request ${method} timed out after ${timeoutMs}ms`));
        this.emitHealth();
      }, positiveInteger(timeoutMs, this.options.requestTimeoutMs));
      timer.unref?.();
      this.pending.set(id, { method, generation, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.sendMessage({ method, id, ...(params === undefined ? {} : { params }) }, generation);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
      this.emitHealth();
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.child || this.status !== "healthy") {
      throw new CodexAppServerError("not_running", `Codex app-server is not ready for ${method}`);
    }
    this.sendMessage({ method, ...(params === undefined ? {} : { params }) }, this.generation);
  }

  registerRequestHandler(method: string, handler: CodexAppServerRequestHandler, timeoutMs = this.options.requestTimeoutMs): () => void {
    const registered = { handler, timeoutMs: positiveInteger(timeoutMs, this.options.requestTimeoutMs) };
    this.requestHandlers.set(method, registered);
    return () => {
      if (this.requestHandlers.get(method) === registered) this.requestHandlers.delete(method);
    };
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.on("notification", listener);
    return () => this.off("notification", listener);
  }

  onThreadNotification(threadId: string, listener: (notification: CodexAppServerNotification) => void): () => void {
    const event = `thread:${threadId}`;
    this.on(event, listener);
    return () => this.off(event, listener);
  }

  onTurnNotification(turnId: string, listener: (notification: CodexAppServerNotification) => void): () => void {
    const event = `turn:${turnId}`;
    this.on(event, listener);
    return () => this.off(event, listener);
  }

  private async startRuntime(): Promise<void> {
    if (!this.version) await this.validateVersion();
    const version = this.version;
    if (!version) throw new CodexAppServerError("version_unavailable", "Codex version was not established");
    if (semver.lt(version, this.options.minimumVersion)) {
      const error = new CodexAppServerError("incompatible_version", `Codex ${version} is incompatible; app-server requires >=${this.options.minimumVersion}`);
      this.status = "incompatible";
      this.lastError = error;
      this.emitHealth();
      throw error;
    }
    this.status = this.restartAttempts ? "restarting" : "starting";
    this.lastError = null;
    this.emitHealth();
    const generation = ++this.generation;
    const child = spawn(this.options.command, this.options.args ?? ["app-server", "--listen", "stdio://"], {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(new CodexAppServerError("spawn_failed", `Unable to spawn Codex app-server: ${error.message}`)); };
      const cleanup = () => { child.off("spawn", onSpawn); child.off("error", onError); };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    }).catch((error) => {
      this.failGeneration(generation, error as CodexAppServerError, true);
      throw error;
    });
    if (generation !== this.generation || child !== this.child) throw new CodexAppServerError("stopped", "Codex app-server start was superseded");
    this.attachChild(child, generation);
    try {
      await this.request("initialize", {
        clientInfo: this.options.clientInfo ?? { name: "peon", title: "Peon", version: "0.0.1" },
        capabilities: { experimentalApi: this.options.experimentalApi },
      });
      if (generation !== this.generation || child !== this.child) throw new CodexAppServerError("stopped", "Codex app-server initialization was superseded");
      this.sendMessage({ method: "initialized" }, generation);
      this.status = "healthy";
      this.startedAt = Date.now();
      this.lastError = null;
      this.clearRestartStabilityTimer();
      this.restartStabilityTimer = setTimeout(() => {
        this.restartStabilityTimer = null;
        if (generation === this.generation && this.status === "healthy") {
          this.restartAttempts = 0;
          this.emitHealth();
        }
      }, this.options.restartStabilityMs);
      this.restartStabilityTimer.unref?.();
      this.emitHealth();
    } catch (error) {
      const runtimeError = error instanceof CodexAppServerError ? error
        : new CodexAppServerError("protocol_error", `Codex app-server initialization failed: ${String(error)}`);
      this.failGeneration(generation, runtimeError, true);
      throw runtimeError;
    }
  }

  private async validateVersion(): Promise<void> {
    const output = await this.runVersionProbe();
    const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
    const version = match?.[1];
    if (!version || !semver.valid(version)) {
      const error = new CodexAppServerError("version_unavailable", `Could not determine Codex version from: ${output.trim() || "empty output"}`);
      this.status = "failed";
      this.lastError = error;
      this.emitHealth();
      throw error;
    }
    this.version = version;
    if (semver.lt(version, this.options.minimumVersion)) {
      const error = new CodexAppServerError("incompatible_version", `Codex ${version} is incompatible; app-server requires >=${this.options.minimumVersion}`);
      this.status = "incompatible";
      this.lastError = error;
      this.emitHealth();
      throw error;
    }
  }

  private runVersionProbe(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, this.options.versionArgs ?? ["--version"], {
        cwd: this.options.cwd,
        env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(output);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new CodexAppServerError("version_unavailable", `Codex version probe timed out after ${this.options.versionTimeoutMs}ms`));
      }, this.options.versionTimeoutMs);
      timer.unref?.();
      const append = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output) > 64 * 1024) {
          child.kill("SIGKILL");
          finish(new CodexAppServerError("version_unavailable", "Codex version output exceeded 64 KiB"));
        }
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.once("error", (error) => finish(new CodexAppServerError("spawn_failed", `Unable to run Codex version probe: ${error.message}`)));
      child.once("exit", (code) => code === 0
        ? finish()
        : finish(new CodexAppServerError("version_unavailable", `Codex version probe exited with code ${code ?? "unknown"}: ${output.trim()}`)));
    });
  }

  private attachChild(child: ChildProcessWithoutNullStreams, generation: number): void {
    // Keep a chunk list rather than repeatedly Buffer.concat-ing an unfinished
    // multi-megabyte JSONL line. Re-concatenating on every stdout chunk is
    // quadratic and can stall the runtime precisely when a large command
    // result needs the payload guard most.
    let stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (generation !== this.generation || child !== this.child) return;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);
        if (segment.length > 0) {
          stdoutChunks.push(segment);
          stdoutBytes += segment.length;
        }
        if (stdoutBytes > this.options.maxInboundPayloadBytes) {
          this.protocolFailure(generation, `payload exceeded ${this.options.maxInboundPayloadBytes} bytes`);
          return;
        }
        if (newline === -1) return;
        const payload = stdoutChunks.length === 1 ? stdoutChunks[0] : Buffer.concat(stdoutChunks, stdoutBytes);
        stdoutChunks = [];
        stdoutBytes = 0;
        const line = payload.toString("utf8").trim();
        if (line) this.parseLine(line, generation);
        if (generation !== this.generation || child !== this.child) return;
        offset = newline + 1;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (generation === this.generation && child === this.child) this.emit("stderr", chunk.toString("utf8"));
    });
    let terminated = false;
    const terminate = (error: CodexAppServerError) => {
      if (terminated) return;
      terminated = true;
      if (generation !== this.generation || child !== this.child) return;
      this.failGeneration(generation, error, true);
    };
    child.once("error", (error) => terminate(new CodexAppServerError("spawn_failed", `Codex app-server process error: ${error.message}`)));
    child.once("exit", (code, signal) => terminate(new CodexAppServerError("runtime_exited", describeExit(code, signal), { code, signal })));
  }

  private parseLine(line: string, generation: number): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.protocolFailure(generation, `malformed JSONL message: ${line.slice(0, 160)}`);
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.protocolFailure(generation, "message must be a JSON object");
      return;
    }
    this.handleMessage(message as RpcMessage, generation);
  }

  private handleMessage(message: RpcMessage, generation: number): void {
    if (message.id !== undefined && typeof message.method === "string") {
      void this.handleServerRequest(message.id, message.method, message.params, generation);
      return;
    }
    if (message.id !== undefined && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending || pending.generation !== generation) {
        if (this.expiredRequestIds.delete(message.id)) return;
        this.protocolFailure(generation, `response references unknown request id ${String(message.id)}`);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new CodexAppServerError("server_error", `Codex app-server ${pending.method} failed: ${String(message.error.message ?? "unknown error")}`, {
          rpcCode: message.error.code,
          data: message.error.data,
        }));
      } else {
        pending.resolve(message.result);
      }
      this.emitHealth();
      return;
    }
    if (typeof message.method === "string" && message.id === undefined) {
      this.enqueueNotification(message.method, message.params, generation);
      return;
    }
    this.protocolFailure(generation, "message is not a request, response, or notification");
  }

  private async handleServerRequest(id: string | number, method: string, params: unknown, generation: number): Promise<void> {
    if (this.activeServerRequests >= this.options.maxConcurrentServerRequests) {
      this.sendMessage({ id, error: { code: -32001, message: "Peon app-server client overloaded; retry later." } }, generation);
      return;
    }
    const registered = this.requestHandlers.get(method);
    if (!registered) {
      this.sendMessage({ id, error: { code: -32601, message: `No Peon handler registered for ${method}` } }, generation);
      return;
    }
    this.activeServerRequests++;
    let handlerTimer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(registered.handler(params, { method, generation })),
        new Promise<never>((_resolve, reject) => {
          handlerTimer = setTimeout(() => reject(new CodexAppServerError(
            "request_timeout",
            `Peon handler for ${method} timed out after ${registered.timeoutMs}ms`,
          )), registered.timeoutMs);
          handlerTimer.unref?.();
        }),
      ]);
      if (generation === this.generation && this.child) this.sendMessage({ id, result: result ?? {} }, generation);
    } catch (error) {
      if (generation === this.generation && this.child) {
        this.sendMessage({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }, generation);
      }
    } finally {
      if (handlerTimer) clearTimeout(handlerTimer);
      this.activeServerRequests--;
    }
  }

  private enqueueNotification(method: string, params: unknown, generation: number): void {
    if (this.notificationQueue.length >= this.options.maxQueuedNotifications) {
      this.protocolFailure(generation, `notification queue limit (${this.options.maxQueuedNotifications}) reached`);
      return;
    }
    const identity = extractIdentity(params);
    this.notificationQueue.push({ method, params, generation, ...identity });
    if (!this.processingNotifications) setImmediate(() => this.processNotifications());
    this.emitHealth();
  }

  private processNotifications(): void {
    this.processingNotifications = true;
    const deadline = performance.now() + 8;
    while (this.notificationQueue.length) {
      const notification = this.notificationQueue.shift()!;
      if (notification.generation === this.generation) {
        this.emit("notification", notification);
        if (notification.threadId) this.emit(`thread:${notification.threadId}`, notification);
        if (notification.turnId) this.emit(`turn:${notification.turnId}`, notification);
      }
      if (performance.now() >= deadline) {
        setImmediate(() => this.processNotifications());
        this.emitHealth();
        return;
      }
    }
    this.processingNotifications = false;
    this.emitHealth();
  }

  private sendMessage(message: RpcMessage, generation: number): void {
    const child = this.child;
    if (!child || generation !== this.generation || child.stdin.destroyed) {
      throw new CodexAppServerError("not_running", "Codex app-server transport is unavailable");
    }
    const payload = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(payload);
    if (bytes > this.options.maxPayloadBytes) {
      throw new CodexAppServerError("overloaded", `Codex app-server payload exceeds ${this.options.maxPayloadBytes} bytes`);
    }
    if (child.stdin.writableLength + bytes > this.options.maxOutboundQueueBytes) {
      throw new CodexAppServerError("overloaded", `Codex app-server outbound queue exceeds ${this.options.maxOutboundQueueBytes} bytes`);
    }
    child.stdin.write(payload);
  }

  private protocolFailure(generation: number, message: string): void {
    const error = new CodexAppServerError("protocol_error", `Codex app-server protocol error: ${message}`);
    this.failGeneration(generation, error, true);
  }

  private failGeneration(generation: number, error: CodexAppServerError, restart: boolean): void {
    if (generation !== this.generation) return;
    const child = this.child;
    this.child = null;
    this.startedAt = null;
    this.clearRestartStabilityTimer();
    this.lastError = error;
    this.rejectPending(error, generation);
    if (child && !child.killed) child.kill("SIGKILL");
    if (restart && !this.stoppedByUser) this.scheduleRestart();
    else this.status = "failed";
    this.emit("runtimeError", error);
    this.emitHealth();
  }

  private rejectPending(error: CodexAppServerError, generation?: number): void {
    for (const [id, pending] of this.pending) {
      if (generation !== undefined && pending.generation !== generation) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private rememberExpiredRequest(id: string | number): void {
    this.expiredRequestIds.add(id);
    if (this.expiredRequestIds.size <= 1_024) return;
    const oldest = this.expiredRequestIds.values().next().value;
    if (oldest !== undefined) this.expiredRequestIds.delete(oldest);
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stoppedByUser) return;
    this.restartAttempts++;
    if (this.restartAttempts > this.options.maxRestartAttempts) {
      this.status = "failed";
      return;
    }
    this.status = "restarting";
    const delay = Math.min(
      this.options.restartInitialDelayMs * 2 ** (this.restartAttempts - 1),
      this.options.restartMaxDelayMs,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stoppedByUser) return;
      this.start().catch(() => {});
    }, delay);
    this.restartTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private clearRestartStabilityTimer(): void {
    if (!this.restartStabilityTimer) return;
    clearTimeout(this.restartStabilityTimer);
    this.restartStabilityTimer = null;
  }

  private emitHealth(): void {
    this.emit("health", this.getHealth());
  }
}
