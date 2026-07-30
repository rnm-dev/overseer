import { createHash } from "node:crypto";
import {
  sessions,
  type SessionCatalogReader,
  type SessionLifecycleContract,
} from "../../../sessions/index.js";
import type { PeonSocketChannel, PeonSocketFrame, PeonSocketSender } from "../peonSocketProtocol.js";
import { ReverseCommandLedger, type ReverseCommandRecord } from "../reverseCommandLedger.js";
import { sessionCommandHandlers, validSessionCommandExecution } from "./sessionCommandHandlers.js";
import { daemonConfigurationChannel } from "./daemonConfigurationChannel.js";
import {
  attestUpdateCommand,
  updateCommandHandlers,
  waitForUpdateReplacement,
} from "./updateCommandHandlers.js";

export const REVERSE_COMMAND_CAPABILITY = "reverse-command-v1";
export const REVERSE_COMMAND_MAX_BYTES = 60 * 1024;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ReverseCommandExecution {
  status: "applied" | "noop" | "rejected" | "conflict" | "cancelled" | "failed";
  code: string;
  result?: PeonSocketFrame;
}

export interface ReverseCommandHandler {
  maxConcurrency?: number;
  priority?: "critical" | "control" | "normal";
  validate(payload: PeonSocketFrame, expected: PeonSocketFrame | null): string | null;
  execute(command: ValidCommand): Promise<ReverseCommandExecution> | ReverseCommandExecution;
}

export interface ValidCommand {
  commandId: string;
  operation: string;
  target: { peonId: string; sessionId?: string };
  actor: { userId: string; email: string };
  payload: PeonSocketFrame;
  expected: PeonSocketFrame | null;
  requestedAt: number;
}

export interface ReverseCommandChannelOptions {
  peonId: () => string | undefined;
  ledger?: ReverseCommandLedger;
  handlers?: Record<string, ReverseCommandHandler>;
  sessions?: Pick<SessionCatalogReader, "get"> & Pick<SessionLifecycleContract, "cancel">;
  maxConcurrency?: number;
  perSessionConcurrency?: number;
  publicationRetryBaseMs?: number;
  publicationRetryMaxMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}

function strictKeys(value: PeonSocketFrame, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && new Set(Object.keys(value)).size === Object.keys(value).length;
}

function requestHash(command: ValidCommand): string {
  return createHash("sha256").update(canonical({
    protocol: 1,
    capability: REVERSE_COMMAND_CAPABILITY,
    operation: command.operation,
    target: command.target,
    actor: command.actor,
    payload: command.payload,
    expected: command.expected,
  } as JsonValue)).digest("hex");
}

function commandResult(record: Pick<ReverseCommandRecord, "commandId" | "operation">, execution: ReverseCommandExecution, now = Date.now()): PeonSocketFrame {
  return {
    type: "command_result",
    protocol: 1,
    commandId: record.commandId,
    operation: record.operation,
    status: execution.status,
    code: execution.code,
    completedAt: now,
    result: execution.result ?? null,
  };
}

export function sessionCancelHandler(service: Pick<SessionCatalogReader, "get"> & Pick<SessionLifecycleContract, "cancel">): ReverseCommandHandler {
  return {
    priority: "critical",
    maxConcurrency: 8,
    validate: (payload, expected) => strictKeys(payload, []) && expected === null ? null : "session.cancel requires an empty payload and no expected object",
    execute: (command) => {
      const sessionId = command.target.sessionId!;
      const before = service.get(sessionId);
      if (!before) return { status: "rejected", code: "UNKNOWN_SESSION" };
      if (before.status !== "running") {
        return { status: "noop", code: "OK", result: { sessionId, sessionStatus: before.status } };
      }
      if (!service.cancel(sessionId)) return { status: "rejected", code: "SESSION_NOT_RUNNING" };
      const after = service.get(sessionId);
      return { status: "applied", code: "OK", result: { sessionId, sessionStatus: after?.status ?? "cancelled" } };
    },
  };
}

export class ReverseCommandChannel implements PeonSocketChannel {
  readonly capability = REVERSE_COMMAND_CAPABILITY;
  private readonly ledger: ReverseCommandLedger;
  private readonly handlers: Record<string, ReverseCommandHandler>;
  private readonly maxConcurrency: number;
  private readonly perSessionConcurrency: number;
  private readonly publicationRetryBaseMs: number;
  private readonly publicationRetryMaxMs: number;
  private accepted = false;
  private sender: PeonSocketSender | null = null;
  private running = 0;
  private criticalRunning = 0;
  private operationRunning = new Map<string, number>();
  private sessionRunning = new Map<string, number>();
  private queue: Array<{
    command: ValidCommand;
    handler: ReverseCommandHandler;
    authority: string;
    generation: number;
  }> = [];
  private queuedCommandIds = new Set<string>();
  private publicationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private publicationRetryAttempt = 0;

  constructor(private readonly options: ReverseCommandChannelOptions) {
    this.ledger = options.ledger ?? new ReverseCommandLedger();
    const sessionService = options.sessions ?? sessions;
    this.handlers = options.handlers ?? {
      "session.cancel": sessionCancelHandler(sessionService),
      ...sessionCommandHandlers(),
      "daemon.configuration.patch": daemonConfigurationChannel.commandHandler(),
      ...updateCommandHandlers(),
    };
    this.maxConcurrency = options.maxConcurrency ?? 16;
    this.perSessionConcurrency = options.perSessionConcurrency ?? 1;
    this.publicationRetryBaseMs = options.publicationRetryBaseMs ?? 50;
    this.publicationRetryMaxMs = options.publicationRetryMaxMs ?? 2_000;
  }

  registerHandlers(handlers: Record<string, ReverseCommandHandler>): void {
    Object.assign(this.handlers, handlers);
  }

  helloState(): PeonSocketFrame {
    return { protocol: 1, operations: Object.keys(this.handlers) };
  }

  started(sender: PeonSocketSender): void {
    this.sender = null;
    this.ledger.recoverInterrupted((interrupted) => {
      const execution = interrupted.operation === "update.apply"
        ? attestUpdateCommand(interrupted.commandId)
        : { status: "failed", code: "INTERNAL" } satisfies ReverseCommandExecution;
      return execution ? commandResult(interrupted, execution) : null;
    });
    for (const interrupted of this.records().filter((record) => record.state === "running")) {
      if (interrupted.operation === "update.apply") {
        void waitForUpdateReplacement(interrupted.commandId, { attestReady: true })
          .then((execution) => this.scheduleTerminalRetry(
            interrupted.commandId,
            interrupted.authority,
            interrupted.admittedGeneration,
            commandResult(interrupted, execution),
          ));
        continue;
      }
      this.scheduleTerminalRetry(
        interrupted.commandId,
        interrupted.authority,
        interrupted.admittedGeneration,
        commandResult(interrupted, { status: "failed", code: "INTERNAL" }),
      );
    }
    void sender;
  }

  connecting(): void {}

  negotiated(accepted: boolean, _acknowledgement: PeonSocketFrame, sender: PeonSocketSender): void {
    const authority = this.senderAuthority(sender);
    const generation = sender.generation;
    const active = accepted && sender.durable && authority !== null && Number.isSafeInteger(generation);
    this.accepted = active;
    this.sender = active ? sender : null;
    if (!accepted) return;
    if (!sender.durable) return sender.disconnect("reverse commands require durable-delivery-v1");
    if (!active || authority === null || generation === undefined) {
      return sender.disconnect("reverse commands require a fenced socket authority and generation");
    }
    this.publishPending();
    for (const record of this.pendingAccepted()) {
      if (record.authority !== authority) continue;
      if (record.admittedGeneration !== generation
        && !this.ledger.rebindAcceptedGeneration(record.commandId, authority, generation)) continue;
      const handler = this.handlers[record.operation];
      const command = record.command as unknown as ValidCommand | undefined;
      if (handler && command) this.enqueue(command, handler, authority, generation);
    }
    this.drain();
  }

  disconnected(_resetAuthority: boolean): void {
    this.accepted = false;
    this.sender = null;
    this.clearPublicationRetry();
  }

  handles(frame: PeonSocketFrame): boolean {
    return frame.type === "command" || frame.type === "command_status_request" || frame.type === "command_cancel";
  }

  receive(frame: PeonSocketFrame, sender: PeonSocketSender): void {
    if (!this.accepted) return sender.disconnect("reverse command received before capability negotiation");
    if (frame.type === "command_status_request") return this.status(frame, sender);
    if (frame.type === "command_cancel") {
      sender.send({
        type: "command_result",
        protocol: 1,
        commandId: frame.commandId,
        status: "rejected",
        code: "BAD_COMMAND",
        completedAt: Date.now(),
        result: null,
      });
      return;
    }
    const validated = this.validate(frame);
    if ("error" in validated) {
      if (validated.disconnect) return sender.disconnect(validated.error);
      sender.send({
        type: "command_result",
        protocol: 1,
        commandId: frame.commandId,
        operation: frame.operation,
        status: "rejected",
        code: "BAD_COMMAND",
        completedAt: Date.now(),
        result: null,
      });
      return;
    }
    const command = validated.command;
    const authority = this.senderAuthority(sender);
    const generation = sender.generation;
    if (authority === null || !Number.isSafeInteger(generation)) {
      return sender.disconnect("reverse command arrived without a fenced socket authority");
    }
    const handler = this.handlers[command.operation];
    const validationError = handler?.validate(command.payload, command.expected);
    if (!handler || validationError) {
      sender.send(commandResult(command, { status: "rejected", code: "BAD_COMMAND" }));
      return;
    }
    const hash = requestHash(command);
    const admission = this.ledger.admit({
      commandId: command.commandId,
      requestHash: hash,
      operation: command.operation,
      peonId: command.target.peonId,
      ...(command.target.sessionId ? { sessionId: command.target.sessionId } : {}),
      actorUserId: command.actor.userId,
      authority,
      admittedGeneration: generation!,
      command: command as unknown as PeonSocketFrame,
    });
    if (admission.kind === "reused") return void sender.send(commandResult(command, { status: "conflict", code: "COMMAND_ID_REUSED" }));
    if (admission.kind === "expired") return void sender.send(commandResult(command, { status: "rejected", code: "COMMAND_EXPIRED" }));
    if (admission.kind === "full") return void sender.send(commandResult(command, { status: "rejected", code: "COMMAND_LEDGER_FULL" }));
    if (admission.kind === "persist_failed") return void sender.send(commandResult(command, { status: "failed", code: "PERSIST_FAILED" }));

    sender.send({
      type: "command_accepted",
      protocol: 1,
      commandId: command.commandId,
      operation: command.operation,
      state: "accepted",
      replayed: admission.kind === "replayed",
      acceptedAt: admission.record.acceptedAt,
    });
    if (admission.kind === "replayed") {
      if (admission.record.state === "terminal" && admission.record.authority === authority) this.publishStored(admission.record, sender);
      return;
    }
    this.enqueue(command, handler, authority, generation!);
    this.drain();
  }

  durableAcknowledged(cursor: string): void {
    this.ledger.acknowledgeCursor(cursor);
    this.ledger.compact();
    this.publishPending();
  }

  private validate(frame: PeonSocketFrame): { command: ValidCommand } | { error: string; disconnect?: boolean } {
    if (Buffer.byteLength(JSON.stringify(frame)) > REVERSE_COMMAND_MAX_BYTES) return { error: "reverse command frame exceeds 60 KiB" };
    if (!strictKeys(frame, ["type", "protocol", "capability", "commandId", "operation", "target", "actor", "payload", "expected", "requestedAt"])
      || frame.protocol !== 1 || frame.capability !== this.capability || typeof frame.commandId !== "string" || !UUID.test(frame.commandId)
      || typeof frame.operation !== "string" || typeof frame.requestedAt !== "number"
      || !Number.isSafeInteger(frame.requestedAt) || frame.requestedAt < 0
      || !frame.target || typeof frame.target !== "object" || Array.isArray(frame.target)
      || !frame.actor || typeof frame.actor !== "object" || Array.isArray(frame.actor)
      || !frame.payload || typeof frame.payload !== "object" || Array.isArray(frame.payload)) return { error: "invalid reverse command envelope" };
    const target = frame.target as PeonSocketFrame;
    const actor = frame.actor as PeonSocketFrame;
    if (!strictKeys(target, ["peonId", "sessionId", "projectId"]) || typeof target.peonId !== "string" || !UUID.test(target.peonId)
      || (target.sessionId !== undefined && (typeof target.sessionId !== "string" || !UUID.test(target.sessionId)))
      || (target.projectId !== undefined && (typeof target.projectId !== "string" || !UUID.test(target.projectId)))
      || !strictKeys(actor, ["userId", "email"]) || typeof actor.userId !== "string" || !UUID.test(actor.userId)
      || typeof actor.email !== "string" || actor.email.length < 3 || actor.email.length > 320
      || (frame.expected !== undefined && frame.expected !== null
        && (typeof frame.expected !== "object" || Array.isArray(frame.expected)))) {
      return { error: "invalid reverse command identity or payload" };
    }
    if (target.peonId !== this.options.peonId()) return { error: "reverse command target Peon does not match authenticated socket", disconnect: true };
    if (frame.operation === "session.start" && (target.sessionId !== undefined || target.projectId !== undefined)) {
      return { error: "session.start targets only the authenticated Peon" };
    }
    if (frame.operation.startsWith("session.") && frame.operation !== "session.start"
      && (target.sessionId === undefined || target.projectId !== undefined)) {
      return { error: `${frame.operation} requires only target.sessionId` };
    }
    if (frame.operation === "daemon.configuration.patch" && (target.sessionId !== undefined || target.projectId !== undefined)) {
      return { error: "daemon.configuration.patch targets only the authenticated Peon" };
    }
    return { command: {
      commandId: frame.commandId,
      operation: frame.operation,
      target: { peonId: target.peonId, ...(typeof target.sessionId === "string" ? { sessionId: target.sessionId } : {}) },
      actor: { userId: actor.userId, email: actor.email },
      payload: frame.payload as PeonSocketFrame,
      expected: frame.expected === undefined ? null : frame.expected as PeonSocketFrame,
      requestedAt: frame.requestedAt,
    } };
  }

  private status(frame: PeonSocketFrame, sender: PeonSocketSender): void {
    if (!strictKeys(frame, ["type", "protocol", "commandId"]) || frame.protocol !== 1 || typeof frame.commandId !== "string" || !UUID.test(frame.commandId)) {
      sender.disconnect("invalid reverse command status request");
      return;
    }
    const record = this.ledger.get(frame.commandId);
    const authority = this.senderAuthority(sender);
    const visible = record && authority !== null && record.authority === authority ? record : undefined;
    sender.send({
      type: "command_status",
      protocol: 1,
      commandId: frame.commandId,
      state: visible?.state ?? "unknown",
      ...(visible?.state === "terminal" && visible.result ? { result: visible.result } : {}),
    });
  }

  private drain(): void {
    for (let index = 0; index < this.queue.length;) {
      const item = this.queue[index]!;
      const operationCount = this.operationRunning.get(item.command.operation) ?? 0;
      const sessionId = item.command.target.sessionId;
      const sessionCount = sessionId ? this.sessionRunning.get(sessionId) ?? 0 : 0;
      const critical = item.handler.priority === "critical";
      const hasGlobalCapacity = critical
        ? this.running < this.maxConcurrency + 1 && this.criticalRunning < 1
        : this.running < this.maxConcurrency;
      if (!hasGlobalCapacity || operationCount >= (item.handler.maxConcurrency ?? this.maxConcurrency)
        || (!critical && sessionId && sessionCount >= this.perSessionConcurrency)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      this.queuedCommandIds.delete(item.command.commandId);
      this.running += 1;
      if (critical) this.criticalRunning += 1;
      this.operationRunning.set(item.command.operation, operationCount + 1);
      if (sessionId) this.sessionRunning.set(sessionId, sessionCount + 1);
      void this.execute(item).finally(() => {
        this.running -= 1;
        if (critical) this.criticalRunning -= 1;
        this.operationRunning.set(item.command.operation, (this.operationRunning.get(item.command.operation) ?? 1) - 1);
        if (sessionId) this.sessionRunning.set(sessionId, (this.sessionRunning.get(sessionId) ?? 1) - 1);
        this.drain();
      });
    }
  }

  private async execute(item: {
    command: ValidCommand;
    handler: ReverseCommandHandler;
    authority: string;
    generation: number;
  }): Promise<void> {
    if (!this.ledger.markRunning(item.command.commandId, item.authority, item.generation)) return;
    let execution: ReverseCommandExecution;
    try {
      execution = await item.handler.execute(item.command);
    } catch {
      execution = { status: "failed", code: "INTERNAL" };
    }
    if (item.command.operation.startsWith("session.") && !validSessionCommandExecution(item.command, execution)) {
      execution = { status: "failed", code: "INTERNAL" };
    }
    const result = commandResult(item.command, execution);
    if (!this.ledger.markTerminal(item.command.commandId, item.authority, item.generation, result)) return;
    const record = this.ledger.get(item.command.commandId);
    const sender = this.sender;
    if (record && sender && this.senderAuthority(sender) === item.authority) this.publishStored(record, sender);
  }

  private publishStored(record: ReverseCommandRecord, sender: PeonSocketSender): void {
    const authority = this.senderAuthority(sender);
    if (!record.result || record.resultCursor || authority === null || record.authority !== authority) return;
    const published = sender.sendDurable(record.result, {
      priority: "critical",
      capability: this.capability,
      dedupeKey: `reverse-command-result:${record.commandId}`,
    });
    if (!published.accepted) {
      this.schedulePublicationRetry();
      return;
    }
    if (!this.ledger.bindResultCursor(record.commandId, authority, published.cursor)) {
      this.schedulePublicationRetry();
      return;
    }
    this.publicationRetryAttempt = 0;
  }

  private pendingTerminal(): ReverseCommandRecord[] {
    return this.records().filter((record) => record.state === "terminal" && !record.resultCursor);
  }

  private pendingAccepted(): ReverseCommandRecord[] {
    return this.records().filter((record) => record.state === "accepted");
  }

  private records(): ReverseCommandRecord[] {
    return this.ledger.records();
  }

  private enqueue(command: ValidCommand, handler: ReverseCommandHandler, authority: string, generation: number): void {
    if (this.queuedCommandIds.has(command.commandId)) return;
    const record = this.ledger.get(command.commandId);
    if (!record || record.state !== "accepted" || record.authority !== authority
      || record.admittedGeneration !== generation) return;
    this.queuedCommandIds.add(command.commandId);
    this.queue.push({ command, handler, authority, generation });
    this.queue.sort((a, b) => Number(b.handler.priority === "critical") - Number(a.handler.priority === "critical"));
  }

  private senderAuthority(sender: PeonSocketSender): string | null {
    return typeof sender.authority === "string" && sender.authority.length > 0 ? sender.authority : null;
  }

  private publishPending(): void {
    const sender = this.sender;
    if (!sender || !this.accepted || !sender.durable) return;
    const authority = this.senderAuthority(sender);
    if (!authority) return;
    let pending = false;
    for (const record of this.pendingTerminal()) {
      if (record.authority !== authority) continue;
      this.publishStored(record, sender);
      const latest = this.ledger.get(record.commandId);
      if (!latest?.resultCursor) pending = true;
    }
    if (pending) this.schedulePublicationRetry();
  }

  private schedulePublicationRetry(): void {
    if (this.publicationRetryTimer || !this.sender || !this.accepted) return;
    const delay = Math.min(
      this.publicationRetryMaxMs,
      this.publicationRetryBaseMs * (2 ** Math.min(this.publicationRetryAttempt, 10)),
    );
    this.publicationRetryAttempt += 1;
    this.publicationRetryTimer = setTimeout(() => {
      this.publicationRetryTimer = null;
      this.publishPending();
    }, delay);
    this.publicationRetryTimer.unref?.();
  }

  private clearPublicationRetry(): void {
    if (this.publicationRetryTimer) clearTimeout(this.publicationRetryTimer);
    this.publicationRetryTimer = null;
    this.publicationRetryAttempt = 0;
  }
}
