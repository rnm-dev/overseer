import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { accumulateUsage, usageFromEvent, usageModelsFromEvent } from "./usageAccounting.js";
import path from "node:path";
import { settings } from "../settings/index.js";
import { McpConfigAssembler, mcpBindingRegistry } from "../mcpBindings.js";
import { runAgent } from "../agents/index.js";
import { getAgentDriver, requireAgentDriver } from "../agents/index.js";
import { projectStore } from "../projects/index.js";
import { resolveFromDir } from "../files/index.js";
import { resolveModel, resolveReasoningEffort } from "../providers/modelCatalog.js";
import { buildAugmentedPrompt, buildSystemPrompt } from "./sessionPrompts.js";
import { acknowledgeContextClaim, claimContext, releaseContextClaim, withParticipantContext } from "./contextMessages.js";
import { buildReplyPrompt } from "./replyTo.js";
import { sessionWarnings } from "./sessionWarnings.js";
import { appendTranscriptEvent, assistantEventText, persistSummary, previewText, readTranscript, sessionsDir, } from "./sessionArtifacts.js";
import { isAgentPreviewArtifact, previewPathsFromAgentEvent, sessionPreviewDir } from "./preview.js";
import { WARNING_COOLDOWN_MS, sessionState } from "./state.js";
import { parseListenAddress } from "../../shared/listenAddress.js";
export function appendPreviewEvent(record, filePath, author) {
    const trimmed = filePath.trim();
    if (!trimmed)
        return null;
    const event = {
        type: "preview",
        path: trimmed,
        name: path.basename(trimmed),
        ...(author ? { author } : {}),
    };
    const entry = appendTranscriptEvent(record.id, event);
    record.lastActivityAt = entry.event.createdAt;
    record.eventCount += 1;
    persistSummary(record);
    sessionState.emitter.emit("event", { sessionId: record.id, event: entry.event, eventId: entry.id });
    sessionState.emitter.emit("change", record);
    return entry.event;
}
function warningFromEvent(event) {
    if (event.type !== "warning" || typeof event.sessionId !== "string"
        || !["context_near_limit", "payload_near_limit", "payload_truncated", "turn_limit_exceeded", "task_timeout"].includes(String(event.code))
        || typeof event.message !== "string")
        return null;
    const { type: _type, ...fields } = event;
    return { type: "session_warning", ...fields };
}
function shouldEmitWarning(warning, now = Date.now()) {
    if (warning.code === "payload_truncated")
        return true;
    const key = `${warning.sessionId}:${warning.code}:${warning.source ?? "session"}`;
    const ratio = warning.limitBytes
        ? (warning.currentBytes ?? 0) / warning.limitBytes
        : warning.limitTokens
            ? (warning.currentTokens ?? 0) / warning.limitTokens
            : 0;
    const previous = sessionState.warningThrottle.get(key);
    if (previous && now - previous.at < WARNING_COOLDOWN_MS && ratio < previous.ratio + 0.1)
        return false;
    sessionState.warningThrottle.set(key, { at: now, ratio });
    return true;
}
// Native steering acknowledgements can race a terminal provider event. Give a
// late acknowledgement a short window to settle, then repair any stale
// in-memory barriers so a durable queued message cannot remain stranded until
// the daemon restarts.
const QUEUED_DISPATCH_BARRIER_GRACE_MS = 2_000;
export function scheduleQueuedDispatch(record) {
    if ((record.queuedFollowUps.length === 0 && record.pendingSystemPrompts.length === 0)
        || sessionState.queueDispatchPending.has(record.id))
        return;
    sessionState.queueDispatchPending.add(record.id);
    queueMicrotask(() => {
        if (sessionState.records.get(record.id) !== record) {
            sessionState.queueDispatchPending.delete(record.id);
            return;
        }
        if (record.status !== "completed") {
            sessionState.queueDispatchPending.delete(record.id);
            return;
        }
        const hasDispatchBarrier = sessionState.activeRuns.has(record.id)
            || sessionState.resumePending.has(record.id)
            || sessionState.steerPending.has(record.id);
        if (hasDispatchBarrier) {
            const terminalAt = record.endedAt ?? record.lastActivityAt ?? Date.now();
            const graceRemaining = QUEUED_DISPATCH_BARRIER_GRACE_MS - Math.max(0, Date.now() - terminalAt);
            if (graceRemaining > 0) {
                const retry = setTimeout(() => {
                    sessionState.queueDispatchPending.delete(record.id);
                    scheduleQueuedDispatch(record);
                }, graceRemaining);
                retry.unref();
                return;
            }
            const barriers = [
                sessionState.activeRuns.has(record.id) ? "active-run" : null,
                sessionState.resumePending.has(record.id) ? "resume" : null,
                sessionState.steerPending.has(record.id) ? "steer" : null,
            ].filter(Boolean).join(",");
            console.warn(`sessions: clearing stale queued-dispatch barriers for completed session ${record.id}: ${barriers}`);
            sessionState.activeRuns.delete(record.id);
            sessionState.resumePending.delete(record.id);
            sessionState.steerPending.delete(record.id);
        }
        sessionState.queueDispatchPending.delete(record.id);
        const item = record.queuedFollowUps.shift();
        if (item?.type === "steer") {
            const receipts = record.steeredQueueItemIds ??= [];
            if (!receipts.includes(item.id)) {
                receipts.push(item.id);
                if (receipts.length > 128)
                    receipts.splice(0, receipts.length - 128);
            }
        }
        // Keep triggers durable until the provider process has actually started.
        // A setup/configuration failure must not acknowledge invisible work that
        // no agent ever received.
        const systemPrompts = record.pendingSystemPrompts.slice();
        if (!item && systemPrompts.length === 0)
            return;
        if (item)
            record.followUpPrompts.push(item.prompt);
        // Queue entries come from human/fleet transports. Orchestration follow-ups
        // use resume() directly and arm this marker there, so a queued turn must
        // never inherit notification debt from the turn that just completed.
        record.parentCompletionNotificationPending = false;
        record.status = "running";
        record.outcome = null;
        record.terminalReason = null;
        record.endedAt = null;
        try {
            runProcess(record, item?.prompt ?? "", record.backendSessionId !== null, item?.attachments ?? [], item?.permissionMode ?? undefined, item?.author ?? undefined, item?.model ?? undefined, item?.reasoningEffort ?? undefined, item?.commandId ?? systemPrompts.map((prompt) => prompt.commandId).find(Boolean) ?? undefined, systemPrompts, 0, true, item?.replyTo ?? undefined, { authorPrincipal: item?.authorPrincipal ?? undefined, mentions: item?.mentions ?? undefined });
        }
        catch (error) {
            // Put the item back if a synchronous spawn/setup error occurs. A queued
            // human message must never disappear merely because the agent failed to
            // start.
            if (item) {
                record.queuedFollowUps.unshift(item);
                record.followUpPrompts.pop();
            }
            record.status = "completed";
            record.endedAt = Date.now();
            persistSummary(record);
            sessionState.emitter.emit("change", record);
            console.error(`failed to dispatch ${item ? `queued follow-up ${item.id}` : "system triggers"}: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
}
// The concrete model id an event reveals, if any — the CLI stamps it on its
// `system` init event (`event.model`) and on each `assistant` event
// (`event.message.model`). Used to attribute a turn's usage to the model that
// actually ran it, which resolves aliases and "default" turns to a real id.
function eventModel(event) {
    if (typeof event.model === "string")
        return event.model;
    const message = event.message;
    if (message && typeof message.model === "string")
        return message.model;
    return null;
}
function isSyntheticAssistantEvent(event) {
    if (event.type !== "assistant")
        return false;
    const message = event.message;
    return message?.model === "<synthetic>";
}
export function finalizeSession(record, outcome, numTurns, usage, 
// Concrete model this turn's `usage` should be attributed to, for the
// per-model breakdown. Null/omitted ⇒ bucketed under "unknown".
model, 
// record.turnCount as it stood *before* this run — i.e. the accumulated total
// from prior invocations. This run's authoritative `numTurns` is added to it,
// so a resumed session's turn count is the sum across every invocation, not
// just the last. Omitted on the harness-fail paths (no numTurns) where the
// live-incremented count already stands.
turnCountBase, dispatchQueued = true, terminalReason = null) {
    // A clean finish (chat with nothing to grade, or a graded success) is the
    // strongest possible signal claude-code is working — clears any
    // previously observed auth failure regardless of what caused it.
    if (outcome === null || outcome.result === "success")
        getAgentDriver(record.agent)?.auth.observeSuccess();
    record.status = "completed";
    record.outcome = outcome;
    record.terminalReason = terminalReason;
    record.endedAt = Date.now();
    // Finishing is the session's last update — keeps it sorted correctly in the
    // list's non-running band even for a run that ended without ever emitting a
    // previewable assistant message.
    record.lastActivityAt = record.endedAt;
    // Accumulate across invocations, don't overwrite: numTurns and usage are each
    // per-invocation (one `claude -p --resume`), so a session with follow-ups must
    // sum them or it reports only the last turn's figures. turnCount is added onto
    // the pre-run base (the live in-run increments are discarded here in favour of
    // the CLI's authoritative num_turns); usage is folded field-by-field.
    if (typeof numTurns === "number")
        record.turnCount = (turnCountBase ?? 0) + numTurns;
    if (usage) {
        accumulateUsage(record, usage, model);
    }
    persistSummary(record);
    // Remove the live process before publishing the terminal summary so
    // activeCount() and status:"completed" describe the same boundary.
    sessionState.activeRuns.delete(record.id);
    sessionState.emitter.emit("change", record);
    sessionState.emitter.emit("complete", record);
    if (dispatchQueued)
        scheduleQueuedDispatch(record);
}
// AgentEvent is an untyped Record<string, unknown> (the CLI's stream-json
// output has no compile-time shape), so every field is read defensively.
// Present on both success and error result events — even a failed run spent
// some tokens, worth recording.
// Tiers 2 and 3 of the outcome classification — tier 1 (harness force-fail on
// timeout/turn-cap/spawn error/missing result event) is handled inline in
// runProcess()'s exit handler.
export function classifyFromResultEvent(record, resultEvent, runModel, turnCountBase) {
    const numTurns = typeof resultEvent.num_turns === "number" ? resultEvent.num_turns : undefined;
    const usage = usageFromEvent(resultEvent);
    // Prefer the model captured live from the run's events; fall back to a model
    // on the result event itself if the CLI put one there.
    const model = runModel || eventModel(resultEvent);
    accumulateUsage(record, usage, model, usageModelsFromEvent(resultEvent));
    if (resultEvent.is_error === true || resultEvent.subtype !== "success") {
        // errors[] carries the actual human-readable reason (e.g. "No
        // conversation found with session ID: ..." from a --resume against a
        // session with nothing persisted) — prefer it over dumping the whole
        // raw event, which is technically complete but unreadable.
        let reason;
        if (Array.isArray(resultEvent.errors) && resultEvent.errors.length > 0) {
            reason = resultEvent.errors.join("; ");
        }
        else if (typeof resultEvent.result === "string") {
            reason = resultEvent.result;
        }
        else {
            reason = JSON.stringify(resultEvent);
        }
        getAgentDriver(record.agent)?.auth.observeFailure(reason);
        finalizeSession(record, { result: "failure", summary: `Agent CLI reported an error (subtype: ${String(resultEvent.subtype)}): ${reason}` }, numTurns, undefined, model, turnCountBase);
        return;
    }
    // Chat sessions never requested --json-schema (see runProcess), so there's
    // no structured_output to look for and nothing to grade — a clean
    // completion just has no outcome, rather than a fabricated one.
    if (!record.expectsOutcome) {
        finalizeSession(record, null, numTurns, undefined, model, turnCountBase);
        return;
    }
    const structured = resultEvent.structured_output;
    if (structured &&
        (structured.result === "success" || structured.result === "failure" || structured.result === "needs_human") &&
        typeof structured.summary === "string") {
        const outcome = requireAgentDriver(record.agent).normalizeOutcome(structured);
        if (!outcome) {
            finalizeSession(record, { result: "failure", summary: "Agent completed but did not produce a valid structured outcome." }, numTurns, undefined, model, turnCountBase);
            return;
        }
        finalizeSession(record, outcome, numTurns, undefined, model, turnCountBase);
        return;
    }
    finalizeSession(record, { result: "failure", summary: "Agent completed but did not produce a valid structured outcome." }, numTurns, undefined, model, turnCountBase);
}
// Shared by a fresh start() and a resume() follow-up — spawns the process,
// wires transcript/turn-cap/timeout/outcome handling. `record.turnCount`
// isn't reset by callers on resume, so the cap keeps applying cumulatively
// across the whole conversation, not just the latest message. To keep a
// busy-but-completed session resumable, each spawn through here grants another
// maxTurns' worth of headroom (`record.turnBudget += maxTurns`) — a fresh
// start gets one portion, every follow-up message adds one more.
// `perTurnModel` and `perTurnReasoningEffort` are explicit follow-up selections
// and become the session's own defaults; when omitted, the spawn falls back to
// the session/daemon or CLI defaults.
export function appendUserTurn(record, prompt, attachments = [], permissionMode, author, model, reasoningEffort, commandId, replyTo, attribution) {
    const userEvent = {
        type: "user_message", text: prompt,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(author ? { author } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(commandId ? { commandId } : {}),
        ...(replyTo ? { replyTo } : {}),
        // The string `author` stays as it was; the structured principal is what
        // makes self-exclusion and guest attribution stable for mention attention.
        ...(attribution?.authorPrincipal ? { authorPrincipal: attribution.authorPrincipal } : {}),
        ...(attribution?.mentions?.length ? { mentions: attribution.mentions } : {}),
    };
    const userEntry = appendTranscriptEvent(record.id, userEvent);
    const now = userEntry.event.createdAt;
    record.lastUserMessageAt = now;
    record.lastActivityAt = now;
    if (prompt.trim())
        record.lastMessagePreview = previewText(prompt);
    sessionState.emitter.emit("event", { sessionId: record.id, event: userEntry.event, eventId: userEntry.id });
}
function writeMcpConfig(record) {
    const controlPort = parseListenAddress(settings.get().listenAddress).port;
    const assembled = new McpConfigAssembler(mcpBindingRegistry, `http://127.0.0.1:${controlPort}`).assemble({
        sessionId: record.id,
        turnId: randomUUID(),
        projectId: record.projectId,
        // Children never receive the spawning tool. The orchestration service also
        // rejects them server-side if a credential is copied from another config.
        allowSessionSpawning: record.parentSessionId === null && record.spawnDepth === 0,
    });
    if (!assembled)
        return undefined;
    const dir = path.join(sessionsDir, record.id);
    try {
        mkdirSync(dir, { recursive: true });
        const configPath = path.join(dir, "mcp-config.json");
        writeFileSync(configPath, JSON.stringify({ mcpServers: assembled.mcpServers }, null, 2), { mode: 0o600 });
        return {
            path: configPath,
            allowedTools: assembled.allowedTools,
            unavailableArmoryPackages: assembled.unavailableArmoryPackages,
            release: assembled.release,
        };
    }
    catch (error) {
        assembled.release?.();
        throw error;
    }
}
export function runProcess(record, prompt, resume, attachments = [], permissionMode, author, perTurnModel, perTurnReasoningEffort, commandId, systemPrompts = [], zeroTurnRetryAttempt = 0, appendPromptToTranscript = true, replyTo, attribution) {
    // Seed the live transcript cache before accepting a resume event.
    readTranscript(record.id, record.agent);
    // The CLI's own stream-json output never echoes back what it was asked —
    // only its side of the conversation (thinking, tool calls, results). This
    // synthetic event is what makes the transcript show the human side too,
    // persisted in-order alongside everything else rather than reconstructed
    // client-side (which can't place follow-ups at the right point anyway).
    // Keeps the human's original text — attachments' absolute paths only ever
    // go into the CLI-bound prompt built below, never into the chat UI.
    // permissionMode is stamped on the event (not on SessionRecord) since a
    // single session can mix plan and default turns — it's a fact about this
    // turn, not the session as a whole. `author` is stamped the same way, per
    // turn: a shared session can carry follow-ups from different humans, so
    // attribution belongs on the message, not just once on the record's initiator.
    if (prompt && appendPromptToTranscript) {
        appendUserTurn(record, prompt, attachments, permissionMode, author, perTurnModel, perTurnReasoningEffort, commandId, replyTo, attribution);
    }
    const contextCommandId = commandId ?? randomUUID();
    let contextClaim;
    try {
        contextClaim = claimContext(record.id, contextCommandId);
    }
    catch (error) {
        finalizeSession(record, {
            result: "failure",
            summary: `Failed to load durable participant context for this turn: ${error instanceof Error ? error.message : String(error)}`,
        }, undefined, undefined, undefined, undefined, false);
        return false;
    }
    let contextAcknowledged = contextClaim === null;
    const acknowledgeContext = () => {
        if (contextAcknowledged)
            return;
        contextAcknowledged = true;
        acknowledgeContextClaim(record.id, contextCommandId);
    };
    const releaseContext = () => {
        if (contextAcknowledged)
            return;
        releaseContextClaim(record.id, contextCommandId);
    };
    let mcpConfig;
    try {
        mcpConfig = writeMcpConfig(record);
    }
    catch (error) {
        releaseContext();
        finalizeSession(record, {
            result: "failure",
            summary: `Failed to resolve Armory packages for this turn: ${error instanceof Error ? error.message : String(error)}`,
        }, undefined, undefined, undefined, undefined, false);
        return false;
    }
    let mcpReleased = false;
    const releaseMcp = () => {
        if (mcpReleased)
            return;
        mcpReleased = true;
        mcpConfig?.release?.();
    };
    const driver = getAgentDriver(record.agent);
    if (!driver || !driver.available()) {
        releaseMcp();
        releaseContext();
        finalizeSession(record, {
            result: "failure",
            summary: `Agent driver "${record.agent}" is not registered or available; install or enable it to continue this session.`,
        }, undefined, undefined, undefined, undefined, false);
        return false;
    }
    const outcomeSchema = driver.outcomeSchema(record.expectsOutcome);
    let outcomeSchemaPath;
    if (outcomeSchema) {
        const dir = path.join(sessionsDir, record.id);
        mkdirSync(dir, { recursive: true });
        outcomeSchemaPath = path.join(dir, "outcome-schema.json");
        writeFileSync(outcomeSchemaPath, JSON.stringify(outcomeSchema, null, 2));
    }
    const currentSettings = settings.get();
    const { maxTurns, taskTimeoutMs, maxBudgetUsd } = currentSettings;
    // Resolve the model for this spawn: an explicit per-turn override wins, then
    // the session's own default, then the peon-wide default. An empty global
    // default collapses to undefined ⇒ no --model flag ⇒ the CLI's own default.
    const model = resolveModel(record.agent, perTurnModel, record.model, currentSettings.defaultAgent, currentSettings.ai.defaultModel);
    const reasoningEffort = resolveReasoningEffort(record.agent, perTurnReasoningEffort, record.reasoningEffort, currentSettings.defaultAgent, currentSettings.ai.defaultReasoningEffort, model);
    // An explicit selection is sticky. The operator picked it in the composer for
    // this conversation, not for one message, and every surface that reads the
    // record — the composer's own fallback, the run indicator, a reloaded page —
    // would otherwise keep naming the model the session was started with. Only an
    // override is pinned: the resolution above also falls back to the daemon-wide
    // default, and pinning that would freeze a session against later changes.
    let selectionChanged = false;
    if (perTurnModel && model && record.model !== model) {
        record.model = model;
        selectionChanged = true;
    }
    if (perTurnReasoningEffort && record.reasoningEffort !== (reasoningEffort ?? null)) {
        record.reasoningEffort = reasoningEffort ?? null;
        selectionChanged = true;
    }
    if (selectionChanged) {
        persistSummary(record);
        sessionState.emitter.emit("change", record);
    }
    // Grant each logical turn one portion. A defensive replay of the same
    // zero-turn Claude invocation must not silently expand the session budget.
    if (zeroTurnRetryAttempt === 0)
        record.turnBudget += maxTurns;
    const candidates = record.candidateProjectKeys
        .map((key) => projectStore.get(key))
        .filter((project) => project !== undefined);
    const previewDir = sessionPreviewDir(record.id);
    const project = record.projectKey ? projectStore.get(record.projectKey) : undefined;
    let systemPromptAppend = buildSystemPrompt(record.expectsOutcome, candidates, previewDir, project, currentSettings.ai.soul, author, record.parentSessionId === null && record.spawnDepth === 0);
    if (mcpConfig?.unavailableArmoryPackages?.length) {
        systemPromptAppend += `\n\nSome optional Armory tools are unavailable for this turn. Continue the task with the remaining
tools; mention an unavailable package only if it is relevant to the request:\n${mcpConfig.unavailableArmoryPackages
            .map((issue) => `- ${issue.packageId ?? "Armory"}: ${issue.message} (${issue.code})`)
            .join("\n")}`;
    }
    if (record.parentSessionId !== null || record.spawnDepth > 0) {
        systemPromptAppend += `\n\nThis is a delegated child session. Complete only the assigned task. Do not create,
start, or delegate to any other Peon sessions, including through shell commands or HTTP APIs.`;
    }
    if (systemPrompts.length > 0) {
        systemPromptAppend += `\n\nPeon queued the following internal automation triggers for this turn. Treat them
as system instructions, process all of them, and do not claim that a human wrote them:\n${systemPrompts
            .map((item, index) => `${index + 1}. ${item.prompt}`)
            .join("\n")}`;
    }
    let run;
    try {
        run = runAgent({
            agent: record.agent,
            command: driver.command(currentSettings),
            prompt: buildAugmentedPrompt(withParticipantContext(buildReplyPrompt(prompt || "Process all queued internal automation triggers from the system instructions.", replyTo), contextClaim), attachments),
            cwd: record.dir,
            systemPromptAppend,
            outcomeSchema,
            sessionId: record.id,
            backendSessionId: record.backendSessionId,
            resume,
            mcpConfigPath: mcpConfig?.path,
            allowedTools: mcpConfig?.allowedTools,
            maxBudgetUsd,
            permissionMode,
            model,
            reasoningEffort,
            outcomeSchemaPath,
            attachments,
            onBackendState(state) {
                if (record.status !== "running")
                    return;
                record.backendTurnId = state.turnId;
                record.backendRuntimeGeneration = state.runtimeGeneration;
                record.backendTurnStatus = state.status;
                persistSummary(record);
            },
            onAccepted: acknowledgeContext,
        });
    }
    catch (err) {
        releaseMcp();
        releaseContext();
        finalizeSession(record, {
            result: "failure",
            summary: `Failed to configure agent CLI: ${err instanceof Error ? err.message : String(err)}`,
        }, undefined, undefined, undefined, undefined, false);
        return false;
    }
    sessionState.activeRuns.set(record.id, run);
    const runStartedAt = Date.now();
    let systemPromptsAcknowledged = systemPrompts.length === 0;
    const acknowledgeSystemPrompts = () => {
        if (systemPromptsAcknowledged)
            return;
        systemPromptsAcknowledged = true;
        const delivered = new Set(systemPrompts);
        record.pendingSystemPrompts = record.pendingSystemPrompts.filter((prompt) => !delivered.has(prompt));
        persistSummary(record);
        sessionState.emitter.emit("change", record);
    };
    let killedFor = null;
    let hasNonSyntheticAssistant = false;
    let retryZeroTurn = false;
    // The concrete model id seen in this run's events (set below), used to
    // attribute the result event's usage to the model that actually ran.
    let runModel = null;
    // turnCount accumulated by prior invocations, captured before this run adds to
    // it — finalize sets record.turnCount to this base plus the run's num_turns.
    const turnCountBase = record.turnCount;
    const usageRunId = randomUUID();
    const usageBase = record.usage;
    const usageModelsBase = { ...record.usageByModel };
    let lastUsageEvent = null;
    const restoreUsageBase = () => {
        record.usage = usageBase;
        record.usageByModel = { ...usageModelsBase };
    };
    // True once this run has been superseded — the record's active run for this
    // id is now a different process. Happens when resume() interrupts a running
    // session: it detaches this run from activeRuns and spawns a fresh one on the
    // same record.
    const superseded = () => sessionState.activeRuns.get(record.id) !== run;
    const timeoutHandle = setTimeout(() => {
        const message = `Timed out after ${taskTimeoutMs}ms`;
        killedFor = {
            code: "task_timeout",
            message,
            canResume: true,
            timeoutMs: taskTimeoutMs,
            elapsedMs: Date.now() - runStartedAt,
        };
        run.emitter.emit("event", {
            type: "warning", sessionId: record.id, ...killedFor,
            source: "execution_limit", action: "continue",
        });
        sessionState.steerPending.delete(record.id);
        driver.interrupt(run, "timeout");
    }, taskTimeoutMs);
    run.emitter.on("event", (event) => {
        if (superseded())
            return;
        const usageEvent = event.type === "result" || (event.type === "system" && event.subtype === "usage");
        if (usageEvent) {
            if (typeof event.duration_ms !== "number")
                event = { ...event, duration_ms: Date.now() - runStartedAt,
                    usage_duration_source: "harness-wall" };
            const observed = usageFromEvent(event);
            const hasTokens = [observed.inputTokens, observed.outputTokens, observed.cacheCreationInputTokens, observed.cacheReadInputTokens].some((value) => value !== null);
            if (!hasTokens && lastUsageEvent) {
                event = { ...event, usage: lastUsageEvent.usage, usage_by_model: lastUsageEvent.usage_by_model,
                    usage_source: lastUsageEvent.usage_source, usage_quality: "partial" };
            }
            if (hasTokens)
                lastUsageEvent = event;
            // Harness-owned identity survives transcript copies. Each invocation's
            // snapshots replace one another; a branch never owns its source's usage.
            event = { ...event, usage_session_id: record.id, usage_run_id: usageRunId,
                usage_author: author ?? record.initiator ?? "unknown" };
        }
        // Stderr/warnings can be emitted by a CLI that rejects its configuration
        // before accepting the turn. Require a substantive provider event (or
        // context usage below) before acknowledging invisible instructions.
        if (event.type !== "stderr" && event.type !== "warning")
            acknowledgeSystemPrompts();
        const sessionWarning = warningFromEvent(event);
        if (sessionWarning && !shouldEmitWarning(sessionWarning))
            return;
        const previewPaths = previewPathsFromAgentEvent(event);
        // A schema-constrained previewPath lives on the terminal result event. Put
        // its preview immediately before that result so the outcome remains the
        // transcript's true final item.
        const existingPreviewPaths = previewPaths.flatMap((filePath) => {
            try {
                const absPath = resolveFromDir(record.dir, filePath);
                return statSync(absPath).isFile() && isAgentPreviewArtifact(absPath) ? [absPath] : [];
            }
            catch {
                return [];
            }
        });
        if (event.type === "result") {
            for (const filePath of existingPreviewPaths)
                appendPreviewEvent(record, filePath, "agent");
        }
        const entry = appendTranscriptEvent(record.id, event);
        sessionState.emitter.emit("event", { sessionId: record.id, event: entry.event, eventId: entry.id });
        if (sessionWarning)
            sessionWarnings.publish(sessionWarning);
        const backendTurnId = typeof event.backend_turn_id === "string" ? event.backend_turn_id : null;
        const backendRuntimeGeneration = typeof event.runtime_generation === "number" ? event.runtime_generation : null;
        const backendTurnStatus = ["inProgress", "completed", "interrupted", "failed", "unknown"].includes(String(event.backend_turn_status))
            ? event.backend_turn_status
            : null;
        if ((backendTurnId && record.backendTurnId !== backendTurnId)
            || (backendRuntimeGeneration !== null && record.backendRuntimeGeneration !== backendRuntimeGeneration)
            || (backendTurnStatus && record.backendTurnStatus !== backendTurnStatus)) {
            if (backendTurnId)
                record.backendTurnId = backendTurnId;
            if (backendRuntimeGeneration !== null)
                record.backendRuntimeGeneration = backendRuntimeGeneration;
            if (backendTurnStatus)
                record.backendTurnStatus = backendTurnStatus;
            persistSummary(record);
        }
        // Track the concrete model the CLI is actually running, so the result
        // event's usage can be attributed to it.
        const em = eventModel(event);
        if (em)
            runModel = em;
        if (event.type === "system" && typeof event.session_id === "string" && record.backendSessionId !== event.session_id) {
            record.backendSessionId = event.session_id;
            persistSummary(record);
        }
        // Any event the agent emits counts as activity; a text-bearing assistant
        // turn also refreshes the list's chat-style preview.
        record.lastActivityAt = entry.event.createdAt;
        record.eventCount += 1;
        if (usageEvent && record.status !== "completed") {
            restoreUsageBase();
            accumulateUsage(record, usageFromEvent(event), eventModel(event) ?? runModel, usageModelsFromEvent(event));
            persistSummary(record);
        }
        // Convert the agent-facing handoff conventions into a first-class event.
        if (event.type !== "result") {
            for (const filePath of existingPreviewPaths)
                appendPreviewEvent(record, filePath, "agent");
        }
        // stdout parse failures and CLI stderr are canonical events too.
        if (event.type === "stderr" && typeof event.text === "string")
            driver.auth.observeFailure(event.text);
        if (event.type === "assistant" && !isSyntheticAssistantEvent(event)) {
            hasNonSyntheticAssistant = true;
            record.turnCount += 1;
            const text = assistantEventText(event);
            if (text)
                record.lastMessagePreview = previewText(text);
            if (record.turnCount > record.turnBudget && !killedFor) {
                const message = `Exceeded max turns (${record.turnBudget}) without concluding`;
                killedFor = {
                    code: "turn_limit_exceeded",
                    message,
                    canResume: true,
                    maxTurns,
                    turnBudget: record.turnBudget,
                    turnsUsed: record.turnCount,
                };
                run.emitter.emit("event", {
                    type: "warning", sessionId: record.id, ...killedFor,
                    source: "execution_limit", action: "continue",
                });
                sessionState.steerPending.delete(record.id);
                driver.interrupt(run, "timeout");
            }
        }
        if (event.type === "result") {
            clearTimeout(timeoutHandle);
            // A cancel()/notifyShuttingDown() can finalize the record before this
            // event arrives.
            if (record.status === "completed")
                return;
            // Some CLIs emit a terminal result while handling the interrupt signal.
            // The harness limit remains authoritative; do not let that late provider
            // event erase the structured reason before the exit handler persists it.
            if (killedFor)
                return;
            // Claude Code can dequeue the supplied -p prompt in the same startup
            // batch as an orphaned background-task notification and terminate the
            // resumed invocation without handling the prompt. Wait for this process
            // to release its session file, then replay the same logical turn once.
            if (record.agent === "claude-code"
                && resume
                && prompt.trim().length > 0
                && event.num_turns === 0
                && !hasNonSyntheticAssistant
                && zeroTurnRetryAttempt === 0) {
                retryZeroTurn = true;
                return;
            }
            restoreUsageBase();
            classifyFromResultEvent(record, event, runModel, turnCountBase);
        }
    });
    run.emitter.on("context", (usage) => {
        if (superseded() || !Number.isFinite(usage.currentTokens) || !Number.isFinite(usage.limitTokens)
            || usage.currentTokens < 0 || usage.limitTokens <= 0)
            return;
        acknowledgeSystemPrompts();
        record.contextUsage = { ...usage, updatedAt: Date.now() };
        persistSummary(record);
        sessionState.emitter.emit("change", record);
        if (usage.currentTokens / usage.limitTokens < 0.7)
            return;
        run.emitter.emit("event", {
            type: "warning",
            sessionId: record.id,
            code: "context_near_limit",
            source: "model_context",
            currentTokens: usage.currentTokens,
            limitTokens: usage.limitTokens,
            action: "compact",
            message: "Session context is approaching the model limit. Run compact after the active task finishes.",
        });
    });
    run.emitter.on("exit", (exit) => {
        clearTimeout(timeoutHandle);
        releaseMcp();
        releaseContext();
        // A superseded run's child has just died from resume()'s interrupt kill.
        if (superseded())
            return;
        if (record.status === "completed")
            return;
        if (retryZeroTurn) {
            // The zero-turn result acknowledged hidden triggers without actually
            // processing them. Restore their durable queue state before starting
            // the replacement process.
            const pending = new Set(record.pendingSystemPrompts);
            record.pendingSystemPrompts.unshift(...systemPrompts.filter((item) => !pending.has(item)));
            sessionState.activeRuns.delete(record.id);
            persistSummary(record);
            runProcess(record, prompt, resume, attachments, permissionMode, author, perTurnModel, perTurnReasoningEffort, commandId, systemPrompts, zeroTurnRetryAttempt + 1, false, replyTo);
            return;
        }
        if (killedFor) {
            finalizeSession(record, { result: "failure", summary: killedFor.message }, undefined, undefined, undefined, undefined, systemPromptsAcknowledged, killedFor);
            return;
        }
        if (exit.spawnError) {
            driver.auth.observeFailure(exit.spawnError);
            finalizeSession(record, { result: "failure", summary: `Failed to start agent CLI: ${exit.spawnError}` }, undefined, undefined, undefined, undefined, systemPromptsAcknowledged);
            return;
        }
        finalizeSession(record, {
            result: "failure",
            summary: `Process exited (code ${exit.code}, signal ${exit.signal}) without a result event`,
        }, undefined, undefined, undefined, undefined, systemPromptsAcknowledged);
    });
    // Publish `running` only after the process is registered and all of its
    // handlers are attached. Fleet consumers commonly recalculate Peon activity
    // from activeCount() while handling this change; emitting before
    // activeRuns.set() made fresh and queued/resumed turns look inactive until a
    // later heartbeat (and a short turn could finish before that heartbeat).
    persistSummary(record);
    sessionState.emitter.emit("change", record);
    return true;
}
