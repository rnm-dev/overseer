import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { canAccessPeon, canAccessProject } from "../access/index.js";
import { getUserById, type AuthContext } from "../auth/index.js";
import { membership } from "../workspaces/index.js";
import { registry } from "../registry/index.js";
import { getIndexedSession } from "../sessions/sessionQueries.js";
import { getIndexedProjectById } from "../../projectIndex.js";
import {
  getPeonConnection,
  isCurrentPeonConnection,
  peonConnectionGeneration,
  peonConnectionSupports,
  peonConnectionSupportsCommand,
} from "../../peonConnections.js";
import {
  commitDurableReverseCommandResult,
  commitEphemeralReverseCommandResult,
  createOrGetReverseCommand,
  DEFAULT_REVERSE_COMMAND_LIMITS,
  getReverseCommand,
  getReverseCommandForActor,
  markReverseCommandAccepted,
  markReverseCommandSendFailed,
  markReverseCommandSent,
  markReverseCommandUnknown,
  noteReverseCommandDisconnect,
  observeReverseCommandTerminal,
  rebindRecoverableReverseCommands,
  type ReverseCommandLimits,
} from "./reverseCommandRegistry.js";
import { countReverseCommandMetric } from "./reverseCommandMetrics.js";
import {
  isCanonicalUuid,
  isReverseCommandOperation,
  assertSafeReverseCommandResult,
  parseReverseCommandAccepted,
  parseReverseCommandResult,
  parseReverseCommandStatus,
  REVERSE_COMMAND_CAPABILITY,
  REVERSE_COMMAND_MAX_FRAME_BYTES,
  ReverseCommandCorrelationError,
  ReverseCommandProtocolError,
  reverseCommandFrame,
  reverseCommandPayloadIsTransient,
  reverseCommandRequestHash,
  safeReverseCommandTerminalFrame,
  safeReverseCommandView,
  type DurableReverseCommandResult,
  type JsonObject,
  type ReverseCommandActor,
  type ReverseCommandOperation,
  type ReverseCommandRecord,
  type ReverseCommandTarget,
} from "./reverseCommandTypes.js";

const DEFAULT_WAIT_MS = 15_000;
const MAX_WAIT_MS = 30_000;
const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024;

// One entry per operation, keyed by the operation union so the compiler refuses
// a command that never declared its payload. There is deliberately no fallback:
// a missing entry must fail the build, not silently admit an empty payload.
const PAYLOAD_FIELDS: Record<ReverseCommandOperation, readonly string[]> = {
};

export interface SubmitReverseCommandInput {
  workspaceId: string;
  peonId: string;
  auth: AuthContext;
  operation: ReverseCommandOperation;
  target: Omit<ReverseCommandTarget, "peonId">;
  payload?: JsonObject;
  expected?: JsonObject | null;
  commandId?: string;
  waitMs?: number;
}

export interface ReverseCommandHttpResult {
  status: number;
  body: Record<string, unknown>;
  record?: ReverseCommandRecord;
  reused?: boolean;
}

export class ReverseCommandGatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReverseCommandGatewayError";
  }
}

interface ReverseCommandGatewayOptions {
  limits?: Partial<ReverseCommandLimits>;
  now?: () => number;
  id?: () => string;
  beforeSocketSend?: () => Promise<void>;
  afterConnectionOwnershipCheck?: () => Promise<void>;
  afterWaiterRegistered?: () => Promise<void>;
  afterTerminalObserved?: (record: ReverseCommandRecord) => Promise<void>;
}

function strictObject(value: unknown, allowed: readonly string[], field: string): asserts value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ReverseCommandGatewayError(400, "BAD_COMMAND", `${field} contains unsupported fields`);
  }
}

function errorResult(error: ReverseCommandGatewayError): ReverseCommandHttpResult {
  return { status: error.status, body: { error: error.message, code: error.code } };
}

function terminalHttpStatus(record: ReverseCommandRecord): number {
  const terminal = safeReverseCommandTerminalFrame(record);
  if (!terminal) return 502;
  if (terminal.status === "applied" || terminal.status === "noop") return 200;
  if (terminal.status === "conflict" || terminal.status === "cancelled") return 409;
  if (terminal.status === "failed") return 502;
  if (terminal.code === "SESSION_NOT_RUNNING") return 409;
  if (terminal.code.startsWith("UNKNOWN_")) return 404;
  if (terminal.code === "FORBIDDEN" || terminal.code === "UNAUTHORIZED") return 403;
  if (terminal.code === "RATE_LIMITED" || terminal.code === "COMMAND_LEDGER_FULL") return 429;
  return 400;
}

export function reverseCommandHttpResult(record: ReverseCommandRecord, timedOut = false): ReverseCommandHttpResult {
  if (record.state === "terminal") {
    return {
      status: terminalHttpStatus(record),
      body: safeReverseCommandView(record),
      record,
    };
  }
  const statusUrl = `/api/workspaces/${encodeURIComponent(record.workspaceId)}/peons/${encodeURIComponent(record.peonId)}/commands/${encodeURIComponent(record.commandId)}`;
  if (record.state === "send_failed") {
    return {
      status: 502,
      body: {
        error: "command could not be sent before acceptance",
        code: record.lastErrorCode ?? "COMMAND_SEND_FAILED",
        commandId: record.commandId,
        statusUrl,
      },
      record,
    };
  }
  if (record.state === "accepted" || record.state === "running" || record.state === "unknown") {
    return {
      status: 202,
      body: {
        ...safeReverseCommandView(record),
        code: record.state === "unknown" ? "UNKNOWN_OUTCOME" : "COMMAND_PENDING",
        statusUrl,
      },
      record,
    };
  }
  return {
    status: timedOut ? 504 : 202,
    body: {
      error: timedOut ? "command acceptance was not observed before the timeout" : "command is waiting for acceptance",
      code: timedOut ? "COMMAND_TIMEOUT" : "COMMAND_PENDING",
      commandId: record.commandId,
      statusUrl,
    },
    record,
  };
}

export class ReverseCommandGateway {
  private readonly limits: ReverseCommandLimits;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly beforeSocketSend?: () => Promise<void>;
  private readonly afterConnectionOwnershipCheck?: () => Promise<void>;
  private readonly afterWaiterRegistered?: () => Promise<void>;
  private readonly afterTerminalObserved?: (record: ReverseCommandRecord) => Promise<void>;
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(options: ReverseCommandGatewayOptions = {}) {
    this.limits = { ...DEFAULT_REVERSE_COMMAND_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.beforeSocketSend = options.beforeSocketSend;
    this.afterConnectionOwnershipCheck = options.afterConnectionOwnershipCheck;
    this.afterWaiterRegistered = options.afterWaiterRegistered;
    this.afterTerminalObserved = options.afterTerminalObserved;
  }

  async submit(input: SubmitReverseCommandInput): Promise<ReverseCommandHttpResult> {
    try {
      const prepared = await this.prepare(input);
      const persisted = await getReverseCommand(input.workspaceId, input.peonId, prepared.commandId);
      if (persisted) {
        if (persisted.requestHash !== prepared.requestHash) {
          countReverseCommandMetric("error", input.operation, "COMMAND_ID_REUSED");
          throw new ReverseCommandGatewayError(409, "COMMAND_ID_REUSED", "command ID was already used for a different request");
        }
        if (persisted.state === "terminal") return { ...reverseCommandHttpResult(persisted), reused: true };
        const currentSocket = getPeonConnection(input.peonId);
        if (!currentSocket) return reverseCommandHttpResult(persisted);
      }
      const socket = this.requireConnection(input.peonId, input.operation);
      const generation = peonConnectionGeneration(socket);
      if (!generation) throw new ReverseCommandGatewayError(503, "PEON_OFFLINE", "Peon is offline");

      const created = await createOrGetReverseCommand(prepared, this.limits, this.now());
      if (created.kind === "overloaded") {
        countReverseCommandMetric("error", input.operation, "COMMAND_PENDING_LIMIT");
        throw new ReverseCommandGatewayError(429, "COMMAND_PENDING_LIMIT", `${created.scope} reverse command limit reached`);
      }
      if (created.kind === "reused") {
        countReverseCommandMetric("error", input.operation, "COMMAND_ID_REUSED");
        throw new ReverseCommandGatewayError(409, "COMMAND_ID_REUSED", "command ID was already used for a different request");
      }
      if (created.kind === "conflict") {
        throw new ReverseCommandGatewayError(409, "COMMAND_PENDING_LIMIT", "reverse command conflicts with active work");
      }

      let record = created.record;
      if (created.kind === "created") {
        countReverseCommandMetric("queued", record.operation);
        record = await this.sendCommand(record, socket, generation, false, prepared.wirePayload);
      } else if (record.state === "created" || record.state === "send_failed") {
        record = await this.sendCommand(record, socket, generation);
      } else if (record.connectionGeneration !== generation) {
        record = await this.reconcileOne(record, socket, generation);
      }
      return {
        ...await this.waitFor(record, input.waitMs ?? DEFAULT_WAIT_MS),
        ...(created.kind === "existing" ? { reused: true } : {}),
      };
    } catch (error) {
      if (error instanceof ReverseCommandGatewayError) return errorResult(error);
      throw error;
    }
  }

  async status(
    workspaceId: string,
    peonId: string,
    commandId: string,
    actorUserId: string,
  ): Promise<ReverseCommandHttpResult | null> {
    const record = await getReverseCommandForActor(workspaceId, peonId, commandId, actorUserId);
    return record ? { status: 200, body: safeReverseCommandView(record), record } : null;
  }

  async connectionReady(
    workspaceId: string,
    peonId: string,
    socket: WebSocket,
  ): Promise<void> {
    const generation = peonConnectionGeneration(socket);
    if (!generation || !isCurrentPeonConnection(peonId, socket, generation)
      || !peonConnectionSupports(socket, REVERSE_COMMAND_CAPABILITY)) return;
    await this.afterConnectionOwnershipCheck?.();
    const recoverable = await rebindRecoverableReverseCommands(workspaceId, peonId, generation);
    if (!isCurrentPeonConnection(peonId, socket, generation)
      || !peonConnectionSupports(socket, REVERSE_COMMAND_CAPABILITY)) return;
    for (const record of recoverable) {
      if (!isCurrentPeonConnection(peonId, socket, generation)
        || !peonConnectionSupports(socket, REVERSE_COMMAND_CAPABILITY)) return;
      if (!peonConnectionSupportsCommand(socket, record.operation)) continue;
      if (record.state === "created") await this.sendCommand(record, socket, generation);
      else if (record.state === "sent") await this.sendCommand(record, socket, generation, true);
      else this.sendFrame(socket, {
        type: "command_status_request",
        protocol: 1,
        commandId: record.commandId,
      });
    }
  }

  async connectionClosed(
    workspaceId: string,
    peonId: string,
    generation: string,
  ): Promise<void> {
    const records = await noteReverseCommandDisconnect(
      workspaceId,
      peonId,
      generation,
      "CONNECTION_LOST",
    );
    for (const record of records) {
      countReverseCommandMetric(
        record.acceptedAt === null ? "disconnect_before_acceptance" : "disconnect_after_acceptance",
        record.operation,
      );
      this.notify(record, true);
    }
  }

  async handleEphemeralFrame(
    workspaceId: string,
    peonId: string,
    socket: WebSocket,
    frame: Record<string, unknown>,
  ): Promise<boolean> {
    if (frame.type !== "command_accepted" && frame.type !== "command_status"
      && frame.type !== "command_result") return false;
    const generation = peonConnectionGeneration(socket);
    if (!generation || !isCurrentPeonConnection(peonId, socket, generation)) return true;
    if (frame.type === "command_result") {
      const result = parseReverseCommandResult(frame);
      if (result.result !== null || !["rejected", "conflict", "failed"].includes(result.status)) {
        throw new ReverseCommandProtocolError("invalid pre-admission command result");
      }
      const record = await commitEphemeralReverseCommandResult({
        workspaceId,
        peonId,
        connectionGeneration: generation,
        result,
        now: this.now(),
      });
      if (!record) throw new ReverseCommandCorrelationError("stale reverse command refusal");
      countReverseCommandMetric("completed", record.operation, record.code);
      this.notify(record);
      return true;
    }
    if (frame.type === "command_accepted") {
      const accepted = parseReverseCommandAccepted(frame);
      const record = await markReverseCommandAccepted({
        workspaceId,
        peonId,
        commandId: accepted.commandId,
        operation: accepted.operation,
        generation,
        state: accepted.state,
        replayed: accepted.replayed,
        acceptedAt: accepted.acceptedAt,
      });
      if (!record) throw new ReverseCommandCorrelationError("stale reverse command acceptance");
      countReverseCommandMetric("accepted", record.operation);
      if (accepted.replayed) countReverseCommandMetric("replayed", record.operation);
      this.notify(record);
      return true;
    }

    const status = parseReverseCommandStatus(frame);
    const existing = await getReverseCommand(workspaceId, peonId, status.commandId);
    if (!existing || existing.peonId !== peonId || existing.connectionGeneration !== generation) {
      throw new ReverseCommandCorrelationError("stale reverse command status");
    }
    let record: ReverseCommandRecord | null;
    if (status.state === "terminal") {
      if (!status.result) throw new Error("terminal reverse command status omitted result");
      assertSafeReverseCommandResult(existing, status.result);
      record = await observeReverseCommandTerminal(workspaceId, peonId, generation, status.result, this.now());
      if (!record) throw new Error("reverse command status result changed");
      await this.afterTerminalObserved?.(record);
      countReverseCommandMetric("completed", record.operation, record.code);
    } else if (status.state === "unknown") {
      if (existing.state === "sent" && !reverseCommandPayloadIsTransient(existing.operation)) {
        record = await this.sendCommand(existing, socket, generation, true);
      } else {
        record = await markReverseCommandUnknown(workspaceId, peonId, status.commandId, generation, this.now());
      }
    } else {
      record = await markReverseCommandAccepted({
        workspaceId,
        peonId,
        commandId: status.commandId,
        operation: existing.operation,
        generation,
        state: status.state,
        replayed: existing.replayed,
        acceptedAt: existing.acceptedAt ?? this.now(),
      });
    }
    if (!record) throw new Error("reverse command status lost its generation fence");
    this.notify(record);
    return true;
  }

  async commitDurableResult(input: {
    workspaceId: string;
    peonId: string;
    socket: WebSocket;
    syncGeneration: string;
    durable: DurableReverseCommandResult;
  }): Promise<{ epoch: string; acknowledgedCursor: string }> {
    const generation = peonConnectionGeneration(input.socket);
    if (!generation || !isCurrentPeonConnection(input.peonId, input.socket, generation)) {
      throw new Error("reverse command result arrived on a stale connection");
    }
    const committed = await commitDurableReverseCommandResult({
      workspaceId: input.workspaceId,
      peonId: input.peonId,
      connectionGeneration: generation,
      syncGeneration: input.syncGeneration,
      durable: input.durable,
    });
    countReverseCommandMetric("completed", committed.record.operation, committed.record.code);
    this.notify(committed.record);
    return committed.delivery;
  }

  private async prepare(input: SubmitReverseCommandInput) {
    if (Object.hasOwn(input as unknown as object, "actor")) {
      throw new ReverseCommandGatewayError(400, "BAD_COMMAND", "actor is derived from authenticated server context");
    }
    if (!input.workspaceId || !isCanonicalUuid(input.peonId)
      || !isCanonicalUuid(input.auth?.userId) || !isReverseCommandOperation(input.operation)) {
      throw new ReverseCommandGatewayError(400, "BAD_COMMAND", "invalid reverse command identity");
    }
    const canonicalUser = await getUserById(input.auth.userId);
    if (!canonicalUser) throw new ReverseCommandGatewayError(401, "UNAUTHORIZED", "authenticated user no longer exists");
    const actor: ReverseCommandActor = { userId: canonicalUser.id, email: canonicalUser.email };
    const commandId = input.commandId ?? this.id();
    if (!isCanonicalUuid(commandId)) {
      throw new ReverseCommandGatewayError(400, "BAD_COMMAND", "commandId must be a canonical UUID");
    }
    const payload = input.payload === undefined ? {} : input.payload;
    const expected = input.expected ?? null;
    const runtime = (input.operation as string).startsWith("runtime.");
    const update = (input.operation as string).startsWith("update.");
    strictObject(payload, PAYLOAD_FIELDS[input.operation], "payload");
    if (expected !== null) {
      throw new ReverseCommandGatewayError(400, "BAD_COMMAND", `${input.operation} does not accept expected state`);
    }
    const target: ReverseCommandTarget = { ...input.target, peonId: input.peonId };
    strictObject(target as unknown as JsonObject, ["peonId", "sessionId", "projectId"], "target");
    if ((runtime || update) && target.sessionId !== undefined) {
      throw new ReverseCommandGatewayError(400, "BAD_COMMAND", "operation targets only the Peon");
    }

    await this.authorize(input.workspaceId, input.peonId, actor.userId, target, input.operation);
    const requestedAt = this.now();
    const requestHash = reverseCommandRequestHash({
      operation: input.operation,
      target,
      actor,
      payload,
      expected,
    });
    const wirePayload = payload;
    const draft = {
      workspaceId: input.workspaceId,
      peonId: input.peonId,
      commandId,
      operation: input.operation,
      requestHash,
      actor,
      target,
      payload: reverseCommandPayloadIsTransient(input.operation) ? {} : wirePayload,
      expected,
      requestBytes: 0,
      requestedAt,
    };
    const frame = {
      type: "command",
      protocol: 1,
      capability: REVERSE_COMMAND_CAPABILITY,
      commandId,
      operation: input.operation,
      target,
      actor,
      payload,
      expected,
      requestedAt,
    };
    const requestBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    if (requestBytes > REVERSE_COMMAND_MAX_FRAME_BYTES) {
      throw new ReverseCommandGatewayError(413, "BAD_COMMAND", "reverse command exceeds 60 KiB");
    }
    return { ...draft, requestBytes, wirePayload };
  }

  private async authorize(
    workspaceId: string,
    peonId: string,
    userId: string,
    target: ReverseCommandTarget,
    _operation: ReverseCommandOperation,
  ): Promise<void> {
    const [record, role] = await Promise.all([registry.get(peonId), membership(workspaceId, userId)]);
    if (!record || record.workspaceId !== workspaceId || !role
      || !(await canAccessPeon(workspaceId, userId, role, peonId))) {
      throw new ReverseCommandGatewayError(404, "UNKNOWN_PEON", "unknown Peon");
    }
    if (target.projectId) {
      const project = await getIndexedProjectById(peonId, target.projectId);
      if (!project || !(await canAccessProject(workspaceId, userId, role, peonId, project.key, project.projectId))) {
        throw new ReverseCommandGatewayError(404, "UNKNOWN_PROJECT", "unknown project");
      }
      return;
    }
    if (!target.sessionId) {
      if (role !== "owner") throw new ReverseCommandGatewayError(403, "FORBIDDEN", "owner access required");
      return;
    }
    const session = await getIndexedSession(peonId, target.sessionId);
    if (!session || (role !== "owner" && session.projectKey
      && !(await canAccessProject(workspaceId, userId, role, peonId, session.projectKey, session.projectId)))) {
      throw new ReverseCommandGatewayError(404, "UNKNOWN_SESSION", "unknown session");
    }
  }

  private requireConnection(peonId: string, operation: ReverseCommandOperation): WebSocket {
    const socket = getPeonConnection(peonId);
    if (!socket) throw new ReverseCommandGatewayError(503, "PEON_OFFLINE", "Peon is offline");
    if (!peonConnectionSupports(socket, REVERSE_COMMAND_CAPABILITY)
      || !peonConnectionSupportsCommand(socket, operation)) {
      throw new ReverseCommandGatewayError(503, "CAPABILITY_UNAVAILABLE", `Peon did not negotiate ${operation}`);
    }
    return socket;
  }

  private async sendCommand(
    record: ReverseCommandRecord,
    socket: WebSocket,
    generation: string,
    resend = false,
    wirePayload?: JsonObject,
  ): Promise<ReverseCommandRecord> {
    if (!isCurrentPeonConnection(record.peonId, socket, generation)) return record;
    const marked = await markReverseCommandSent(
      record.workspaceId,
      record.peonId,
      record.commandId,
      generation,
      this.now(),
      resend,
    );
    if (!marked) {
      const current = await getReverseCommand(record.workspaceId, record.peonId, record.commandId);
      if (!current) throw new ReverseCommandGatewayError(500, "INTERNAL", "reverse command disappeared");
      return current;
    }
    try {
      await this.beforeSocketSend?.();
      if (!isCurrentPeonConnection(marked.peonId, socket, generation)) return marked;
      const frame = reverseCommandFrame(marked);
      if (wirePayload) frame.payload = wirePayload;
      this.sendFrame(socket, frame as unknown as Record<string, unknown>);
      return marked;
    } catch (error) {
      const failed = await markReverseCommandSendFailed(
        marked.workspaceId,
        marked.peonId,
        marked.commandId,
        generation,
        "COMMAND_SEND_FAILED",
        this.now(),
      );
      countReverseCommandMetric("error", marked.operation, "COMMAND_SEND_FAILED");
      this.notify(failed ?? marked);
      if (error instanceof ReverseCommandGatewayError) throw error;
      throw new ReverseCommandGatewayError(502, "COMMAND_SEND_FAILED", "command could not be sent");
    }
  }

  private async reconcileOne(
    record: ReverseCommandRecord,
    socket: WebSocket,
    generation: string,
  ): Promise<ReverseCommandRecord> {
    const rebound = await rebindRecoverableReverseCommands(record.workspaceId, record.peonId, generation);
    const current = rebound.find((candidate) => candidate.commandId === record.commandId)
      ?? await getReverseCommand(record.workspaceId, record.peonId, record.commandId)
      ?? record;
    if (!isCurrentPeonConnection(record.peonId, socket, generation)
      || !peonConnectionSupports(socket, REVERSE_COMMAND_CAPABILITY)
      || !peonConnectionSupportsCommand(socket, current.operation)
      || current.connectionGeneration !== generation) return current;
    if (current.state === "created") {
      return reverseCommandPayloadIsTransient(current.operation)
        ? current
        : this.sendCommand(current, socket, generation);
    }
    if (current.state === "sent") {
      if (reverseCommandPayloadIsTransient(current.operation)) {
        this.sendFrame(socket, { type: "command_status_request", protocol: 1, commandId: current.commandId });
        return current;
      }
      return this.sendCommand(current, socket, generation, true);
    }
    if (current.state !== "accepted" && current.state !== "running" && current.state !== "unknown") return current;
    this.sendFrame(socket, { type: "command_status_request", protocol: 1, commandId: current.commandId });
    return current;
  }

  private sendFrame(socket: WebSocket, frame: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) {
      throw new ReverseCommandGatewayError(502, "COMMAND_SEND_FAILED", "Peon connection closed before send");
    }
    const encoded = JSON.stringify(frame);
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (bytes > REVERSE_COMMAND_MAX_FRAME_BYTES || socket.bufferedAmount + bytes > MAX_SOCKET_BUFFER_BYTES) {
      throw new ReverseCommandGatewayError(429, "COMMAND_BACKPRESSURED", "Peon command channel is backpressured");
    }
    socket.send(encoded);
  }

  private async waitFor(initial: ReverseCommandRecord, requestedMs: number): Promise<ReverseCommandHttpResult> {
    if (initial.state === "terminal" || initial.state === "send_failed") return reverseCommandHttpResult(initial);
    const waitMs = Math.max(0, Math.min(Number.isFinite(requestedMs) ? requestedMs : DEFAULT_WAIT_MS, MAX_WAIT_MS));
    if (waitMs === 0) return reverseCommandHttpResult(initial);
    const key = `${initial.workspaceId}\0${initial.peonId}\0${initial.commandId}`;
    let expired = false;
    let wake!: () => void;
    const waiting = new Promise<void>((resolve) => {
      const listeners = this.waiters.get(key) ?? new Set<() => void>();
      wake = () => {
        clearTimeout(timer);
        listeners.delete(wake);
        if (listeners.size === 0) this.waiters.delete(key);
        resolve();
      };
      const timer = setTimeout(() => {
        expired = true;
        wake();
      }, waitMs);
      timer.unref();
      listeners.add(wake);
      this.waiters.set(key, listeners);
    });
    try {
      await this.afterWaiterRegistered?.();
      const observed = await getReverseCommand(initial.workspaceId, initial.peonId, initial.commandId);
      if (!observed) throw new ReverseCommandGatewayError(500, "INTERNAL", "reverse command disappeared");
      if (observed.state === "terminal" || observed.state === "send_failed" || observed.state === "unknown") wake();
      await waiting;
    } catch (error) {
      wake();
      throw error;
    }
    const current = await getReverseCommand(initial.workspaceId, initial.peonId, initial.commandId);
    if (!current) throw new ReverseCommandGatewayError(500, "INTERNAL", "reverse command disappeared");
    if (expired) this.requestStatusAfterTimeout(current);
    const timedOut = expired && (current.state === "created" || current.state === "sent");
    if (timedOut) countReverseCommandMetric("timeout", current.operation, "COMMAND_TIMEOUT");
    return reverseCommandHttpResult(current, timedOut);
  }

  private requestStatusAfterTimeout(record: ReverseCommandRecord): void {
    if (record.state !== "sent" && record.state !== "accepted"
      && record.state !== "running" && record.state !== "unknown") return;
    const socket = getPeonConnection(record.peonId);
    const generation = socket ? peonConnectionGeneration(socket) : null;
    if (!socket || !generation || record.connectionGeneration !== generation
      || !isCurrentPeonConnection(record.peonId, socket, generation)
      || !peonConnectionSupports(socket, REVERSE_COMMAND_CAPABILITY)
      || !peonConnectionSupportsCommand(socket, record.operation)) return;
    try {
      this.sendFrame(socket, {
        type: "command_status_request",
        protocol: 1,
        commandId: record.commandId,
      });
    } catch (error) {
      countReverseCommandMetric(
        "error",
        record.operation,
        error instanceof ReverseCommandGatewayError ? error.code : "COMMAND_SEND_FAILED",
      );
    }
  }

  private notify(record: ReverseCommandRecord, force = false): void {
    if (!force && record.state !== "terminal" && record.state !== "send_failed" && record.state !== "unknown") return;
    const key = `${record.workspaceId}\0${record.peonId}\0${record.commandId}`;
    for (const wake of this.waiters.get(key) ?? []) wake();
  }
}

export const reverseCommandGateway = new ReverseCommandGateway();
