import {
  sessions,
  toPublicSessionRecord,
  type SessionJsonService,
} from "../../../sessions/index.js";
import type { PeonSocketFrame } from "../peonSocketProtocol.js";
import type { ReverseCommandExecution, ReverseCommandHandler, ValidCommand } from "./reverseCommandChannel.js";
import type { ReverseCommandHandlersFor } from "./reverseCommandOperations.js";

const MAX_TITLE_BYTES = 512;
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

function strict(value: PeonSocketFrame, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function boundedText(value: unknown, maxBytes: number, nullable = false): boolean {
  if (nullable && value === null) return true;
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= maxBytes;
}

function publicSession(value: unknown, sessionId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as PeonSocketFrame;
  return strict(session, PUBLIC_SESSION_KEYS) && session.id === sessionId
    && (session.status === "running" || session.status === "completed")
    && !Object.hasOwn(session, "pendingSystemPrompts")
    && !Object.hasOwn(session, "parentCompletionNotifiedAt")
    && !Object.hasOwn(session, "parentCompletionNotificationPending");
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

export function validSessionCommandExecution(command: ValidCommand, execution: ReverseCommandExecution): boolean {
  if (Buffer.byteLength(JSON.stringify(execution.result ?? null)) > MAX_RESULT_BYTES) return false;
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
  if (execution.code !== "OK" || !execution.result) return false;
  const sessionId = targetSession(command);
  if (!sessionId) return false;
  if (command.operation === "session.metadata.patch") {
    return execution.status === "applied" && publicSession(execution.result, sessionId);
  }
  if (command.operation === "session.delete") {
    return (execution.status === "applied" || execution.status === "noop")
      && strict(execution.result, ["sessionId", "deleted"])
      && execution.result.sessionId === sessionId && execution.result.deleted === true;
  }
  return false;
}

export function sessionCommandHandlers(
  service: SessionJsonService = sessions,
): ReverseCommandHandlersFor<"session"> {
  const sessionRequired = (payload: PeonSocketFrame, expected: PeonSocketFrame | null) =>
    expected === null ? null : "operation requires no expected state";
  // Both queue-item commands differ only in the service call they make. They are
  // spelled out as literal keys rather than generated, because a key produced by
  // Object.fromEntries is invisible to the operation union that types this table
  // — the two commands were covered, but nothing could prove it.
  return {
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
