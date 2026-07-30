import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { projectStore } from "../../../projects/index.js";
import { settings } from "../../../settings/index.js";
import { sessions, toPublicSessionRecord, } from "../../../sessions/index.js";
import { listConfiguredAgents, narrowModel, narrowReasoningEffort } from "../../../modelCatalog.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_TITLE_BYTES = 512;
const MAX_ATTACHMENTS = 20;
const MAX_RESULT_BYTES = 48 * 1024;
const PUBLIC_SESSION_KEYS = [
    "id", "prompt", "title", "followUpPrompts", "queuedFollowUps", "dir", "agent",
    "backendSessionId", "backendTurnId", "backendRuntimeGeneration", "backendTurnStatus",
    "model", "reasoningEffort", "projectId", "projectKey", "candidateProjectKeys",
    "taskKey", "taskTitle", "initiator", "parentSessionId", "spawnDepth", "spawnRequestId",
    "expectsOutcome", "status", "outcome", "startedAt", "endedAt", "turnCount", "turnBudget",
    "usage", "usageByModel", "contextUsage", "autoResumeAttempts", "lastActivityAt",
    "lastUserMessageAt", "lastMessagePreview", "eventCount",
];
const QUEUE_ITEM_KEYS = [
    "id", "sessionId", "prompt", "attachments", "permissionMode", "author",
    "model", "reasoningEffort", "commandId", "queuedAt",
];
function strict(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key));
}
function boundedText(value, maxBytes, nullable = false) {
    if (nullable && value === null)
        return true;
    return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= maxBytes;
}
function attachments(value) {
    return value === undefined || (Array.isArray(value) && value.length <= MAX_ATTACHMENTS && value.every((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
            return false;
        const attachment = item;
        return strict(attachment, ["originalName", "filename", "path", "size", "mimetype"])
            && typeof attachment.originalName === "string" && attachment.originalName.length <= 512
            && typeof attachment.filename === "string" && attachment.filename.length <= 512
            && typeof attachment.path === "string" && attachment.path.length <= 4096
            && Number.isSafeInteger(attachment.size) && Number(attachment.size) >= 0
            && typeof attachment.mimetype === "string" && attachment.mimetype.length <= 128;
    }));
}
function queueItem(value, sessionId) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const item = value;
    return strict(item, QUEUE_ITEM_KEYS) && item.sessionId === sessionId
        && typeof item.id === "string" && UUID.test(item.id)
        && boundedText(item.prompt, MAX_PROMPT_BYTES)
        && attachments(item.attachments)
        && (item.author === null || typeof item.author === "string")
        && (item.commandId === null || (typeof item.commandId === "string"
            && item.commandId.length > 0 && item.commandId.length <= 255))
        && Number.isSafeInteger(item.queuedAt) && Number(item.queuedAt) >= 0;
}
function publicSession(value, sessionId) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const session = value;
    return strict(session, PUBLIC_SESSION_KEYS) && session.id === sessionId
        && (session.status === "running" || session.status === "completed")
        && !Object.hasOwn(session, "pendingSystemPrompts")
        && !Object.hasOwn(session, "parentCompletionNotifiedAt")
        && !Object.hasOwn(session, "parentCompletionNotificationPending");
}
function publicResult(value) {
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_RESULT_BYTES
        ? { status: "applied", code: "OK", result: value }
        : { status: "rejected", code: "RESULT_TOO_LARGE" };
}
function rejected(code) {
    return { status: "rejected", code };
}
function targetSession(command) {
    return command.target.sessionId ?? null;
}
function validateTurn(payload, expected, mode) {
    const keys = ["prompt", "attachments", "permissionMode", "model", "reasoningEffort"];
    if (mode === "start")
        keys.push("title", "projectId", "dir", "expectsOutcome", "agent");
    if (mode === "queue")
        keys.push("startNow");
    if (!strict(payload, keys) || expected !== null)
        return "invalid session turn";
    if (!boundedText(payload.prompt, MAX_PROMPT_BYTES) || !attachments(payload.attachments))
        return "invalid prompt or attachments";
    if (payload.permissionMode !== undefined && payload.permissionMode !== "plan")
        return "invalid permission mode";
    if (mode === "start" && payload.title !== undefined && !boundedText(payload.title, MAX_TITLE_BYTES, true))
        return "invalid title";
    if (mode === "start" && payload.projectId !== undefined && (typeof payload.projectId !== "string" || !UUID.test(payload.projectId)))
        return "invalid project";
    if (mode === "start" && payload.dir !== undefined && (typeof payload.dir !== "string" || payload.dir.length > 4096))
        return "invalid directory";
    if (mode === "start" && payload.expectsOutcome !== undefined && typeof payload.expectsOutcome !== "boolean")
        return "invalid expectsOutcome";
    if (mode === "start" && payload.agent !== undefined && (typeof payload.agent !== "string" || !listConfiguredAgents({ visible: true, available: true }).includes(payload.agent)))
        return "invalid agent";
    if (mode === "queue" && payload.startNow !== undefined && typeof payload.startNow !== "boolean")
        return "invalid startNow";
    return null;
}
function turnOptions(command, agent, fileTransferRoot) {
    const payload = command.payload;
    const model = payload.model === undefined ? undefined : narrowModel(payload.model, agent);
    if (payload.model !== undefined && !model)
        throw new Error("INVALID_MODEL");
    const reasoningEffort = payload.reasoningEffort === undefined
        ? undefined
        : narrowReasoningEffort(payload.reasoningEffort, agent, model);
    if (payload.reasoningEffort !== undefined && !reasoningEffort)
        throw new Error("INVALID_REASONING_EFFORT");
    const attachmentList = (payload.attachments ?? []);
    let rootPath = "";
    if (attachmentList.length > 0) {
        const root = fileTransferRoot?.() ?? settings.get().fileTransferRoot;
        if (!root)
            throw new Error("FILES_DISABLED");
        try {
            rootPath = realpathSync(root);
        }
        catch {
            throw new Error("FILES_DISABLED");
        }
    }
    for (const attachment of attachmentList) {
        let candidate;
        const requested = path.isAbsolute(attachment.path)
            ? attachment.path
            : path.resolve(rootPath, attachment.path);
        try {
            candidate = realpathSync(requested);
        }
        catch {
            throw new Error("UNKNOWN_ATTACHMENT_PATH");
        }
        if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${path.sep}`))
            throw new Error("PATH_ESCAPE");
        let actual;
        try {
            actual = statSync(candidate);
        }
        catch {
            throw new Error("UNKNOWN_ATTACHMENT_PATH");
        }
        if (!actual.isFile() || actual.size !== attachment.size)
            throw new Error("ATTACHMENT_CHANGED");
        attachment.path = candidate;
    }
    return {
        prompt: payload.prompt.trim(),
        attachments: attachmentList,
        permissionMode: payload.permissionMode,
        model,
        reasoningEffort,
        commandId: command.commandId,
    };
}
function safeExecute(run) {
    try {
        return run();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (["INVALID_MODEL", "INVALID_REASONING_EFFORT", "FILES_DISABLED", "PATH_ESCAPE", "UNKNOWN_ATTACHMENT_PATH", "ATTACHMENT_CHANGED"].includes(message))
            return rejected(message);
        if (message === "unknown session")
            return rejected("UNKNOWN_SESSION");
        if (message === "a resume is already in progress")
            return { status: "conflict", code: "RESUME_IN_PROGRESS" };
        if (message.startsWith("dir does not exist"))
            return rejected("DIR_MISSING");
        return { status: "failed", code: "INTERNAL" };
    }
}
export function validSessionCommandExecution(command, execution) {
    if (Buffer.byteLength(JSON.stringify(execution.result ?? null)) > MAX_RESULT_BYTES)
        return false;
    if (execution.status === "failed") {
        return execution.result === undefined && execution.code === "INTERNAL";
    }
    if (execution.status === "rejected") {
        return execution.result === undefined && [
            "BAD_COMMAND", "UNKNOWN_SESSION", "UNKNOWN_PROJECT", "UNKNOWN_QUEUE_ITEM",
            "INVALID_MODEL", "INVALID_REASONING_EFFORT", "FILES_DISABLED", "PATH_ESCAPE",
            "UNKNOWN_ATTACHMENT_PATH", "ATTACHMENT_CHANGED", "DIR_MISSING", "RESULT_TOO_LARGE",
            "SESSION_NOT_RUNNING",
        ].includes(execution.code);
    }
    if (execution.status === "conflict") {
        return execution.result === undefined
            && ["RESUME_IN_PROGRESS", "SESSION_RUNNING"].includes(execution.code);
    }
    if (execution.code !== "OK" || !execution.result)
        return false;
    const sessionId = command.operation === "session.start" ? command.commandId : targetSession(command);
    if (!sessionId)
        return false;
    if (command.operation === "session.cancel") {
        return (execution.status === "applied" || execution.status === "noop")
            && strict(execution.result, ["sessionId", "sessionStatus"])
            && execution.result.sessionId === sessionId
            && (execution.result.sessionStatus === "completed" || execution.result.sessionStatus === "cancelled");
    }
    if (["session.detail", "session.start", "session.followup", "session.metadata.patch"].includes(command.operation)) {
        return execution.status === "applied" && publicSession(execution.result, sessionId);
    }
    if (command.operation === "session.queue.list") {
        return execution.status === "applied"
            && strict(execution.result, ["sessionId", "items"])
            && execution.result.sessionId === sessionId && Array.isArray(execution.result.items)
            && execution.result.items.every((item) => queueItem(item, sessionId));
    }
    if (command.operation === "session.queue.add") {
        return execution.status === "applied"
            && strict(execution.result, ["sessionId", "itemId", "session"])
            && execution.result.sessionId === sessionId
            && typeof execution.result.itemId === "string" && UUID.test(execution.result.itemId)
            && publicSession(execution.result.session, sessionId);
    }
    if (command.operation === "session.queue.edit") {
        return execution.status === "applied"
            && strict(execution.result, ["sessionId", "itemId", "session"])
            && execution.result.sessionId === sessionId
            && typeof execution.result.itemId === "string" && UUID.test(execution.result.itemId)
            && publicSession(execution.result.session, sessionId);
    }
    if (["session.queue.remove", "session.queue.send-now"].includes(command.operation)) {
        return execution.status === "applied"
            && strict(execution.result, ["sessionId", "itemId"])
            && execution.result.sessionId === sessionId
            && typeof execution.result.itemId === "string" && UUID.test(execution.result.itemId);
    }
    if (command.operation === "session.delete") {
        return (execution.status === "applied" || execution.status === "noop")
            && strict(execution.result, ["sessionId", "deleted"])
            && execution.result.sessionId === sessionId && execution.result.deleted === true;
    }
    return false;
}
export function sessionCommandHandlers(service = sessions, options = {}) {
    const sessionRequired = (payload, expected) => expected === null ? null : "operation requires no expected state";
    // Both queue-item commands differ only in the service call they make. They are
    // spelled out as literal keys rather than generated, because a key produced by
    // Object.fromEntries is invisible to the operation union that types this table
    // — the two commands were covered, but nothing could prove it.
    const queueItemHandler = (act) => ({
        validate: (payload, expected) => sessionRequired(payload, expected) ?? (strict(payload, ["itemId"]) && typeof payload.itemId === "string"
            && UUID.test(payload.itemId) ? null : "invalid queue item"),
        execute: (command) => {
            const itemId = command.payload.itemId;
            const result = act(targetSession(command), itemId);
            if (result === "unknown_session")
                return rejected("UNKNOWN_SESSION");
            if (result === "not_found")
                return rejected("UNKNOWN_QUEUE_ITEM");
            return publicResult({ sessionId: targetSession(command), itemId });
        },
    });
    return {
        "session.detail": {
            validate: (payload, expected) => sessionRequired(payload, expected) ?? (strict(payload, []) ? null : "session detail requires an empty payload"),
            execute: (command) => {
                const record = service.get(targetSession(command));
                return record
                    ? publicResult(toPublicSessionRecord(record))
                    : rejected("UNKNOWN_SESSION");
            },
        },
        "session.start": {
            validate: (payload, expected) => validateTurn(payload, expected, "start"),
            execute: (command) => safeExecute(() => {
                const payload = command.payload;
                const agent = payload.agent ?? settings.get().defaultAgent;
                const project = typeof payload.projectId === "string" ? projectStore.getById(payload.projectId) : undefined;
                if (payload.projectId !== undefined && !project)
                    return rejected("UNKNOWN_PROJECT");
                const turn = turnOptions(command, agent, options.fileTransferRoot);
                const record = service.start({
                    ...turn,
                    id: command.commandId,
                    title: payload.title,
                    dir: payload.dir ?? project?.dir,
                    projectKey: project?.key,
                    expectsOutcome: payload.expectsOutcome === true,
                    agent,
                    author: command.actor.email,
                });
                return publicResult(toPublicSessionRecord(record));
            }),
        },
        "session.followup": {
            validate: (payload, expected) => validateTurn(payload, expected, "followup"),
            execute: (command) => safeExecute(() => {
                const record = service.get(targetSession(command));
                if (!record)
                    return rejected("UNKNOWN_SESSION");
                const turn = turnOptions(command, record.agent, options.fileTransferRoot);
                return publicResult(toPublicSessionRecord(service.resume(record.id, turn.prompt, turn.attachments, turn.permissionMode, command.actor.email, turn.model, turn.reasoningEffort, turn.commandId)));
            }),
        },
        "session.queue.list": {
            validate: sessionRequired,
            execute: (command) => {
                const items = service.queued(targetSession(command));
                return items ? publicResult({ sessionId: targetSession(command), items }) : rejected("UNKNOWN_SESSION");
            },
        },
        "session.queue.add": {
            validate: (payload, expected) => validateTurn(payload, expected, "queue"),
            execute: (command) => safeExecute(() => {
                const record = service.get(targetSession(command));
                if (!record)
                    return rejected("UNKNOWN_SESSION");
                const turn = turnOptions(command, record.agent, options.fileTransferRoot);
                const updated = service.enqueue(record.id, turn.prompt, turn.attachments, turn.permissionMode, command.actor.email, turn.model, turn.reasoningEffort, turn.commandId, command.payload.startNow === true);
                const item = updated.queuedFollowUps.find((candidate) => candidate.commandId === turn.commandId);
                return item
                    ? publicResult({
                        sessionId: record.id,
                        itemId: item.id,
                        session: toPublicSessionRecord(updated),
                    })
                    : { status: "failed", code: "INTERNAL" };
            }),
        },
        "session.queue.edit": {
            validate: (payload, expected) => sessionRequired(payload, expected)
                ?? (strict(payload, ["itemId", "prompt"]) && typeof payload.itemId === "string" && UUID.test(payload.itemId)
                    && boundedText(payload.prompt, MAX_PROMPT_BYTES) ? null : "invalid queue edit"),
            execute: (command) => {
                const result = service.editQueued(targetSession(command), command.payload.itemId, command.payload.prompt.trim());
                if (result === "unknown_session")
                    return rejected("UNKNOWN_SESSION");
                if (result === "not_found")
                    return rejected("UNKNOWN_QUEUE_ITEM");
                return publicResult({
                    sessionId: result.id,
                    itemId: command.payload.itemId,
                    session: toPublicSessionRecord(result),
                });
            },
        },
        "session.queue.remove": queueItemHandler((sessionId, itemId) => service.removeQueued(sessionId, itemId)),
        "session.queue.send-now": queueItemHandler((sessionId, itemId) => service.sendQueuedNow(sessionId, itemId)),
        "session.metadata.patch": {
            validate: (payload, expected) => sessionRequired(payload, expected)
                ?? (strict(payload, ["title"]) && boundedText(payload.title, MAX_TITLE_BYTES, true) ? null : "invalid metadata patch"),
            execute: (command) => {
                const record = service.rename(targetSession(command), command.payload.title);
                return record ? publicResult(toPublicSessionRecord(record)) : rejected("UNKNOWN_SESSION");
            },
        },
        "session.delete": {
            validate: sessionRequired,
            execute: (command) => {
                const sessionId = targetSession(command);
                if (!sessionId)
                    return rejected("BAD_COMMAND");
                const result = service.delete(sessionId);
                if (result === "not_found")
                    return { status: "noop", code: "OK", result: { sessionId, deleted: true } };
                if (result === "running")
                    return { status: "conflict", code: "SESSION_RUNNING" };
                return publicResult({ sessionId, deleted: true });
            },
        },
    };
}
