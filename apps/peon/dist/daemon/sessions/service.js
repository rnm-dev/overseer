import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDriver, requireAgentDriver } from "../agents/index.js";
import { projectStore } from "../projects/index.js";
import { settings } from "../settings/index.js";
import { buildAugmentedPrompt } from "../sessionPrompts.js";
import { paginateSessions } from "../sessionPagination.js";
import { statsForPeriod as calculateStatsForPeriod } from "../sessionStats.js";
import { discardTranscript, flushTranscript, persistSummary, readTranscript, readTranscriptEntries, readTranscriptPage, sessionsDir, sessionsSizeBytes, summaryPath, } from "./sessionArtifacts.js";
import { AUTO_RESUME_PROMPT, MAX_AUTO_RESUME_ATTEMPTS, ORPHANED_RUN_MARKER, RESTART_INTERRUPTION_MARKER, SYSTEM_AUTHOR, } from "./constants.js";
import { sessionPreviewDir } from "./preview.js";
import { appendPreviewEvent, appendUserTurn, finalizeSession as finalize, runProcess, scheduleQueuedDispatch, } from "./runtime.js";
import { inferProjectKey, isRestartInterrupted, restoreFromDisk, } from "./recovery.js";
import { sessionState } from "./state.js";
export { attachmentsDir } from "./sessionArtifacts.js";
export { AUTO_RESUME_PROMPT, MAX_AUTO_RESUME_ATTEMPTS, ORPHANED_RUN_MARKER, RESTART_INTERRUPTION_MARKER, SYSTEM_AUTHOR, };
function reconcileOrphanedRun(record) {
    if (record.status !== "running"
        || sessionState.activeRuns.has(record.id)
        || sessionState.resumePending.has(record.id)
        || sessionState.steerPending.has(record.id)) {
        return record;
    }
    finalize(record, {
        result: "failure",
        summary: `Session ${ORPHANED_RUN_MARKER}; no live or pending run was found.`,
    }, undefined, undefined, undefined, undefined, false);
    return record;
}
function startQueuedDispatchNow(record) {
    if (record.status === "completed") {
        scheduleQueuedDispatch(record);
        return;
    }
    if (sessionState.resumePending.has(record.id))
        return;
    const run = sessionState.activeRuns.get(record.id);
    if (!run)
        return;
    // Wait for the current provider process to release its conversation state
    // before dispatching the (possibly reordered) queue head.
    sessionState.resumePending.add(record.id);
    sessionState.steerPending.delete(record.id);
    sessionState.activeRuns.delete(record.id);
    run.emitter.once("exit", () => {
        sessionState.resumePending.delete(record.id);
        finalize(record, { result: "failure", summary: "Stopped by user to process the follow-up queue." });
    });
    requireAgentDriver(record.agent).interrupt(run, "superseded");
}
export const sessions = {
    start(opts) {
        // No implicit worktree-off-the-ACA-repo fallback — that's this daemon's
        // own source, not a target for arbitrary sessions to run in (and it has
        // no commits yet, so `git worktree add ... HEAD` would fail regardless).
        // Default to the user's home dir instead — always exists, touches no git
        // state, and is a sane place for an unscoped ad-hoc session to land.
        const dir = opts.dir || os.homedir();
        if (!existsSync(dir)) {
            throw new Error(`dir does not exist: ${dir}`);
        }
        const resolvedProjectKey = opts.projectKey ?? inferProjectKey(dir);
        const projectId = resolvedProjectKey ? projectStore.get(resolvedProjectKey)?.projectId ?? null : null;
        const candidateProjectKeys = resolvedProjectKey ? [] : projectStore.list().map((p) => p.key);
        const id = opts.id ?? randomUUID();
        // Resolve once at creation: a session cannot switch backend later because
        // its provider-owned conversation state is tied to that backend.
        const agent = opts.agent ?? settings.get().defaultAgent;
        const record = {
            // Caller-supplied ids let external task systems link their own durable
            // records to the session before the process spawns.
            id,
            prompt: opts.prompt,
            title: opts.title?.trim() || null,
            followUpPrompts: [],
            queuedFollowUps: [],
            pendingSystemPrompts: [],
            dir,
            agent,
            backendSessionId: requireAgentDriver(agent).conversation.initialBackendId(id),
            backendTurnId: null,
            backendRuntimeGeneration: null,
            backendTurnStatus: null,
            model: opts.model ?? null,
            reasoningEffort: opts.reasoningEffort ?? null,
            projectId,
            projectKey: resolvedProjectKey,
            candidateProjectKeys,
            taskKey: opts.taskKey ?? null,
            taskTitle: opts.taskTitle ?? null,
            initiator: opts.author ?? null,
            parentSessionId: opts.parentSessionId ?? null,
            spawnDepth: opts.spawnDepth ?? 0,
            spawnRequestId: opts.spawnRequestId ?? null,
            parentCompletionNotifiedAt: null,
            parentCompletionNotificationPending: Boolean(opts.parentSessionId),
            expectsOutcome: opts.expectsOutcome ?? false,
            status: "running",
            outcome: null,
            startedAt: Date.now(),
            endedAt: null,
            turnCount: 0,
            // runProcess() bumps this by the live maxTurns on the spawn below, so it
            // starts at zero here rather than being pre-seeded with a portion.
            turnBudget: 0,
            usage: null,
            usageByModel: {},
            contextUsage: null,
            autoResumeAttempts: 0,
            // Seed both timestamps to now; runProcess() below immediately refreshes
            // them (and the preview) off the initial user_message.
            lastActivityAt: Date.now(),
            lastUserMessageAt: Date.now(),
            lastMessagePreview: null,
            eventCount: 0,
        };
        sessionState.records.set(record);
        runProcess(record, opts.prompt, false, opts.attachments ?? [], opts.permissionMode, opts.author, undefined, undefined, opts.commandId);
        return record;
    },
    // "Is any session running at all" — sessions themselves run concurrently, so
    // this no longer means "can't start another". It still gates the two paths
    // that deliberately stay one-at-a-time: the autonomous task processor and the
    // update/restart flow (a daemon restart kills every in-flight run).
    isBusy() {
        return sessions.activeCount() > 0;
    },
    // How many agent processes are live right now, including a superseded process
    // that is still tearing down before its replacement can safely resume the
    // same provider conversation. activeRuns and resumePending are disjoint at
    // observable boundaries, so the sum keeps fleet activity truthful throughout
    // send-now handoffs instead of briefly reporting an idle Peon.
    activeCount() {
        for (const record of sessionState.records.values())
            reconcileOrphanedRun(record);
        return sessionState.activeRuns.size() + sessionState.resumePending.size();
    },
    // Continues a session's actual conversation via --resume — the agent keeps
    // whatever context it had, and produces a fresh outcome that may differ from
    // its previous one. Works on a completed session (the normal follow-up) and,
    // now, on a *running* one: the in-flight run is interrupted and the new
    // message resumes the conversation the instant that process dies. That
    // "insta-resume" is what a queued message does when the human wants to
    // redirect the agent now rather than wait for the current turn to finish.
    resume(id, prompt, attachments = [], permissionMode, author, 
    // One-shot model override for this follow-up turn; omitted ⇒ session/global
    // default. Does not change record.model.
    model, reasoningEffort, commandId, notifyParentOnComplete = false) {
        const record = sessionState.records.get(id);
        if (!record) {
            throw new Error("unknown session");
        }
        // The actual (re)spawn, shared by both paths. Kept as a closure so the
        // interrupt path can defer it until the old child has fully exited — the
        // CLI's own session file must be released before a fresh `--resume`
        // reopens it, and the record must not flip through a spurious "completed".
        const spawnResume = () => {
            record.followUpPrompts.push(prompt);
            record.parentCompletionNotificationPending = notifyParentOnComplete;
            record.status = "running";
            record.outcome = null;
            record.endedAt = null;
            runProcess(record, prompt, true, attachments, permissionMode, author, model, reasoningEffort, commandId);
        };
        if (record.status === "running") {
            // A previous interrupt is still tearing down its old process; spawning now
            // would race the pending resume onto the same session file. The caller
            // the calling client surfaces this as a retryable error.
            if (sessionState.resumePending.has(id) || sessionState.steerPending.has(id)) {
                throw new Error("a resume is already in progress");
            }
            const run = sessionState.activeRuns.get(id);
            if (run) {
                const driver = requireAgentDriver(record.agent);
                let steerSettled = false;
                const steerAccepted = () => {
                    if (steerSettled || !sessionState.steerPending.has(id))
                        return;
                    steerSettled = true;
                    sessionState.steerPending.delete(id);
                    // An acknowledgement means Codex accepted this message into the
                    // native turn. Record it exactly once even if a terminal notification
                    // was processed first (both protocol lines may arrive in one stdout
                    // chunk). Cancellation, timeout and ownership replacement clear the
                    // pending fence, so those late acknowledgements are ignored above.
                    record.followUpPrompts.push(prompt);
                    record.parentCompletionNotificationPending = notifyParentOnComplete;
                    appendUserTurn(record, prompt, attachments, permissionMode, author, model, reasoningEffort, commandId);
                    persistSummary(record);
                    sessionState.emitter.emit("change", record);
                };
                const steerRejected = (_error) => {
                    if (steerSettled || !sessionState.steerPending.has(id))
                        return;
                    steerSettled = true;
                    sessionState.steerPending.delete(id);
                    if (sessionState.activeRuns.get(id) !== run || record.status !== "running") {
                        spawnResume();
                        return;
                    }
                    sessionState.resumePending.add(id);
                    sessionState.activeRuns.delete(id);
                    run.emitter.once("exit", () => {
                        sessionState.resumePending.delete(id);
                        spawnResume();
                    });
                    driver.interrupt(run, "superseded");
                };
                sessionState.steerPending.add(id);
                if (driver.steer?.(run, {
                    prompt: buildAugmentedPrompt(prompt, attachments),
                    attachments,
                    permissionMode,
                    author,
                    model,
                    reasoningEffort,
                    commandId,
                }, { accepted: steerAccepted, rejected: steerRejected })) {
                    return record;
                }
                sessionState.steerPending.delete(id);
                // Interrupt-and-resume. Detaching the run from activeRuns first is what
                // silences its now-stale handlers (see `superseded` in runProcess), so
                // its imminent SIGTERM exit can't finalize the record we're about to
                // hand to the replacement. Status stays "running" the whole time — the
                // UI sees one continuous run, not a stop-then-start flicker.
                sessionState.resumePending.add(id);
                sessionState.activeRuns.delete(id);
                run.emitter.once("exit", () => {
                    sessionState.resumePending.delete(id);
                    spawnResume();
                });
                driver.interrupt(run, "superseded");
                return record;
            }
            // "running" with no active run shouldn't happen, but if it does the
            // resume below is the safe recovery rather than throwing.
        }
        spawnResume();
        return record;
    },
    enqueue(id, prompt, attachments = [], permissionMode, author, model, reasoningEffort, commandId, startNow = false) {
        const record = sessionState.records.get(id);
        if (!record)
            throw new Error("unknown session");
        const item = {
            id: randomUUID(), sessionId: id, prompt, attachments,
            permissionMode: permissionMode ?? null,
            author: author ?? null,
            model: model ?? null,
            reasoningEffort: reasoningEffort ?? null,
            commandId: commandId ?? null,
            queuedAt: Date.now(),
        };
        record.queuedFollowUps.push(item);
        persistSummary(record);
        sessionState.emitter.emit("change", record);
        if (record.status === "completed") {
            scheduleQueuedDispatch(record);
        }
        else if (startNow) {
            startQueuedDispatchNow(record);
        }
        return record;
    },
    enqueueSystem(id, prompt, commandId) {
        const record = sessionState.records.get(id);
        if (!record)
            throw new Error("unknown session");
        const trimmed = prompt.trim();
        if (!trimmed)
            throw new Error("system prompt is required");
        if (commandId && record.pendingSystemPrompts.some((item) => item.commandId === commandId)) {
            return record;
        }
        record.pendingSystemPrompts.push({
            prompt: trimmed,
            commandId: commandId ?? null,
            queuedAt: Date.now(),
        });
        persistSummary(record);
        sessionState.emitter.emit("change", record);
        if (record.status === "completed")
            scheduleQueuedDispatch(record);
        return record;
    },
    markParentCompletionNotified(id, completedAt) {
        const record = sessionState.records.get(id);
        if (!record)
            throw new Error("unknown session");
        if (record.parentCompletionNotifiedAt !== completedAt || record.parentCompletionNotificationPending) {
            record.parentCompletionNotifiedAt = completedAt;
            record.parentCompletionNotificationPending = false;
            persistSummary(record);
            sessionState.emitter.emit("change", record);
        }
        return record;
    },
    queued(id) {
        return sessionState.records.get(id)?.queuedFollowUps.slice();
    },
    removeQueued(id, itemId) {
        const record = sessionState.records.get(id);
        if (!record)
            return "unknown_session";
        const index = record.queuedFollowUps.findIndex((item) => item.id === itemId);
        if (index < 0)
            return "not_found";
        record.queuedFollowUps.splice(index, 1);
        persistSummary(record);
        sessionState.emitter.emit("change", record);
        return "removed";
    },
    editQueued(id, itemId, prompt) {
        const record = sessionState.records.get(id);
        if (!record)
            return "unknown_session";
        const item = record.queuedFollowUps.find((queued) => queued.id === itemId);
        if (!item)
            return "not_found";
        item.prompt = prompt;
        persistSummary(record);
        sessionState.emitter.emit("change", record);
        return record;
    },
    sendQueuedNow(id, itemId) {
        const record = sessionState.records.get(id);
        if (!record)
            return "unknown_session";
        const index = record.queuedFollowUps.findIndex((item) => item.id === itemId);
        if (index < 0)
            return "not_found";
        if (index > 0) {
            const [item] = record.queuedFollowUps.splice(index, 1);
            record.queuedFollowUps.unshift(item);
        }
        // Persist the new queue head before interrupting. If the daemon exits or
        // the provider teardown races, restart recovery still dispatches the item
        // the operator selected while preserving every other item's order.
        persistSummary(record);
        sessionState.emitter.emit("change", record);
        startQueuedDispatchNow(record);
        return "sent";
    },
    // Sets (or, with null/empty, clears) a session's human-given display name.
    // Safe on a running session — it's cosmetic and doesn't touch the run — and
    // persists + broadcasts like any other record change so an open detail view
    // and the list both pick it up. Returns undefined for an unknown id so the
    // route can 404.
    rename(id, title) {
        const record = sessionState.records.get(id);
        if (!record)
            return undefined;
        const trimmed = title?.trim();
        record.title = trimmed ? trimmed : null;
        persistSummary(record);
        sessionState.emitter.emit("change", record);
        return record;
    },
    preview(id, filePath, author) {
        const record = sessionState.records.get(id);
        if (!record)
            return undefined;
        return appendPreviewEvent(record, filePath, author) ?? undefined;
    },
    get(id) {
        const record = sessionState.records.get(id);
        return record ? reconcileOrphanedRun(record) : undefined;
    },
    list() {
        return Array.from(sessionState.records.values(), reconcileOrphanedRun).sort((a, b) => b.startedAt - a.startedAt);
    },
    page(options) {
        for (const record of sessionState.records.values())
            reconcileOrphanedRun(record);
        return paginateSessions(sessionState.records.values(), options);
    },
    // Keep project attribution intact when an operator changes a project's local
    // key. This includes candidate keys captured by older unbound sessions, so a
    // rename cannot resurrect the old key in project rollups after a restart.
    renameProjectKey(oldKey, newKey) {
        let changed = 0;
        for (const record of sessionState.records.values()) {
            const projectChanged = record.projectKey === oldKey;
            const candidatesChanged = record.candidateProjectKeys.includes(oldKey);
            if (!projectChanged && !candidatesChanged)
                continue;
            if (projectChanged)
                record.projectKey = newKey;
            if (candidatesChanged) {
                record.candidateProjectKeys = [...new Set(record.candidateProjectKeys.map((key) => key === oldKey ? newKey : key))];
            }
            persistSummary(record);
            sessionState.emitter.emit("change", record);
            changed += 1;
        }
        return changed;
    },
    statsForPeriod(period) {
        return calculateStatsForPeriod(sessionState.records.values(), period, sessionsSizeBytes());
    },
    getTranscript(id) {
        const agent = sessionState.records.get(id)?.agent ?? "claude-code";
        return readTranscript(id, agent);
    },
    getTranscriptEntries(id) {
        const agent = sessionState.records.get(id)?.agent ?? "claude-code";
        return readTranscriptEntries(id, agent);
    },
    getTranscriptPage(id, options) {
        const agent = sessionState.records.get(id)?.agent ?? "claude-code";
        return readTranscriptPage(id, agent, options);
    },
    cancel(id) {
        const storedRecord = sessionState.records.get(id);
        const wasOrphaned = storedRecord?.status === "running"
            && !sessionState.activeRuns.has(id)
            && !sessionState.resumePending.has(id)
            && !sessionState.steerPending.has(id);
        if (wasOrphaned) {
            reconcileOrphanedRun(storedRecord);
            return true;
        }
        // Capture before finalize() — it deletes the run from activeRuns, so
        // looking it up again afterward would miss and the process would never
        // actually get killed.
        const run = sessionState.activeRuns.get(id);
        if (!run)
            return false;
        // Fence an in-flight turn/steer acknowledgement before finalizing or
        // handing the session to its queued follow-up. A late acknowledgement
        // must never append a cancelled message or resurrect the session.
        sessionState.steerPending.delete(id);
        const record = storedRecord;
        if (record && (record.queuedFollowUps.length > 0 || record.pendingSystemPrompts.length > 0)) {
            // Stopping a run with user follow-ups or hidden system triggers waiting
            // completes the current turn and advances the pending work. Wait for the
            // provider process to exit so its persisted conversation state is no
            // longer being written by the old process.
            sessionState.resumePending.add(id);
            sessionState.activeRuns.delete(id);
            run.emitter.once("exit", () => {
                sessionState.resumePending.delete(id);
                finalize(record, { result: "failure", summary: "Cancelled by user to process the follow-up queue." });
            });
            requireAgentDriver(record.agent).interrupt(run, "cancel");
            return true;
        }
        if (record)
            finalize(record, { result: "failure", summary: "Cancelled by user." }, undefined, undefined, undefined, undefined, false);
        if (record)
            requireAgentDriver(record.agent).interrupt(run, "cancel");
        return true;
    },
    // Permanently remove a session — its in-memory record and every on-disk
    // artifact (summary, transcript, and the per-session dir holding mcp-config /
    // attachments). Refuses a *running* session ("running") so a live agent
    // process is never orphaned from its record — cancel it first. Returns
    // "not_found" for an unknown id, "deleted" on success.
    delete(id) {
        const record = sessionState.records.get(id);
        if (!record)
            return "not_found";
        if (sessionState.activeRuns.has(id))
            return "running";
        sessionState.records.delete(id);
        // Best-effort file cleanup — the record is already gone from memory, so a
        // stray file can't resurrect it; rmSync with force never throws on a missing
        // path.
        rmSync(summaryPath(id), { force: true });
        void discardTranscript(id);
        rmSync(path.join(sessionsDir, id), { recursive: true, force: true });
        rmSync(sessionPreviewDir(id), { recursive: true, force: true });
        sessionState.emitter.emit("delete", id);
        return "deleted";
    },
    // Called from the daemon's SIGTERM handler. systemd's default KillMode
    // (control-group) sends SIGTERM to the whole cgroup, so a spawned agent
    // process dies right along with the daemon on every restart — no code
    // here can prevent that. This just makes sure the session's own record
    // says so honestly instead of the generic "exited without a result event"
    // (confirmed live: a real in-progress clone got killed by a restart done
    // for an unrelated code change, and reported that misleading message).
    notifyShuttingDown() {
        // Every in-flight run dies with the daemon, not just one — snapshot the ids
        // first since finalize() mutates activeRuns as we go.
        for (const [id, run] of [...sessionState.activeRuns.entries()]) {
            const record = sessionState.records.get(id);
            if (!record)
                continue;
            sessionState.steerPending.delete(id);
            getAgentDriver(record.agent)?.shutdown(run);
            finalize(record, {
                result: "failure",
                summary: `Daemon was ${RESTART_INTERRUPTION_MARKER} — not an agent failure, the process was killed as part of the restart. Re-run it.`,
            }, undefined, undefined, undefined, undefined, false);
        }
    },
    flushTranscripts() {
        return flushTranscript();
    },
    restoreFromDisk() {
        restoreFromDisk();
    },
    // Auto-recovers eligible ad-hoc sessions that a daemon restart killed mid-run. Called
    // once at startup, right after restoreFromDisk() has reconciled every record
    // (so the orphans it targets are already status:"completed" + a restart
    // summary).
    // Scope is deliberately narrow:
    //   - !expectsOutcome: only genuine ad-hoc chats. Graded workflows are
    //     left to their caller to re-drive.
    // A persisted per-session cap (autoResumeAttempts) keeps an orphan that gets
    // interrupted again before it can finish from being resumed forever across
    // successive restarts.
    async resumeInterrupted() {
        const autoResume = settings.get().autoResumeInterrupted;
        // Snapshot first: resume() re-runs the record but never adds a key, so
        // iterating records directly is safe — a copy just keeps intent obvious.
        for (const record of [...sessionState.records.values()]) {
            if (!isRestartInterrupted(record))
                continue;
            const driver = getAgentDriver(record.agent);
            if (driver?.reconcile) {
                try {
                    const reconciled = await driver.reconcile({
                        command: driver.command(settings.get()),
                        backendSessionId: record.backendSessionId,
                        backendTurnId: record.backendTurnId,
                        runtimeGeneration: record.backendRuntimeGeneration,
                    });
                    record.backendTurnId = reconciled.backendTurnId;
                    record.backendRuntimeGeneration = reconciled.runtimeGeneration;
                    record.backendTurnStatus = reconciled.status;
                    if (reconciled.status === "completed") {
                        record.outcome = { result: "failure", summary: "Codex turn completed during daemon restart; committed transcript was preserved and the turn was not replayed automatically." };
                        persistSummary(record);
                        continue;
                    }
                    if (reconciled.status === "failed" || reconciled.status === "unknown") {
                        record.outcome = {
                            result: "failure",
                            summary: reconciled.status === "failed"
                                ? "Codex reported that the interrupted native turn failed; it was not replayed automatically."
                                : `Could not safely reconcile the Codex native turn${reconciled.detail ? `: ${reconciled.detail}` : "."}`,
                        };
                        persistSummary(record);
                        continue;
                    }
                    persistSummary(record);
                }
                catch (error) {
                    record.backendTurnStatus = "unknown";
                    record.outcome = { result: "failure", summary: `Could not safely reconcile the Codex native turn: ${error instanceof Error ? error.message : String(error)}` };
                    persistSummary(record);
                    continue;
                }
            }
            // Reconciliation applies to every native session. Automatic continuation
            // remains deliberately narrower: only ad-hoc chats, and only when the
            // operator has enabled it.
            if (record.expectsOutcome || !autoResume)
                continue;
            if (record.autoResumeAttempts >= MAX_AUTO_RESUME_ATTEMPTS) {
                console.log(`sessions: not auto-resuming ${record.id} — already retried ${record.autoResumeAttempts}x, leaving for a human`);
                continue;
            }
            // Persist the bump before spawning so the cap holds even if this very
            // resume is itself interrupted before it can re-persist on completion.
            record.autoResumeAttempts += 1;
            persistSummary(record);
            try {
                this.resume(record.id, AUTO_RESUME_PROMPT, [], undefined, SYSTEM_AUTHOR);
                console.log(`sessions: auto-resumed interrupted ad-hoc session ${record.id} (attempt ${record.autoResumeAttempts})`);
            }
            catch (err) {
                console.error(`sessions: failed to auto-resume ${record.id}:`, err);
            }
        }
    },
    resumeQueued() {
        for (const record of sessionState.records.values()) {
            if (record.status !== "completed"
                || record.backendTurnStatus === "unknown"
                || record.backendTurnStatus === "inProgress"
                || (isRestartInterrupted(record) && record.pendingSystemPrompts.length === 0))
                continue;
            scheduleQueuedDispatch(record);
        }
    },
    on: sessionState.emitter.on,
    off: sessionState.emitter.off,
};
