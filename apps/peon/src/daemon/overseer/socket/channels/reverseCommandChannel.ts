import { createHash } from "node:crypto";
import {
  sessions,
  type SessionCatalogReader,
  type SessionLifecycleContract,
} from "../../../sessions/index.js";
import {
  createProjectService,
  projectStore,
  ProjectServiceError,
  type ProjectService,
} from "../../../projects/index.js";
import type { PeonSocketChannel, PeonSocketFrame, PeonSocketSender } from "../peonSocketProtocol.js";
import { ReverseCommandLedger, type ReverseCommandRecord } from "../reverseCommandLedger.js";

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
  target: { peonId: string; sessionId?: string; projectId?: string };
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
  projects?: Pick<ProjectService, "archiveById" | "unarchiveById">;
  maxConcurrency?: number;
  perSessionConcurrency?: number;
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
    ...(execution.result ? { result: execution.result } : {}),
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

export function projectArchiveHandler(
  service: Pick<ProjectService, "archiveById" | "unarchiveById">,
  archived: boolean,
): ReverseCommandHandler {
  return {
    priority: "control",
    maxConcurrency: 8,
    validate: (payload, expected) => strictKeys(payload, []) && expected === null
      ? null
      : `project.${archived ? "archive" : "unarchive"} requires an empty payload and no expected object`,
    execute: (command) => {
      const projectId = command.target.projectId!;
      try {
        const outcome = archived ? service.archiveById(projectId) : service.unarchiveById(projectId);
        return {
          status: outcome.changed ? "applied" : "noop",
          code: "OK",
          result: {
            projectId,
            key: outcome.project.key,
            archivedAt: outcome.project.archivedAt,
          },
        };
      } catch (error) {
        if (error instanceof ProjectServiceError && error.kind === "UNKNOWN_PROJECT") {
          return { status: "rejected", code: "UNKNOWN_PROJECT" };
        }
        throw error;
      }
    },
  };
}

export class ReverseCommandChannel implements PeonSocketChannel {
  readonly capability = REVERSE_COMMAND_CAPABILITY;
  private readonly ledger: ReverseCommandLedger;
  private readonly handlers: Record<string, ReverseCommandHandler>;
  private readonly maxConcurrency: number;
  private readonly perSessionConcurrency: number;
  private accepted = false;
  private sender: PeonSocketSender | null = null;
  private running = 0;
  private operationRunning = new Map<string, number>();
  private sessionRunning = new Map<string, number>();
  private queue: Array<{ command: ValidCommand; handler: ReverseCommandHandler }> = [];

  constructor(private readonly options: ReverseCommandChannelOptions) {
    this.ledger = options.ledger ?? new ReverseCommandLedger();
    const sessionService = options.sessions ?? sessions;
    const projectService = options.projects ?? createProjectService(projectStore, sessions);
    this.handlers = options.handlers ?? {
      "session.cancel": sessionCancelHandler(sessionService),
      "project.archive": projectArchiveHandler(projectService, true),
      "project.unarchive": projectArchiveHandler(projectService, false),
    };
    this.maxConcurrency = options.maxConcurrency ?? 16;
    this.perSessionConcurrency = options.perSessionConcurrency ?? 1;
  }

  helloState(): PeonSocketFrame {
    return { protocol: 1, operations: Object.keys(this.handlers) };
  }

  started(sender: PeonSocketSender): void {
    this.sender = sender;
    for (const record of this.ledger.recoverInterrupted((interrupted) => commandResult(interrupted, {
      status: "failed",
      code: "INTERNAL",
      result: { safeDetail: "execution was interrupted; effect was not retried" },
    }))) this.publishStored(record, sender);
    for (const operation of Object.values(this.handlers)) void operation;
  }

  connecting(): void {}

  negotiated(accepted: boolean, _acknowledgement: PeonSocketFrame, sender: PeonSocketSender): void {
    this.accepted = accepted;
    this.sender = sender;
    if (!accepted) return;
    for (const record of this.pendingTerminal()) this.publishStored(record, sender);
    for (const record of this.pendingAccepted()) {
      const handler = this.handlers[record.operation];
      const command = record.command as unknown as ValidCommand | undefined;
      if (handler && command) this.queue.push({ command, handler });
    }
    this.drain();
  }

  disconnected(resetAuthority: boolean): void {
    this.accepted = false;
    if (resetAuthority) this.sender = null;
  }

  handles(frame: PeonSocketFrame): boolean {
    return frame.type === "command" || frame.type === "command_status_request" || frame.type === "command_cancel";
  }

  receive(frame: PeonSocketFrame, sender: PeonSocketSender): void {
    if (!this.accepted) return sender.disconnect("reverse command received before capability negotiation");
    if (frame.type === "command_status_request") return this.status(frame, sender);
    if (frame.type === "command_cancel") {
      sender.send({ type: "command_result", protocol: 1, commandId: frame.commandId, status: "rejected", code: "BAD_COMMAND", completedAt: Date.now() });
      return;
    }
    const validated = this.validate(frame);
    if ("error" in validated) {
      if (validated.disconnect) return sender.disconnect(validated.error);
      sender.send({ type: "command_result", protocol: 1, commandId: frame.commandId, operation: frame.operation, status: "rejected", code: "BAD_COMMAND", completedAt: Date.now() });
      return;
    }
    const command = validated.command;
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
      if (admission.record.state === "terminal") this.publishStored(admission.record, sender);
      return;
    }
    this.queue.push({ command, handler });
    this.queue.sort((a, b) => (a.handler.priority === "critical" ? -1 : 0) - (b.handler.priority === "critical" ? -1 : 0));
    this.drain();
  }

  durableAcknowledged(cursor: string): void {
    this.ledger.acknowledgeCursor(cursor);
    this.ledger.compact();
  }

  private validate(frame: PeonSocketFrame): { command: ValidCommand } | { error: string; disconnect?: boolean } {
    if (Buffer.byteLength(JSON.stringify(frame)) > REVERSE_COMMAND_MAX_BYTES) return { error: "reverse command frame exceeds 60 KiB" };
    if (!strictKeys(frame, ["type", "protocol", "capability", "commandId", "operation", "target", "actor", "payload", "expected", "requestedAt"])
      || frame.protocol !== 1 || frame.capability !== this.capability || typeof frame.commandId !== "string" || !UUID.test(frame.commandId)
      || typeof frame.operation !== "string" || typeof frame.requestedAt !== "number" || !Number.isSafeInteger(frame.requestedAt)
      || !frame.target || typeof frame.target !== "object" || Array.isArray(frame.target)
      || !frame.actor || typeof frame.actor !== "object" || Array.isArray(frame.actor)
      || !frame.payload || typeof frame.payload !== "object" || Array.isArray(frame.payload)) return { error: "invalid reverse command envelope" };
    const target = frame.target as PeonSocketFrame;
    const actor = frame.actor as PeonSocketFrame;
    if (!strictKeys(target, ["peonId", "sessionId", "projectId"]) || typeof target.peonId !== "string" || !UUID.test(target.peonId)
      || (target.sessionId !== undefined && (typeof target.sessionId !== "string" || !UUID.test(target.sessionId)))
      || (target.projectId !== undefined && (typeof target.projectId !== "string" || !UUID.test(target.projectId)))
      || !strictKeys(actor, ["userId", "email"]) || typeof actor.userId !== "string" || !UUID.test(actor.userId)
      || typeof actor.email !== "string" || actor.email.length === 0 || actor.email.length > 320
      || (frame.expected !== undefined && (frame.expected === null || typeof frame.expected !== "object" || Array.isArray(frame.expected)))) {
      return { error: "invalid reverse command identity or payload" };
    }
    if (target.peonId !== this.options.peonId()) return { error: "reverse command target Peon does not match authenticated socket", disconnect: true };
    if (frame.operation === "session.cancel" && target.sessionId === undefined) return { error: "session.cancel requires target.sessionId" };
    if ((frame.operation === "project.archive" || frame.operation === "project.unarchive") && target.projectId === undefined) {
      return { error: `${frame.operation} requires target.projectId` };
    }
    return { command: {
      commandId: frame.commandId,
      operation: frame.operation,
      target: {
        peonId: target.peonId,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...(target.projectId ? { projectId: target.projectId } : {}),
      },
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
    sender.send({
      type: "command_status",
      protocol: 1,
      commandId: frame.commandId,
      state: record?.state ?? "unknown",
      ...(record?.state === "terminal" && record.result ? { result: record.result } : {}),
    });
  }

  private drain(): void {
    for (let index = 0; index < this.queue.length && this.running < this.maxConcurrency;) {
      const item = this.queue[index]!;
      const operationCount = this.operationRunning.get(item.command.operation) ?? 0;
      const sessionId = item.command.target.sessionId;
      const sessionCount = sessionId ? this.sessionRunning.get(sessionId) ?? 0 : 0;
      if (operationCount >= (item.handler.maxConcurrency ?? this.maxConcurrency) || (sessionId && sessionCount >= this.perSessionConcurrency)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      this.running += 1;
      this.operationRunning.set(item.command.operation, operationCount + 1);
      if (sessionId) this.sessionRunning.set(sessionId, sessionCount + 1);
      void this.execute(item).finally(() => {
        this.running -= 1;
        this.operationRunning.set(item.command.operation, (this.operationRunning.get(item.command.operation) ?? 1) - 1);
        if (sessionId) this.sessionRunning.set(sessionId, (this.sessionRunning.get(sessionId) ?? 1) - 1);
        this.drain();
      });
    }
  }

  private async execute(item: { command: ValidCommand; handler: ReverseCommandHandler }): Promise<void> {
    if (!this.ledger.markRunning(item.command.commandId)) return;
    let execution: ReverseCommandExecution;
    try {
      execution = await item.handler.execute(item.command);
    } catch {
      execution = { status: "failed", code: "INTERNAL" };
    }
    const result = commandResult(item.command, execution);
    if (!this.ledger.markTerminal(item.command.commandId, result)) return;
    const record = this.ledger.get(item.command.commandId);
    if (record && this.sender) this.publishStored(record, this.sender);
  }

  private publishStored(record: ReverseCommandRecord, sender: PeonSocketSender): void {
    if (!record.result || record.resultCursor) return;
    const published = sender.sendDurable(record.result, {
      priority: "critical",
      capability: this.capability,
      dedupeKey: `reverse-command-result:${record.commandId}`,
    });
    if (published.accepted) this.ledger.bindResultCursor(record.commandId, published.cursor);
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
}
