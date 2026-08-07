import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { getAgentDriver } from "../agents/index.js";
import { projectStore } from "../projects/index.js";
import { classifyFromResultEvent } from "./runtime.js";
import { RESTART_INTERRUPTION_MARKER } from "./constants.js";
import { eventCountFromTranscript, persistSummary, previewFromTranscript, readTranscript, sessionsDir, } from "./sessionArtifacts.js";
import { sessionState } from "./state.js";
export function inferProjectKey(dir) {
    for (const project of projectStore.list()) {
        if (dir === project.dir)
            return project.key;
        if (dir.startsWith(`${project.dir}${path.sep}`))
            return project.key;
    }
    return null;
}
export function isRestartInterrupted(record) {
    return record.status === "completed" && (record.outcome?.summary ?? "").includes(RESTART_INTERRUPTION_MARKER);
}
export function restoreFromDisk() {
    if (!existsSync(sessionsDir))
        return;
    for (const file of readdirSync(sessionsDir)) {
        if (!file.endsWith(".summary.json"))
            continue;
        let record;
        try {
            record = JSON.parse(readFileSync(path.join(sessionsDir, file), "utf8"));
        }
        catch (error) {
            console.error(`sessions: skipping unreadable summary ${file}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        record.followUpPrompts ??= [];
        record.queuedFollowUps ??= [];
        const hadQueueTypes = record.queuedFollowUps.every((item) => item.type === "queue" || item.type === "steer");
        const hadQueueReplyTo = record.queuedFollowUps.every((item) => Object.prototype.hasOwnProperty.call(item, "replyTo"));
        for (const item of record.queuedFollowUps) {
            item.type ??= "queue";
            item.replyTo ??= null;
        }
        const hadPendingSystemPrompts = Object.prototype.hasOwnProperty.call(record, "pendingSystemPrompts");
        record.pendingSystemPrompts ??= [];
        record.taskKey ??= null;
        record.taskTitle ??= null;
        record.initiator ??= null;
        const hadOrchestrationFields = Object.prototype.hasOwnProperty.call(record, "parentSessionId")
            && Object.prototype.hasOwnProperty.call(record, "spawnDepth")
            && Object.prototype.hasOwnProperty.call(record, "spawnRequestId")
            && Object.prototype.hasOwnProperty.call(record, "parentCompletionNotifiedAt")
            && Object.prototype.hasOwnProperty.call(record, "parentCompletionNotificationPending");
        record.parentSessionId ??= null;
        record.spawnDepth ??= record.parentSessionId ? 1 : 0;
        record.spawnRequestId ??= null;
        record.parentCompletionNotifiedAt ??= null;
        record.parentCompletionNotificationPending ??= false;
        if (!hadOrchestrationFields || !hadPendingSystemPrompts || !hadQueueTypes || !hadQueueReplyTo)
            persistSummary(record);
        record.title ??= null;
        record.candidateProjectKeys ??= [];
        record.agent ??= "claude-code";
        const restoredDriver = getAgentDriver(record.agent);
        record.backendSessionId = restoredDriver?.conversation.recoverBackendId(record.id, record.backendSessionId ?? null) ?? record.backendSessionId ?? null;
        const transcript = readTranscript(record.id, record.agent);
        const backendEvent = transcript.findLast((event) => typeof event.backend_turn_id === "string");
        const hadBackendState = Object.prototype.hasOwnProperty.call(record, "backendTurnId")
            && Object.prototype.hasOwnProperty.call(record, "backendRuntimeGeneration")
            && Object.prototype.hasOwnProperty.call(record, "backendTurnStatus");
        record.backendTurnId = typeof record.backendTurnId === "string" ? record.backendTurnId
            : typeof backendEvent?.backend_turn_id === "string" ? backendEvent.backend_turn_id : null;
        record.backendSessionId = typeof record.backendSessionId === "string" ? record.backendSessionId
            : typeof backendEvent?.backend_turn_id === "string" ? backendEvent.backend_turn_id : null;
        record.backendRuntimeGeneration = typeof record.backendRuntimeGeneration === "number" ? record.backendRuntimeGeneration
            : typeof backendEvent?.runtime_generation === "number" ? backendEvent.runtime_generation : null;
        record.backendTurnStatus = ["inProgress", "completed", "interrupted", "failed", "unknown"].includes(String(record.backendTurnStatus))
            ? record.backendTurnStatus
            : ["inProgress", "completed", "interrupted", "failed", "unknown"].includes(String(backendEvent?.backend_turn_status))
                ? backendEvent?.backend_turn_status : null;
        if (!hadBackendState)
            persistSummary(record);
        record.usage ??= null;
        record.expectsOutcome ??= true;
        record.turnBudget ??= record.turnCount;
        record.autoResumeAttempts ??= 0;
        record.lastActivityAt ??= record.endedAt ?? record.startedAt;
        record.lastUserMessageAt ??= record.startedAt;
        if (record.lastMessagePreview === undefined) {
            record.lastMessagePreview = previewFromTranscript(record.id, record.agent);
            persistSummary(record);
        }
        if (record.eventCount === undefined) {
            record.eventCount = eventCountFromTranscript(record.id);
            persistSummary(record);
        }
        if (record.model === undefined) {
            record.model = null;
            persistSummary(record);
        }
        if (record.reasoningEffort === undefined) {
            record.reasoningEffort = null;
            persistSummary(record);
        }
        if (record.usageByModel === undefined) {
            record.usageByModel = {};
            persistSummary(record);
        }
        if (record.contextUsage === undefined) {
            record.contextUsage = null;
            persistSummary(record);
        }
        const hadProjectKey = Object.prototype.hasOwnProperty.call(record, "projectKey");
        if (!hadProjectKey) {
            record.projectKey = inferProjectKey(record.dir);
            persistSummary(record);
        }
        if (!Object.prototype.hasOwnProperty.call(record, "projectId")) {
            record.projectId = record.projectKey ? projectStore.get(record.projectKey)?.projectId ?? null : null;
            persistSummary(record);
        }
        sessionState.records.set(record);
        if (record.status === "running") {
            const lastUserIndex = transcript.findLastIndex((event) => event.type === "user_message");
            const lastResultIndex = transcript.findLastIndex((event) => event.type === "result");
            if (lastResultIndex > lastUserIndex) {
                classifyFromResultEvent(record, transcript[lastResultIndex]);
                continue;
            }
            record.status = "completed";
            record.outcome = { result: "failure", summary: `Daemon ${RESTART_INTERRUPTION_MARKER}.` };
            record.endedAt = record.endedAt ?? Date.now();
            persistSummary(record);
        }
    }
}
