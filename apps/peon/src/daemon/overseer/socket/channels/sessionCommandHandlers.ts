import { statSync } from "node:fs";
import path from "node:path";
import { projectStore } from "../../../projects/index.js";
import { settings } from "../../../settings/index.js";
import {
  sessions,
  toPublicSessionRecord,
  type AttachmentInfo,
  type SessionJsonService,
} from "../../../sessions/index.js";
import { listConfiguredAgents, narrowModel, narrowReasoningEffort, type CodingAgent } from "../../../modelCatalog.js";
import type { PeonSocketFrame } from "../peonSocketProtocol.js";
import type { ReverseCommandExecution, ReverseCommandHandler, ValidCommand } from "./reverseCommandChannel.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_TITLE_BYTES = 512;
const MAX_ATTACHMENTS = 20;
const MAX_RESULT_BYTES = 48 * 1024;

function strict(value: PeonSocketFrame, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function boundedText(value: unknown, maxBytes: number, nullable = false): boolean {
  if (nullable && value === null) return true;
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= maxBytes;
}

function attachments(value: unknown): value is AttachmentInfo[] {
  return value === undefined || (Array.isArray(value) && value.length <= MAX_ATTACHMENTS && value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const attachment = item as unknown as PeonSocketFrame;
    return strict(attachment, ["originalName", "filename", "path", "size", "mimetype"])
      && typeof attachment.originalName === "string" && attachment.originalName.length <= 512
      && typeof attachment.filename === "string" && attachment.filename.length <= 512
      && typeof attachment.path === "string" && attachment.path.length <= 4096
      && Number.isSafeInteger(attachment.size) && Number(attachment.size) >= 0
      && typeof attachment.mimetype === "string" && attachment.mimetype.length <= 128;
  }));
}

function publicResult(value: PeonSocketFrame): ReverseCommandExecution {
  return Buffer.byteLength(JSON.stringify(value)) <= MAX_RESULT_BYTES
    ? { status: "applied", code: "OK", result: value }
    : { status: "rejected", code: "RESULT_TOO_LARGE" };
}

function rejected(code: string): ReverseCommandExecution {
  return { status: "rejected", code };
}

function targetSession(command: ValidCommand): string | null {
  return command.target.sessionId ?? null;
}

function validateTurn(payload: PeonSocketFrame, expected: PeonSocketFrame | null, start: boolean): string | null {
  const keys = ["prompt", "attachments", "permissionMode", "model", "reasoningEffort", "commandId"];
  if (start) keys.push("title", "projectId", "dir", "expectsOutcome", "agent");
  if (!strict(payload, keys) || expected !== null) return "invalid session turn";
  if (!boundedText(payload.prompt, MAX_PROMPT_BYTES) || !attachments(payload.attachments)) return "invalid prompt or attachments";
  if (payload.permissionMode !== undefined && payload.permissionMode !== "plan") return "invalid permission mode";
  if (payload.commandId !== undefined && (typeof payload.commandId !== "string" || !UUID.test(payload.commandId))) return "invalid turn command id";
  if (start && payload.title !== undefined && !boundedText(payload.title, MAX_TITLE_BYTES, true)) return "invalid title";
  if (start && payload.projectId !== undefined && (typeof payload.projectId !== "string" || !UUID.test(payload.projectId))) return "invalid project";
  if (start && payload.dir !== undefined && (typeof payload.dir !== "string" || payload.dir.length > 4096)) return "invalid directory";
  if (start && payload.expectsOutcome !== undefined && typeof payload.expectsOutcome !== "boolean") return "invalid expectsOutcome";
  if (start && payload.agent !== undefined && (typeof payload.agent !== "string" || !listConfiguredAgents({ visible: true, available: true }).includes(payload.agent))) return "invalid agent";
  return null;
}

function turnOptions(command: ValidCommand, agent: CodingAgent) {
  const payload = command.payload;
  const model = payload.model === undefined ? undefined : narrowModel(payload.model, agent);
  if (payload.model !== undefined && !model) throw new Error("INVALID_MODEL");
  const reasoningEffort = payload.reasoningEffort === undefined
    ? undefined
    : narrowReasoningEffort(payload.reasoningEffort, agent, model);
  if (payload.reasoningEffort !== undefined && !reasoningEffort) throw new Error("INVALID_REASONING_EFFORT");
  const attachmentList = (payload.attachments ?? []) as AttachmentInfo[];
  const root = settings.get().fileTransferRoot;
  if (attachmentList.length > 0 && !root) throw new Error("FILES_DISABLED");
  const rootPath = root ? path.resolve(root) : "";
  for (const attachment of attachmentList) {
    const candidate = path.resolve(attachment.path);
    if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${path.sep}`)) throw new Error("PATH_ESCAPE");
    let actual;
    try { actual = statSync(candidate); } catch { throw new Error("UNKNOWN_ATTACHMENT_PATH"); }
    if (!actual.isFile() || actual.size !== attachment.size) throw new Error("ATTACHMENT_CHANGED");
  }
  return {
    prompt: (payload.prompt as string).trim(),
    attachments: attachmentList,
    permissionMode: payload.permissionMode as string | undefined,
    model,
    reasoningEffort,
    commandId: (payload.commandId as string | undefined) ?? command.commandId,
  };
}

function safeExecute(run: () => ReverseCommandExecution): ReverseCommandExecution {
  try {
    return run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (["INVALID_MODEL", "INVALID_REASONING_EFFORT", "FILES_DISABLED", "PATH_ESCAPE", "UNKNOWN_ATTACHMENT_PATH", "ATTACHMENT_CHANGED"].includes(message)) return rejected(message);
    if (message === "unknown session") return rejected("UNKNOWN_SESSION");
    if (message === "a resume is already in progress") return { status: "conflict", code: "RESUME_IN_PROGRESS" };
    if (message.startsWith("dir does not exist")) return rejected("DIR_MISSING");
    return { status: "failed", code: "INTERNAL" };
  }
}

export function sessionCommandHandlers(service: SessionJsonService = sessions): Record<string, ReverseCommandHandler> {
  const sessionRequired = (payload: PeonSocketFrame, expected: PeonSocketFrame | null) =>
    expected === null ? null : "operation requires no expected state";
  return {
    "session.start": {
      validate: (payload, expected) => validateTurn(payload, expected, true),
      execute: (command) => safeExecute(() => {
        const payload = command.payload;
        const agent = (payload.agent as CodingAgent | undefined) ?? settings.get().defaultAgent;
        const project = typeof payload.projectId === "string" ? projectStore.getById(payload.projectId) : undefined;
        if (payload.projectId !== undefined && !project) return rejected("UNKNOWN_PROJECT");
        const options = turnOptions(command, agent);
        const record = service.start({
          ...options,
          id: command.commandId,
          title: payload.title as string | undefined,
          dir: (payload.dir as string | undefined) ?? project?.dir,
          projectKey: project?.key,
          expectsOutcome: payload.expectsOutcome === true,
          agent,
          author: command.actor.email,
        });
        return publicResult(toPublicSessionRecord(record) as unknown as PeonSocketFrame);
      }),
    },
    "session.followup": {
      validate: (payload, expected) => validateTurn(payload, expected, false),
      execute: (command) => safeExecute(() => {
        const record = service.get(targetSession(command)!);
        if (!record) return rejected("UNKNOWN_SESSION");
        const options = turnOptions(command, record.agent);
        return publicResult(toPublicSessionRecord(service.resume(
          record.id, options.prompt, options.attachments, options.permissionMode,
          command.actor.email, options.model, options.reasoningEffort, options.commandId,
        )) as unknown as PeonSocketFrame);
      }),
    },
    "session.queue.list": {
      validate: sessionRequired,
      execute: (command) => {
        const items = service.queued(targetSession(command)!);
        return items ? publicResult({ sessionId: targetSession(command)!, items }) : rejected("UNKNOWN_SESSION");
      },
    },
    "session.queue.add": {
      validate: (payload, expected) => validateTurn(payload, expected, false),
      execute: (command) => safeExecute(() => {
        const record = service.get(targetSession(command)!);
        if (!record) return rejected("UNKNOWN_SESSION");
        const options = turnOptions(command, record.agent);
        const updated = service.enqueue(record.id, options.prompt, options.attachments, options.permissionMode,
          command.actor.email, options.model, options.reasoningEffort, options.commandId, false);
        const item = updated.queuedFollowUps.find((candidate) => candidate.commandId === options.commandId);
        return publicResult({ sessionId: record.id, item: item ?? null });
      }),
    },
    "session.queue.edit": {
      validate: (payload, expected) => sessionRequired(payload, expected)
        ?? (strict(payload, ["itemId", "prompt"]) && typeof payload.itemId === "string" && UUID.test(payload.itemId)
          && boundedText(payload.prompt, MAX_PROMPT_BYTES) ? null : "invalid queue edit"),
      execute: (command) => {
        const result = service.editQueued(targetSession(command)!, command.payload.itemId as string, (command.payload.prompt as string).trim());
        if (result === "unknown_session") return rejected("UNKNOWN_SESSION");
        if (result === "not_found") return rejected("UNKNOWN_QUEUE_ITEM");
        return publicResult({ sessionId: result.id, itemId: command.payload.itemId as string });
      },
    },
    ...Object.fromEntries(["remove", "send-now"].map((action) => [`session.queue.${action}`, {
      validate: (payload: PeonSocketFrame, expected: PeonSocketFrame | null) =>
        sessionRequired(payload, expected) ?? (strict(payload, ["itemId"]) && typeof payload.itemId === "string" && UUID.test(payload.itemId) ? null : "invalid queue item"),
      execute: (command: ValidCommand) => {
        const result = action === "remove"
          ? service.removeQueued(targetSession(command)!, command.payload.itemId as string)
          : service.sendQueuedNow(targetSession(command)!, command.payload.itemId as string);
        if (result === "unknown_session") return rejected("UNKNOWN_SESSION");
        if (result === "not_found") return rejected("UNKNOWN_QUEUE_ITEM");
        return publicResult({ sessionId: targetSession(command)!, itemId: command.payload.itemId as string });
      },
    } satisfies ReverseCommandHandler])),
    "session.metadata.patch": {
      validate: (payload, expected) => sessionRequired(payload, expected)
        ?? (strict(payload, ["title"]) && boundedText(payload.title, MAX_TITLE_BYTES, true) ? null : "invalid metadata patch"),
      execute: (command) => {
        const record = service.rename(targetSession(command)!, command.payload.title as string | null);
        return record ? publicResult(toPublicSessionRecord(record) as unknown as PeonSocketFrame) : rejected("UNKNOWN_SESSION");
      },
    },
    "session.delete": {
      validate: sessionRequired,
      execute: (command) => {
        const sessionId = targetSession(command);
        if (!sessionId) return rejected("BAD_COMMAND");
        const result = service.delete(sessionId);
        if (result === "not_found") return { status: "noop", code: "OK", result: { sessionId, deleted: true } };
        if (result === "running") return { status: "conflict", code: "SESSION_RUNNING" };
        return publicResult({ sessionId, deleted: true });
      },
    },
  };
}
