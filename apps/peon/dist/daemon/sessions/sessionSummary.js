import { previewText } from "./index.js";
export function toSessionSummary(record) {
    const bounded = (value) => typeof value === "string" ? previewText(value) || null : null;
    const title = bounded(record.title);
    const promptPreview = title ? null : bounded(record.prompt);
    return {
        id: record.id,
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
