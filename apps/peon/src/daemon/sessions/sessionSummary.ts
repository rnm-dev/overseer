import { previewText } from "./index.js";
import type { SessionOutcome, SessionRecord, SessionStatus, SessionTerminalReason } from "./sessionTypes.js";

// Canonical representation for session collections and north-bound session
// change events. Detail-only state stays on GET /sessions/:id.
export interface SessionSummary {
  id: string;
  kind: "agent" | "thread";
  threadState: "discussion" | "active" | null;
  threadSource: SessionRecord["threadSource"];
  status: SessionStatus | null;
  projectKey: string | null;
  projectId: string | null;
  title: string | null;
  promptPreview: string | null;
  lastMessagePreview: string | null;
  initiator: string | null;
  outcome: SessionOutcome | null;
  terminalReason: SessionTerminalReason | null;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
}

export function toSessionSummary(record: SessionRecord): SessionSummary {
  const bounded = (value: unknown): string | null => typeof value === "string" ? previewText(value) || null : null;
  const title = bounded(record.title);
  const promptPreview = title ? null : bounded(record.prompt);
  return {
    id: record.id,
    kind: record.kind ?? "agent",
    threadState: record.threadState ?? null,
    threadSource: record.threadSource ?? null,
    status: record.status,
    projectKey: record.projectKey,
    projectId: record.projectId,
    title,
    promptPreview,
    lastMessagePreview: bounded(record.lastMessagePreview),
    initiator: bounded(record.initiator),
    outcome: record.outcome ? {
      ...record.outcome,
      summary: bounded(record.outcome.summary) ?? "",
      ...(typeof record.outcome.previewPath === "string"
        ? { previewPath: bounded(record.outcome.previewPath) }
        : {}),
    } : null,
    terminalReason: record.terminalReason ? { ...record.terminalReason, message: bounded(record.terminalReason.message) ?? "" } : null,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    lastActivityAt: record.lastActivityAt,
  };
}
