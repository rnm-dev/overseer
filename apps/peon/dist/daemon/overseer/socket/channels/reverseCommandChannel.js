import { createHash } from "node:crypto";
import { sessions, } from "../../../sessions/index.js";
import { createProjectService, projectStore, ProjectServiceError, } from "../../../projects/index.js";
import { ReverseCommandLedger } from "../reverseCommandLedger.js";
export const REVERSE_COMMAND_CAPABILITY = "reverse-command-v1";
export const REVERSE_COMMAND_MAX_BYTES = 60 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function canonical(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function strictKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key)) && new Set(Object.keys(value)).size === Object.keys(value).length;
}
function requestHash(command) {
    return createHash("sha256").update(canonical({
        protocol: 1,
        capability: REVERSE_COMMAND_CAPABILITY,
        operation: command.operation,
        target: command.target,
        actor: command.actor,
        payload: command.payload,
        expected: command.expected,
    })).digest("hex");
}
function commandResult(record, execution, now = Date.now()) {
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
export function sessionCancelHandler(service) {
    return {
        priority: "critical",
        maxConcurrency: 8,
        validate: (payload, expected) => strictKeys(payload, []) && expected === null ? null : "session.cancel requires an empty payload and no expected object",
        execute: (command) => {
            const sessionId = command.target.sessionId;
            const before = service.get(sessionId);
            if (!before)
                return { status: "rejected", code: "UNKNOWN_SESSION" };
            if (before.status !== "running") {
                return { status: "noop", code: "OK", result: { sessionId, sessionStatus: before.status } };
            }
            if (!service.cancel(sessionId))
                return { status: "rejected", code: "SESSION_NOT_RUNNING" };
            const after = service.get(sessionId);
            return { status: "applied", code: "OK", result: { sessionId, sessionStatus: after?.status ?? "cancelled" } };
        },
    };
}
export function projectArchiveHandler(service, archived) {
    return {
        priority: "control",
        maxConcurrency: 8,
        validate: (payload, expected) => strictKeys(payload, []) && expected === null
            ? null
            : `project.${archived ? "archive" : "unarchive"} requires an empty payload and no expected object`,
        execute: (command) => {
            const projectId = command.target.projectId;
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
            }
            catch (error) {
                if (error instanceof ProjectServiceError && error.kind === "UNKNOWN_PROJECT") {
                    return { status: "rejected", code: "UNKNOWN_PROJECT" };
                }
                throw error;
            }
        },
    };
}
export class ReverseCommandChannel {
    options;
    capability = REVERSE_COMMAND_CAPABILITY;
    ledger;
    handlers;
    maxConcurrency;
    perSessionConcurrency;
    accepted = false;
    sender = null;
    running = 0;
    operationRunning = new Map();
    sessionRunning = new Map();
    queue = [];
    constructor(options) {
        this.options = options;
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
    helloState() {
        return { protocol: 1, operations: Object.keys(this.handlers) };
    }
    started(sender) {
        this.sender = sender;
        for (const record of this.ledger.recoverInterrupted((interrupted) => commandResult(interrupted, {
            status: "failed",
            code: "INTERNAL",
            result: { safeDetail: "execution was interrupted; effect was not retried" },
        })))
            this.publishStored(record, sender);
        for (const operation of Object.values(this.handlers))
            void operation;
    }
    connecting() { }
    negotiated(accepted, _acknowledgement, sender) {
        this.accepted = accepted;
        this.sender = sender;
        if (!accepted)
            return;
        for (const record of this.pendingTerminal())
            this.publishStored(record, sender);
        for (const record of this.pendingAccepted()) {
            const handler = this.handlers[record.operation];
            const command = record.command;
            if (handler && command)
                this.queue.push({ command, handler });
        }
        this.drain();
    }
    disconnected(resetAuthority) {
        this.accepted = false;
        if (resetAuthority)
            this.sender = null;
    }
    handles(frame) {
        return frame.type === "command" || frame.type === "command_status_request" || frame.type === "command_cancel";
    }
    receive(frame, sender) {
        if (!this.accepted)
            return sender.disconnect("reverse command received before capability negotiation");
        if (frame.type === "command_status_request")
            return this.status(frame, sender);
        if (frame.type === "command_cancel") {
            sender.send({ type: "command_result", protocol: 1, commandId: frame.commandId, status: "rejected", code: "BAD_COMMAND", completedAt: Date.now() });
            return;
        }
        const validated = this.validate(frame);
        if ("error" in validated) {
            if (validated.disconnect)
                return sender.disconnect(validated.error);
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
            command: command,
        });
        if (admission.kind === "reused")
            return void sender.send(commandResult(command, { status: "conflict", code: "COMMAND_ID_REUSED" }));
        if (admission.kind === "expired")
            return void sender.send(commandResult(command, { status: "rejected", code: "COMMAND_EXPIRED" }));
        if (admission.kind === "full")
            return void sender.send(commandResult(command, { status: "rejected", code: "COMMAND_LEDGER_FULL" }));
        if (admission.kind === "persist_failed")
            return void sender.send(commandResult(command, { status: "failed", code: "PERSIST_FAILED" }));
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
            if (admission.record.state === "terminal")
                this.publishStored(admission.record, sender);
            return;
        }
        this.queue.push({ command, handler });
        this.queue.sort((a, b) => (a.handler.priority === "critical" ? -1 : 0) - (b.handler.priority === "critical" ? -1 : 0));
        this.drain();
    }
    durableAcknowledged(cursor) {
        this.ledger.acknowledgeCursor(cursor);
        this.ledger.compact();
    }
    validate(frame) {
        if (Buffer.byteLength(JSON.stringify(frame)) > REVERSE_COMMAND_MAX_BYTES)
            return { error: "reverse command frame exceeds 60 KiB" };
        if (!strictKeys(frame, ["type", "protocol", "capability", "commandId", "operation", "target", "actor", "payload", "expected", "requestedAt"])
            || frame.protocol !== 1 || frame.capability !== this.capability || typeof frame.commandId !== "string" || !UUID.test(frame.commandId)
            || typeof frame.operation !== "string" || typeof frame.requestedAt !== "number" || !Number.isSafeInteger(frame.requestedAt)
            || !frame.target || typeof frame.target !== "object" || Array.isArray(frame.target)
            || !frame.actor || typeof frame.actor !== "object" || Array.isArray(frame.actor)
            || !frame.payload || typeof frame.payload !== "object" || Array.isArray(frame.payload))
            return { error: "invalid reverse command envelope" };
        const target = frame.target;
        const actor = frame.actor;
        if (!strictKeys(target, ["peonId", "sessionId", "projectId"]) || typeof target.peonId !== "string" || !UUID.test(target.peonId)
            || (target.sessionId !== undefined && (typeof target.sessionId !== "string" || !UUID.test(target.sessionId)))
            || (target.projectId !== undefined && (typeof target.projectId !== "string" || !UUID.test(target.projectId)))
            || !strictKeys(actor, ["userId", "email"]) || typeof actor.userId !== "string" || !UUID.test(actor.userId)
            || typeof actor.email !== "string" || actor.email.length === 0 || actor.email.length > 320
            || (frame.expected !== undefined && (frame.expected === null || typeof frame.expected !== "object" || Array.isArray(frame.expected)))) {
            return { error: "invalid reverse command identity or payload" };
        }
        if (target.peonId !== this.options.peonId())
            return { error: "reverse command target Peon does not match authenticated socket", disconnect: true };
        if (frame.operation === "session.cancel" && target.sessionId === undefined)
            return { error: "session.cancel requires target.sessionId" };
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
                payload: frame.payload,
                expected: frame.expected === undefined ? null : frame.expected,
                requestedAt: frame.requestedAt,
            } };
    }
    status(frame, sender) {
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
    drain() {
        for (let index = 0; index < this.queue.length && this.running < this.maxConcurrency;) {
            const item = this.queue[index];
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
            if (sessionId)
                this.sessionRunning.set(sessionId, sessionCount + 1);
            void this.execute(item).finally(() => {
                this.running -= 1;
                this.operationRunning.set(item.command.operation, (this.operationRunning.get(item.command.operation) ?? 1) - 1);
                if (sessionId)
                    this.sessionRunning.set(sessionId, (this.sessionRunning.get(sessionId) ?? 1) - 1);
                this.drain();
            });
        }
    }
    async execute(item) {
        if (!this.ledger.markRunning(item.command.commandId))
            return;
        let execution;
        try {
            execution = await item.handler.execute(item.command);
        }
        catch {
            execution = { status: "failed", code: "INTERNAL" };
        }
        const result = commandResult(item.command, execution);
        if (!this.ledger.markTerminal(item.command.commandId, result))
            return;
        const record = this.ledger.get(item.command.commandId);
        if (record && this.sender)
            this.publishStored(record, this.sender);
    }
    publishStored(record, sender) {
        if (!record.result || record.resultCursor)
            return;
        const published = sender.sendDurable(record.result, {
            priority: "critical",
            capability: this.capability,
            dedupeKey: `reverse-command-result:${record.commandId}`,
        });
        if (published.accepted)
            this.ledger.bindResultCursor(record.commandId, published.cursor);
    }
    pendingTerminal() {
        return this.records().filter((record) => record.state === "terminal" && !record.resultCursor);
    }
    pendingAccepted() {
        return this.records().filter((record) => record.state === "accepted");
    }
    records() {
        return this.ledger.records();
    }
}
