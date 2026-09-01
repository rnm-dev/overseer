import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDriver, requireAgentDriver } from "../agents/index.js";
import { projectStore } from "../projects/index.js";
import { settings } from "../settings/index.js";
import { type CodingAgent, type ReasoningEffort } from "../providers/modelCatalog.js";
import type { AgentEvent } from "../agents/index.js";
import { buildAugmentedPrompt } from "./sessionPrompts.js";
import { paginateSessions } from "./sessionPagination.js";
import { statsForPeriod as calculateStatsForPeriod } from "./sessionStats.js";
import type {
  AttachmentInfo,
  PendingSystemPrompt,
  QueuedFollowUp,
  SessionOutcome,
  SessionRecord,
  SessionStats,
  SessionStatus,
  SessionUsage,
  StatsPeriod,
  ReplyTo,
} from "./sessionTypes.js";
import {
  attachmentsDir,
  appendTranscriptEvent,
  discardTranscript,
  flushTranscript,
  persistSummary,
  previewText,
  readTranscript,
  readTranscriptEntries,
  readTranscriptPage,
  sessionsDir,
  sessionsSizeBytes,
  summaryPath,
} from "./sessionArtifacts.js";
import {
  AUTO_RESUME_PROMPT,
  MAX_AUTO_RESUME_ATTEMPTS,
  ORPHANED_RUN_MARKER,
  RESTART_INTERRUPTION_MARKER,
  SYSTEM_AUTHOR,
} from "./constants.js";
import { sessionPreviewDir } from "./preview.js";
import {
  appendPreviewEvent,
  appendUserTurn,
  finalizeSession as finalize,
  runProcess,
  scheduleQueuedDispatch,
} from "./runtime.js";
import {
  inferProjectKey,
  isRestartInterrupted,
  restoreFromDisk,
} from "./recovery.js";
import { sessionState } from "./state.js";
import type {
  SessionCatalogReader,
  SessionLifecycleContract,
  SessionQueueContract,
  SessionTranscriptEventContract,
} from "./contracts.js";
import { ReplyToError, buildReplyPrompt, isReplyableEvent } from "./replyTo.js";
import { appendContextMessage as appendParticipantContext, initializeBranchedContext, replayContextMessage, type ContextMention, type MessageAttribution } from "./contextMessages.js";

export { attachmentsDir } from "./sessionArtifacts.js";

const pendingSessionBranches = new Map<string, Promise<SessionRecord>>();

export type {
  AttachmentInfo,
  QueuedFollowUp,
  PendingSystemPrompt,
  SessionOutcome,
  SessionRecord,
  SessionStats,
  SessionStatus,
  SessionUsage,
  ReplyTo,
  StatsPeriod,
} from "./sessionTypes.js";

export {
  AUTO_RESUME_PROMPT,
  MAX_AUTO_RESUME_ATTEMPTS,
  ORPHANED_RUN_MARKER,
  RESTART_INTERRUPTION_MARKER,
  SYSTEM_AUTHOR,
};

function reconcileOrphanedRun(record: SessionRecord): SessionRecord {
  if (
    record.status !== "running"
    || sessionState.activeRuns.has(record.id)
    || sessionState.resumePending.has(record.id)
    || sessionState.steerPending.has(record.id)
  ) {
    return record;
  }

  finalize(record, {
    result: "failure",
    summary: `Session ${ORPHANED_RUN_MARKER}; no live or pending run was found.`,
  }, undefined, undefined, undefined, undefined, false);
  return record;
}

function startQueuedDispatchNow(record: SessionRecord): void {
  if (record.status === "completed") {
    scheduleQueuedDispatch(record);
    return;
  }
  if (sessionState.resumePending.has(record.id)) return;
  const run = sessionState.activeRuns.get(record.id);
  if (!run) return;
  // Providers without an in-flight steering primitive (currently Claude Code)
  // redirect by interruption plus a resume of the same provider conversation.
  // Wait for the current process to release its conversation state before
  // dispatching the selected, possibly reordered queue head. Codex's ordinary
  // live follow-up path can use native turn/steer through resume(); this queue
  // path keeps the selected item durable until the replacement run starts.
  sessionState.resumePending.add(record.id);
  sessionState.steerPending.delete(record.id);
  sessionState.activeRuns.delete(record.id);
  run.emitter.once("exit", () => {
    sessionState.resumePending.delete(record.id);
    finalize(record, { result: "failure", summary: "Stopped by user to process the follow-up queue." });
  });
  requireAgentDriver(record.agent).interrupt(run, "superseded");
}

export const sessions: SessionCatalogReader & SessionLifecycleContract & SessionQueueContract & SessionTranscriptEventContract = {
  start(opts: {
    prompt: string;
    title?: string;
    dir?: string;
    projectKey?: string;
    taskKey?: string;
    taskTitle?: string | null;
    id?: string;
    expectsOutcome?: boolean;
    attachments?: AttachmentInfo[];
    permissionMode?: string;
    author?: string;
    commandId?: string;
    // This session's default model; null/omitted ⇒ follow the global default.
    model?: string;
    // Agent reasoning default; null/omitted follows the CLI configuration.
    reasoningEffort?: ReasoningEffort;
    // Coding backend selected for this session. The proxy keeps this choice
    // immutable across follow-ups so provider-native conversation state remains valid.
    agent?: CodingAgent;
    // Set only by the session orchestration service. Human/fleet transports do
    // not accept these fields from request bodies.
    parentSessionId?: string;
    spawnDepth?: number;
    spawnRequestId?: string;
  }): SessionRecord {
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

    const record: SessionRecord = {
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
      createdModel: opts.model ?? null,
      createdReasoningEffort: opts.reasoningEffort ?? null,
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

  async branch(id, opts = {}): Promise<SessionRecord> {
    const source = sessionState.records.get(id);
    if (!source) throw new Error("unknown session");
    const driver = requireAgentDriver(source.agent);
    if (!driver.forkConversation || !driver.capabilities.branching) throw new Error("session agent does not support branching");
    if (!source.backendSessionId) throw new Error("session has no backend conversation");
    if (opts.lastTurnId && !driver.capabilities.branchAtTurn) throw new Error("session agent does not support branching at a turn");
    const sourceTranscript = readTranscriptEntries(source.id, source.agent);
    const branchTurnIndex = opts.lastTurnId
      ? sourceTranscript.findIndex(({ event }) => event.backend_turn_id === opts.lastTurnId && event.type === "result")
      : sourceTranscript.length - 1;
    if (opts.lastTurnId && branchTurnIndex < 0) throw new Error("unknown or incomplete branch turn");
    const newId = opts.id ?? randomUUID();
    const existing = sessionState.records.get(newId);
    if (existing) return existing;
    const pending = pendingSessionBranches.get(newId);
    if (pending) return pending;
    const operation = (async () => {
      const fork = await driver.forkConversation!({
        command: driver.command(settings.get()),
        backendSessionId: source.backendSessionId!,
        targetSessionId: newId,
        cwd: source.dir,
        ...(opts.lastTurnId ? { lastTurnId: opts.lastTurnId } : {}),
      });
      const now = Date.now();
      const inheritedTranscript = sourceTranscript.slice(0, branchTurnIndex + 1);
      const record: SessionRecord = {
        ...structuredClone(source),
        id: newId,
        title: opts.title?.trim() || (source.title ? `${source.title} (branch)` : null),
        backendSessionId: fork.backendSessionId,
        backendTurnId: null,
        backendRuntimeGeneration: null,
        backendTurnStatus: null,
        initiator: opts.author ?? null,
        branchedFromSessionId: source.id,
        parentSessionId: null,
        spawnDepth: 0,
        spawnRequestId: null,
        parentCompletionNotifiedAt: null,
        parentCompletionNotificationPending: false,
        queuedFollowUps: [],
        pendingSystemPrompts: [],
        status: "completed",
        outcome: null,
        startedAt: now,
        endedAt: now,
        usage: null,
        usageByModel: {},
        contextUsage: null,
        autoResumeAttempts: 0,
        lastActivityAt: now,
        eventCount: inheritedTranscript.length,
      };
      sessionState.records.set(record);
      for (const entry of inheritedTranscript) {
        appendTranscriptEvent(
          record.id,
          entry.event,
          () => typeof entry.event.createdAt === "number" ? entry.event.createdAt : now,
          entry.id,
        );
      }
      initializeBranchedContext(record.id, inheritedTranscript);
      await flushTranscript(record.id);
      persistSummary(record);
      sessionState.emitter.emit("change", record);
      return record;
    })();
    pendingSessionBranches.set(newId, operation);
    try {
      return await operation;
    } finally {
      if (pendingSessionBranches.get(newId) === operation) pendingSessionBranches.delete(newId);
    }
  },

  // "Is any session running at all" — sessions themselves run concurrently, so
  // this no longer means "can't start another". It still gates the two paths
  // that deliberately stay one-at-a-time: the autonomous task processor and the
  // update/restart flow (a daemon restart kills every in-flight run).
  isBusy(): boolean {
    return sessions.activeCount() > 0;
  },

  // How many agent processes are live right now, including a superseded process
  // that is still tearing down before its replacement can safely resume the
  // same provider conversation. activeRuns and resumePending are disjoint at
  // observable boundaries, so the sum keeps fleet activity truthful throughout
  // send-now handoffs instead of briefly reporting an idle Peon.
  activeCount(): number {
    for (const record of sessionState.records.values()) reconcileOrphanedRun(record);
    return sessionState.activeRuns.size() + sessionState.resumePending.size();
  },

  replayContextMessage(commandId, id, request) {
    if (!sessionState.records.has(id)) throw new Error("unknown session");
    return replayContextMessage(id, commandId, request);
  },

  async appendContextMessage(commandId, id, input, request) {
    const record = sessionState.records.get(id);
    if (!record) throw new Error("unknown session");
    const { event, replayed } = await appendParticipantContext(id, commandId, input, request);
    if (replayed) return event;
    record.lastActivityAt = event.createdAt;
    record.lastMessagePreview = previewText(event.text);
    record.eventCount += 1;
    persistSummary(record);
    sessionState.emitter.emit("event", { sessionId: id, event, eventId: event.eventId });
    sessionState.emitter.emit("change", record);
    return event;
  },

  // Continues a session's actual conversation via --resume — the agent keeps
  // whatever context it had, and produces a fresh outcome that may differ from
  // its previous one. Works on a completed session (the normal follow-up) and,
  // now, on a *running* one: the in-flight run is interrupted and the new
  // message resumes the conversation the instant that process dies. That
  // "insta-resume" is what a queued message does when the human wants to
  // redirect the agent now rather than wait for the current turn to finish.
  resume(
    id: string,
    prompt: string,
    attachments: AttachmentInfo[] = [],
    permissionMode?: string,
    author?: string,
    // Explicit model for this follow-up; omitted ⇒ session/global default. An
    // explicit one is pinned onto the record by runProcess, so the choice holds
    // for the rest of the conversation rather than for a single turn.
    model?: string,
    reasoningEffort?: ReasoningEffort,
    commandId?: string,
    notifyParentOnComplete = false,
    replyTo?: ReplyTo,
    attribution?: MessageAttribution,
  ): SessionRecord {
    const record = sessionState.records.get(id);
    if (!record) {
      throw new Error("unknown session");
    }
    replyTo = sessions.validateReplyTo(id, replyTo);

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
      runProcess(record, prompt, true, attachments, permissionMode, author, model, reasoningEffort, commandId, [], 0, true, replyTo, attribution);
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
          if (steerSettled || !sessionState.steerPending.has(id)) return;
          steerSettled = true;
          sessionState.steerPending.delete(id);
          // An acknowledgement means Codex accepted this message into the
          // native turn. Record it exactly once even if a terminal notification
          // was processed first (both protocol lines may arrive in one stdout
          // chunk). Cancellation, timeout and ownership replacement clear the
          // pending fence, so those late acknowledgements are ignored above.
          record.followUpPrompts.push(prompt);
          record.parentCompletionNotificationPending = notifyParentOnComplete;
          appendUserTurn(record, prompt, attachments, permissionMode, author, model, reasoningEffort, commandId, replyTo, attribution);
          persistSummary(record);
          sessionState.emitter.emit("change", record);
        };
        const steerRejected = (_error: unknown) => {
          if (steerSettled || !sessionState.steerPending.has(id)) return;
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
          prompt: buildAugmentedPrompt(buildReplyPrompt(prompt, replyTo), attachments),
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

  enqueue(
    id: string,
    prompt: string,
    attachments: AttachmentInfo[] = [],
    permissionMode?: string,
    author?: string,
    model?: string,
    reasoningEffort?: ReasoningEffort,
    commandId?: string,
    startNow = false,
    replyTo?: ReplyTo,
    attribution?: MessageAttribution,
  ): SessionRecord {
    const record = sessionState.records.get(id);
    if (!record) throw new Error("unknown session");
    replyTo = sessions.validateReplyTo(id, replyTo);
    const item: QueuedFollowUp = {
      id: randomUUID(), type: "queue", sessionId: id, prompt, attachments,
      permissionMode: permissionMode ?? null,
      author: author ?? null,
      model: model ?? null,
      reasoningEffort: reasoningEffort ?? null,
      commandId: commandId ?? null,
      replyTo: replyTo ?? null,
      authorPrincipal: attribution?.authorPrincipal ?? null,
      mentions: attribution?.mentions ?? null,
      queuedAt: Date.now(),
    };
    record.queuedFollowUps.push(item);
    persistSummary(record);
    sessionState.emitter.emit("change", record);
    if (record.status === "completed") {
      scheduleQueuedDispatch(record);
    } else if (startNow) {
      startQueuedDispatchNow(record);
    }
    return record;
  },

  enqueueSystem(id: string, prompt: string, commandId?: string): SessionRecord {
    const record = sessionState.records.get(id);
    if (!record) throw new Error("unknown session");
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error("system prompt is required");
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
    if (record.status === "completed") scheduleQueuedDispatch(record);
    return record;
  },

  markParentCompletionNotified(id: string, completedAt: number): SessionRecord {
    const record = sessionState.records.get(id);
    if (!record) throw new Error("unknown session");
    if (record.parentCompletionNotifiedAt !== completedAt || record.parentCompletionNotificationPending) {
      record.parentCompletionNotifiedAt = completedAt;
      record.parentCompletionNotificationPending = false;
      persistSummary(record);
      sessionState.emitter.emit("change", record);
    }
    return record;
  },

  validateReplyTo(id: string, replyTo: ReplyTo | undefined): ReplyTo | undefined {
    if (!replyTo) return undefined;
    const record = sessionState.records.get(id);
    if (!record) throw new Error("unknown session");
    const entry = readTranscriptEntries(id, record.agent).find((candidate) => candidate.id === replyTo.eventId);
    if (!entry) {
      for (const other of sessionState.records.values()) {
        if (other.id !== id && readTranscriptEntries(other.id, other.agent).some((candidate) => candidate.id === replyTo.eventId)) {
          throw new ReplyToError("REPLY_SOURCE_WRONG_SESSION", "replyTo.eventId belongs to a different session");
        }
      }
      throw new ReplyToError("REPLY_SOURCE_NOT_FOUND", "replyTo.eventId was not found in this session");
    }
    if (!isReplyableEvent(entry.event)) {
      throw new ReplyToError("REPLY_SOURCE_NOT_REPLYABLE", "replyTo.eventId is not a replyable transcript event");
    }
    return { ...replyTo };
  },

  queued(id: string): QueuedFollowUp[] | undefined {
    return sessionState.records.get(id)?.queuedFollowUps.slice();
  },

  removeQueued(id: string, itemId: string): "removed" | "not_found" | "unknown_session" {
    const record = sessionState.records.get(id);
    if (!record) return "unknown_session";
    const index = record.queuedFollowUps.findIndex((item) => item.id === itemId);
    if (index < 0) return "not_found";
    record.queuedFollowUps.splice(index, 1);
    persistSummary(record);
    sessionState.emitter.emit("change", record);
    return "removed";
  },

  editQueued(
    id: string,
    itemId: string,
    prompt: string,
    replyTo?: ReplyTo | null,
    // Omitted preserves the item's mentions, an array replaces them, null clears.
    mentions?: ContextMention[] | null,
  ): SessionRecord | "not_found" | "unknown_session" {
    const record = sessionState.records.get(id);
    if (!record) return "unknown_session";
    const item = record.queuedFollowUps.find((queued) => queued.id === itemId);
    if (!item) return "not_found";
    if (replyTo) replyTo = sessions.validateReplyTo(id, replyTo);
    item.prompt = prompt;
    if (replyTo !== undefined) item.replyTo = replyTo;
    if (mentions !== undefined) item.mentions = mentions;
    persistSummary(record);
    sessionState.emitter.emit("change", record);
    return record;
  },

  steerQueued(id: string, itemId: string): "steered" | "not_found" | "unknown_session" {
    const record = sessionState.records.get(id);
    if (!record) return "unknown_session";
    const index = record.queuedFollowUps.findIndex((item) => item.id === itemId);
    if (index < 0) return "not_found";
    record.queuedFollowUps[index]!.type = "steer";
    if (index > 0) {
      const [item] = record.queuedFollowUps.splice(index, 1);
      record.queuedFollowUps.unshift(item);
    }
    // Persist the new queue head before interrupting. If the daemon exits or
    // the provider teardown races, restart recovery still dispatches the item
    // the operator selected while preserving every other item's order.
    persistSummary(record);
    sessionState.emitter.emit("change", record);

    const run = record.status === "running" ? sessionState.activeRuns.get(id) : undefined;
    const driver = run ? requireAgentDriver(record.agent) : undefined;
    if (run && driver?.steer && !sessionState.resumePending.has(id) && !sessionState.steerPending.has(id)) {
      const selected = record.queuedFollowUps[0]!;
      let settled = false;
      const accepted = () => {
        if (settled || !sessionState.steerPending.has(id)) return;
        settled = true;
        sessionState.steerPending.delete(id);
        const acceptedIndex = record.queuedFollowUps.findIndex((item) => item.id === selected.id);
        if (acceptedIndex < 0) return;
        record.queuedFollowUps.splice(acceptedIndex, 1);
        record.followUpPrompts.push(selected.prompt);
        appendUserTurn(
          record,
          selected.prompt,
          selected.attachments,
          selected.permissionMode ?? undefined,
          selected.author ?? undefined,
          selected.model ?? undefined,
          selected.reasoningEffort ?? undefined,
          selected.commandId ?? undefined,
          selected.replyTo ?? undefined,
          { authorPrincipal: selected.authorPrincipal ?? undefined, mentions: selected.mentions ?? undefined },
        );
        persistSummary(record);
        sessionState.emitter.emit("change", record);
        if (record.status === "completed") scheduleQueuedDispatch(record);
      };
      const rejected = (_error: unknown) => {
        if (settled || !sessionState.steerPending.has(id)) return;
        settled = true;
        sessionState.steerPending.delete(id);
        // The selected item is still the durable queue head. Fall back to the
        // same interrupt-and-resume redirect used by Claude Code.
        startQueuedDispatchNow(record);
      };
      sessionState.steerPending.add(id);
      if (driver.steer(run, {
        prompt: buildAugmentedPrompt(buildReplyPrompt(selected.prompt, selected.replyTo ?? undefined), selected.attachments),
        attachments: selected.attachments,
        permissionMode: selected.permissionMode ?? undefined,
        author: selected.author ?? undefined,
        model: selected.model ?? undefined,
        reasoningEffort: selected.reasoningEffort ?? undefined,
        commandId: selected.commandId ?? undefined,
      }, { accepted, rejected })) {
        return "steered";
      }
      sessionState.steerPending.delete(id);
    }
    startQueuedDispatchNow(record);
    return "steered";
  },

  /** @deprecated Use steerQueued. */
  sendQueuedNow(id: string, itemId: string): "sent" | "not_found" | "unknown_session" {
    const result = sessions.steerQueued(id, itemId);
    return result === "steered" ? "sent" : result;
  },

  // Sets (or, with null/empty, clears) a session's human-given display name.
  // Safe on a running session — it's cosmetic and doesn't touch the run — and
  // persists + broadcasts like any other record change so an open detail view
  // and the list both pick it up. Returns undefined for an unknown id so the
  // route can 404.
  rename(id: string, title: string | null): SessionRecord | undefined {
    const record = sessionState.records.get(id);
    if (!record) return undefined;
    const trimmed = title?.trim();
    record.title = trimmed ? trimmed : null;
    persistSummary(record);
    sessionState.emitter.emit("change", record);
    return record;
  },

  preview(id: string, filePath: string, author?: string): AgentEvent | undefined {
    const record = sessionState.records.get(id);
    if (!record) return undefined;
    return appendPreviewEvent(record, filePath, author) ?? undefined;
  },

  get(id: string): SessionRecord | undefined {
    const record = sessionState.records.get(id);
    return record ? reconcileOrphanedRun(record) : undefined;
  },

  list(): SessionRecord[] {
    return Array.from(sessionState.records.values(), reconcileOrphanedRun).sort((a, b) => b.startedAt - a.startedAt);
  },

  page(options: { limit: number; cursor?: string; projectKey?: string }) {
    for (const record of sessionState.records.values()) reconcileOrphanedRun(record);
    return paginateSessions(sessionState.records.values(), options);
  },

  // Keep project attribution intact when an operator changes a project's local
  // key. This includes candidate keys captured by older unbound sessions, so a
  // rename cannot resurrect the old key in project rollups after a restart.
  renameProjectKey(oldKey: string, newKey: string): number {
    let changed = 0;
    for (const record of sessionState.records.values()) {
      const projectChanged = record.projectKey === oldKey;
      const candidatesChanged = record.candidateProjectKeys.includes(oldKey);
      if (!projectChanged && !candidatesChanged) continue;
      if (projectChanged) record.projectKey = newKey;
      if (candidatesChanged) {
        record.candidateProjectKeys = [...new Set(record.candidateProjectKeys.map((key) => key === oldKey ? newKey : key))];
      }
      persistSummary(record);
      sessionState.emitter.emit("change", record);
      changed += 1;
    }
    return changed;
  },

  statsForPeriod(period: StatsPeriod): SessionStats {
    return calculateStatsForPeriod(sessionState.records.values(), period, sessionsSizeBytes());
  },

  getTranscript(id: string): AgentEvent[] {
    const agent = sessionState.records.get(id)?.agent ?? "claude-code";
    return readTranscript(id, agent);
  },

  getTranscriptEntries(id: string) {
    const agent = sessionState.records.get(id)?.agent ?? "claude-code";
    return readTranscriptEntries(id, agent);
  },

  getTranscriptPage(id: string, options: { limit: number; cursor?: string }) {
    const agent = sessionState.records.get(id)?.agent ?? "claude-code";
    return readTranscriptPage(id, agent, options);
  },

  cancel(id: string): boolean {
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
    if (!run) return false;
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
    if (record) finalize(record, { result: "failure", summary: "Cancelled by user." }, undefined, undefined, undefined, undefined, false);
    if (record) requireAgentDriver(record.agent).interrupt(run, "cancel");
    return true;
  },

  // Permanently remove a session — its in-memory record and every on-disk
  // artifact (summary, transcript, and the per-session dir holding mcp-config /
  // attachments). Refuses a *running* session ("running") so a live agent
  // process is never orphaned from its record — cancel it first. Returns
  // "not_found" for an unknown id, "deleted" on success.
  delete(id: string): "deleted" | "not_found" | "running" {
    const record = sessionState.records.get(id);
    if (!record) return "not_found";
    if (sessionState.activeRuns.has(id)) return "running";
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
  notifyShuttingDown(): void {
    // Every in-flight run dies with the daemon, not just one — snapshot the ids
    // first since finalize() mutates activeRuns as we go.
    for (const [id, run] of [...sessionState.activeRuns.entries()]) {
      const record = sessionState.records.get(id);
      if (!record) continue;
      sessionState.steerPending.delete(id);
      getAgentDriver(record.agent)?.shutdown(run);
      finalize(record, {
        result: "failure",
        summary: `Daemon was ${RESTART_INTERRUPTION_MARKER} — not an agent failure, the process was killed as part of the restart. Re-run it.`,
      }, undefined, undefined, undefined, undefined, false);
    }
  },

  flushTranscripts(): Promise<void> {
    return flushTranscript();
  },

  restoreFromDisk(): void {
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
  async resumeInterrupted(): Promise<void> {
    const autoResume = settings.get().autoResumeInterrupted;
    // Snapshot first: resume() re-runs the record but never adds a key, so
    // iterating records directly is safe — a copy just keeps intent obvious.
    for (const record of [...sessionState.records.values()]) {
      if (!isRestartInterrupted(record)) continue;
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
        } catch (error) {
          record.backendTurnStatus = "unknown";
          record.outcome = { result: "failure", summary: `Could not safely reconcile the Codex native turn: ${error instanceof Error ? error.message : String(error)}` };
          persistSummary(record);
          continue;
        }
      }
      // Reconciliation applies to every native session. Automatic continuation
      // remains deliberately narrower: only ad-hoc chats, and only when the
      // operator has enabled it.
      if (record.expectsOutcome || !autoResume) continue;
      if (record.autoResumeAttempts >= MAX_AUTO_RESUME_ATTEMPTS) {
        console.log(
          `sessions: not auto-resuming ${record.id} — already retried ${record.autoResumeAttempts}x, leaving for a human`,
        );
        continue;
      }
      // Persist the bump before spawning so the cap holds even if this very
      // resume is itself interrupted before it can re-persist on completion.
      record.autoResumeAttempts += 1;
      persistSummary(record);
      try {
        this.resume(record.id, AUTO_RESUME_PROMPT, [], undefined, SYSTEM_AUTHOR);
        console.log(
          `sessions: auto-resumed interrupted ad-hoc session ${record.id} (attempt ${record.autoResumeAttempts})`,
        );
      } catch (err) {
        console.error(`sessions: failed to auto-resume ${record.id}:`, err);
      }
    }
  },

  resumeQueued(): void {
    for (const record of sessionState.records.values()) {
      if (
        record.status !== "completed"
        || record.backendTurnStatus === "unknown"
        || record.backendTurnStatus === "inProgress"
        || (isRestartInterrupted(record) && record.pendingSystemPrompts.length === 0)
      ) continue;
      scheduleQueuedDispatch(record);
    }
  },

  on: sessionState.emitter.on,
  off: sessionState.emitter.off,
};
