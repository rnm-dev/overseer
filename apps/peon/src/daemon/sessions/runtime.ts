import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { settings } from "../settings/index.js";
import { McpConfigAssembler, mcpBindingRegistry } from "../mcpBindings.js";
import { runAgent, type AgentEvent, type AgentExit, type AgentRun } from "../agents/index.js";
import { getAgentDriver, requireAgentDriver } from "../agents/index.js";
import { projectStore } from "../projects/index.js";
import { resolveFromDir } from "../files/index.js";
import { narrowReasoningEffort, resolveModel, type ReasoningEffort } from "../providers/modelCatalog.js";
import type {
  AttachmentInfo,
  PendingSystemPrompt,
  ReplyTo,
  SessionOutcome,
  SessionRecord,
  SessionUsage,
} from "./sessionTypes.js";
import type { AgentContextUsage, SessionWarning, SessionWarningCode } from "./sessionWarningTypes.js";
import { buildAugmentedPrompt, buildSystemPrompt } from "./sessionPrompts.js";
import { buildReplyPrompt } from "./replyTo.js";
import { sessionWarnings } from "./sessionWarnings.js";
import {
  appendTranscriptEvent,
  assistantEventText,
  persistSummary,
  previewText,
  readTranscript,
  sessionsDir,
} from "./sessionArtifacts.js";
import { isAgentPreviewArtifact, previewPathsFromAgentEvent, sessionPreviewDir } from "./preview.js";
import { WARNING_COOLDOWN_MS, sessionState } from "./state.js";
import { parseListenAddress } from "../../shared/listenAddress.js";

export function appendPreviewEvent(record: SessionRecord, filePath: string, author?: string): AgentEvent | null {
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  const event: AgentEvent = {
    type: "preview",
    path: trimmed,
    name: path.basename(trimmed),
    ...(author ? { author } : {}),
  };
  const entry = appendTranscriptEvent(record.id, event);
  record.lastActivityAt = entry.event.createdAt!;
  record.eventCount += 1;
  persistSummary(record);
  sessionState.emitter.emit("event", { sessionId: record.id, event: entry.event, eventId: entry.id });
  sessionState.emitter.emit("change", record);
  return entry.event;
}

function warningFromEvent(event: AgentEvent): SessionWarning | null {
  if (event.type !== "warning" || typeof event.sessionId !== "string"
    || !["context_near_limit", "payload_near_limit", "payload_truncated"].includes(String(event.code))
    || typeof event.message !== "string") return null;
  const { type: _type, ...fields } = event;
  return { type: "session_warning", ...fields } as SessionWarning;
}

function shouldEmitWarning(warning: SessionWarning, now = Date.now()): boolean {
  if (warning.code === "payload_truncated") return true;
  const key = `${warning.sessionId}:${warning.code}:${warning.source ?? "session"}`;
  const ratio = warning.limitBytes
    ? (warning.currentBytes ?? 0) / warning.limitBytes
    : warning.limitTokens
      ? (warning.currentTokens ?? 0) / warning.limitTokens
      : 0;
  const previous = sessionState.warningThrottle.get(key);
  if (previous && now - previous.at < WARNING_COOLDOWN_MS && ratio < previous.ratio + 0.1) return false;
  sessionState.warningThrottle.set(key, { at: now, ratio });
  return true;
}

export function scheduleQueuedDispatch(record: SessionRecord): void {
  if (
    (record.queuedFollowUps.length === 0 && record.pendingSystemPrompts.length === 0)
    || sessionState.queueDispatchPending.has(record.id)
  ) return;
  sessionState.queueDispatchPending.add(record.id);
  queueMicrotask(() => {
    sessionState.queueDispatchPending.delete(record.id);
    if (sessionState.records.get(record.id) !== record) return;
    if (
      record.status !== "completed"
      || sessionState.activeRuns.has(record.id)
      || sessionState.resumePending.has(record.id)
      || sessionState.steerPending.has(record.id)
    ) return;
    const item = record.queuedFollowUps.shift();
    // Keep triggers durable until the provider process has actually started.
    // A setup/configuration failure must not acknowledge invisible work that
    // no agent ever received.
    const systemPrompts = record.pendingSystemPrompts.slice();
    if (!item && systemPrompts.length === 0) return;
    if (item) record.followUpPrompts.push(item.prompt);
    // Queue entries come from human/fleet transports. Orchestration follow-ups
    // use resume() directly and arm this marker there, so a queued turn must
    // never inherit notification debt from the turn that just completed.
    record.parentCompletionNotificationPending = false;
    record.status = "running";
    record.outcome = null;
    record.endedAt = null;
    try {
      runProcess(
        record,
        item?.prompt ?? "",
        record.backendSessionId !== null,
        item?.attachments ?? [],
        item?.permissionMode ?? undefined,
        item?.author ?? undefined,
        item?.model ?? undefined,
        item?.reasoningEffort ?? undefined,
        item?.commandId ?? systemPrompts.map((prompt) => prompt.commandId).find(Boolean) ?? undefined,
        systemPrompts,
        0,
        true,
        item?.replyTo ?? undefined,
      );
    } catch (error) {
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
      console.error(
        `failed to dispatch ${item ? `queued follow-up ${item.id}` : "system triggers"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

// The concrete model id an event reveals, if any — the CLI stamps it on its
// `system` init event (`event.model`) and on each `assistant` event
// (`event.message.model`). Used to attribute a turn's usage to the model that
// actually ran it, which resolves aliases and "default" turns to a real id.
function eventModel(event: AgentEvent): string | null {
  if (typeof event.model === "string") return event.model;
  const message = event.message as Record<string, unknown> | undefined;
  if (message && typeof message.model === "string") return message.model;
  return null;
}

function isSyntheticAssistantEvent(event: AgentEvent): boolean {
  if (event.type !== "assistant") return false;
  const message = event.message as Record<string, unknown> | undefined;
  return message?.model === "<synthetic>";
}

// Folds one turn's usage into a per-model accumulator. Nullable source fields
// count as 0 so the running total is always a concrete number.
function addUsage(acc: SessionUsage | undefined, add: SessionUsage): SessionUsage {
  const sum = (x: number | null | undefined, y: number | null | undefined): number => (x ?? 0) + (y ?? 0);
  return {
    totalCostUsd: sum(acc?.totalCostUsd, add.totalCostUsd),
    durationMs: sum(acc?.durationMs, add.durationMs),
    inputTokens: sum(acc?.inputTokens, add.inputTokens),
    outputTokens: sum(acc?.outputTokens, add.outputTokens),
    cacheCreationInputTokens: sum(acc?.cacheCreationInputTokens, add.cacheCreationInputTokens),
    cacheReadInputTokens: sum(acc?.cacheReadInputTokens, add.cacheReadInputTokens),
  };
}

export function finalizeSession(
  record: SessionRecord,
  outcome: SessionOutcome | null,
  numTurns?: number,
  usage?: SessionUsage,
  // Concrete model this turn's `usage` should be attributed to, for the
  // per-model breakdown. Null/omitted ⇒ bucketed under "unknown".
  model?: string | null,
  // record.turnCount as it stood *before* this run — i.e. the accumulated total
  // from prior invocations. This run's authoritative `numTurns` is added to it,
  // so a resumed session's turn count is the sum across every invocation, not
  // just the last. Omitted on the harness-fail paths (no numTurns) where the
  // live-incremented count already stands.
  turnCountBase?: number,
  dispatchQueued = true,
): void {
  // A clean finish (chat with nothing to grade, or a graded success) is the
  // strongest possible signal claude-code is working — clears any
  // previously observed auth failure regardless of what caused it.
  if (outcome === null || outcome.result === "success") getAgentDriver(record.agent)?.auth.observeSuccess();
  record.status = "completed";
  record.outcome = outcome;
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
  if (typeof numTurns === "number") record.turnCount = (turnCountBase ?? 0) + numTurns;
  if (usage) {
    record.usage = addUsage(record.usage ?? undefined, usage);
    if (!record.usageByModel) record.usageByModel = {};
    const key = model || "unknown";
    record.usageByModel[key] = addUsage(record.usageByModel[key], usage);
  }
  persistSummary(record);
  // Remove the live process before publishing the terminal summary so
  // activeCount() and status:"completed" describe the same boundary.
  sessionState.activeRuns.delete(record.id);
  sessionState.emitter.emit("change", record);
  sessionState.emitter.emit("complete", record);
  if (dispatchQueued) scheduleQueuedDispatch(record);
}

// AgentEvent is an untyped Record<string, unknown> (the CLI's stream-json
// output has no compile-time shape), so every field is read defensively.
// Present on both success and error result events — even a failed run spent
// some tokens, worth recording.
function extractUsage(resultEvent: AgentEvent): SessionUsage {
  const usage = resultEvent.usage as Record<string, unknown> | undefined;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    totalCostUsd: num(resultEvent.total_cost_usd),
    durationMs: num(resultEvent.duration_ms),
    inputTokens: num(usage?.input_tokens),
    outputTokens: num(usage?.output_tokens),
    cacheCreationInputTokens: num(usage?.cache_creation_input_tokens),
    cacheReadInputTokens: num(usage?.cache_read_input_tokens),
  };
}

// Tiers 2 and 3 of the outcome classification — tier 1 (harness force-fail on
// timeout/turn-cap/spawn error/missing result event) is handled inline in
// runProcess()'s exit handler.
export function classifyFromResultEvent(
  record: SessionRecord,
  resultEvent: AgentEvent,
  runModel?: string | null,
  turnCountBase?: number,
): void {
  const numTurns = typeof resultEvent.num_turns === "number" ? resultEvent.num_turns : undefined;
  const usage = extractUsage(resultEvent);
  // Prefer the model captured live from the run's events; fall back to a model
  // on the result event itself if the CLI put one there.
  const model = runModel || eventModel(resultEvent);

  if (resultEvent.is_error === true || resultEvent.subtype !== "success") {
    // errors[] carries the actual human-readable reason (e.g. "No
    // conversation found with session ID: ..." from a --resume against a
    // session with nothing persisted) — prefer it over dumping the whole
    // raw event, which is technically complete but unreadable.
    let reason: string;
    if (Array.isArray(resultEvent.errors) && resultEvent.errors.length > 0) {
      reason = resultEvent.errors.join("; ");
    } else if (typeof resultEvent.result === "string") {
      reason = resultEvent.result;
    } else {
      reason = JSON.stringify(resultEvent);
    }
    getAgentDriver(record.agent)?.auth.observeFailure(reason);
    finalizeSession(
      record,
      { result: "failure", summary: `Agent CLI reported an error (subtype: ${String(resultEvent.subtype)}): ${reason}` },
      numTurns,
      usage,
      model,
      turnCountBase,
    );
    return;
  }

  // Chat sessions never requested --json-schema (see runProcess), so there's
  // no structured_output to look for and nothing to grade — a clean
  // completion just has no outcome, rather than a fabricated one.
  if (!record.expectsOutcome) {
    finalizeSession(record, null, numTurns, usage, model, turnCountBase);
    return;
  }

  const structured = resultEvent.structured_output as {
    result?: unknown;
    summary?: unknown;
    previewPath?: unknown;
  } | undefined;
  if (
    structured &&
    (structured.result === "success" || structured.result === "failure" || structured.result === "needs_human") &&
    typeof structured.summary === "string"
  ) {
    const outcome = requireAgentDriver(record.agent).normalizeOutcome(structured);
    if (!outcome) {
      finalizeSession(record, { result: "failure", summary: "Agent completed but did not produce a valid structured outcome." }, numTurns, usage, model, turnCountBase);
      return;
    }
    finalizeSession(
      record,
      outcome,
      numTurns,
      usage,
      model,
      turnCountBase,
    );
    return;
  }

  finalizeSession(
    record,
    { result: "failure", summary: "Agent completed but did not produce a valid structured outcome." },
    numTurns,
    usage,
    model,
    turnCountBase,
  );
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
export function appendUserTurn(
  record: SessionRecord,
  prompt: string,
  attachments: AttachmentInfo[] = [],
  permissionMode?: string,
  author?: string,
  model?: string,
  reasoningEffort?: ReasoningEffort,
  commandId?: string,
  replyTo?: ReplyTo,
): void {
  const userEvent: AgentEvent = {
    type: "user_message", text: prompt,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(author ? { author } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(commandId ? { commandId } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
  const userEntry = appendTranscriptEvent(record.id, userEvent);
  const now = userEntry.event.createdAt!;
  record.lastUserMessageAt = now;
  record.lastActivityAt = now;
  if (prompt.trim()) record.lastMessagePreview = previewText(prompt);
  sessionState.emitter.emit("event", { sessionId: record.id, event: userEntry.event, eventId: userEntry.id });
}

interface TurnMcpConfig {
  path: string;
  allowedTools: string;
  unavailableArmoryPackages?: Array<{ packageId: string | null; code: string; message: string }>;
  release?: () => void;
}

function writeMcpConfig(record: SessionRecord): TurnMcpConfig | undefined {
  const controlPort = parseListenAddress(settings.get().listenAddress).port;
  const assembled = new McpConfigAssembler(mcpBindingRegistry, `http://127.0.0.1:${controlPort}`).assemble({
    sessionId: record.id,
    turnId: randomUUID(),
    projectId: record.projectId,
    // Children never receive the spawning tool. The orchestration service also
    // rejects them server-side if a credential is copied from another config.
    allowSessionSpawning: record.parentSessionId === null && record.spawnDepth === 0,
  });
  if (!assembled) return undefined;
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
  } catch (error) {
    assembled.release?.();
    throw error;
  }
}

export function runProcess(
  record: SessionRecord,
  prompt: string,
  resume: boolean,
  attachments: AttachmentInfo[] = [],
  permissionMode?: string,
  author?: string,
  perTurnModel?: string,
  perTurnReasoningEffort?: ReasoningEffort,
  commandId?: string,
  systemPrompts: PendingSystemPrompt[] = [],
  zeroTurnRetryAttempt = 0,
  appendPromptToTranscript = true,
  replyTo?: ReplyTo,
): boolean {
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
    appendUserTurn(record, prompt, attachments, permissionMode, author, perTurnModel, perTurnReasoningEffort, commandId, replyTo);
  }

  let mcpConfig: TurnMcpConfig | undefined;
  try {
    mcpConfig = writeMcpConfig(record);
  } catch (error) {
    finalizeSession(record, {
      result: "failure",
      summary: `Failed to resolve Armory packages for this turn: ${error instanceof Error ? error.message : String(error)}`,
    }, undefined, undefined, undefined, undefined, false);
    return false;
  }
  let mcpReleased = false;
  const releaseMcp = () => {
    if (mcpReleased) return;
    mcpReleased = true;
    mcpConfig?.release?.();
  };
  const driver = getAgentDriver(record.agent);
  if (!driver || !driver.available()) {
    releaseMcp();
    finalizeSession(record, {
      result: "failure",
      summary: `Agent driver "${record.agent}" is not registered or available; install or enable it to continue this session.`,
    }, undefined, undefined, undefined, undefined, false);
    return false;
  }
  const outcomeSchema = driver.outcomeSchema(record.expectsOutcome);
  let outcomeSchemaPath: string | undefined;
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
  const requestedReasoningEffort = perTurnReasoningEffort
    ?? record.reasoningEffort
    ?? currentSettings.ai.defaultReasoningEffort
    ?? undefined;
  const reasoningEffort = narrowReasoningEffort(requestedReasoningEffort, record.agent, model);

  // An explicit selection is sticky. The operator picked it in the composer for
  // this conversation, not for one message, and every surface that reads the
  // record — the composer's own fallback, the run indicator, a reloaded page —
  // would otherwise keep naming the model the session was started with. Only an
  // override is pinned: the resolution above also falls back to the daemon-wide
  // default, and pinning that would freeze a session against later changes.
  let selectionChanged = false;
  if (perTurnModel && record.model !== model) {
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
  if (zeroTurnRetryAttempt === 0) record.turnBudget += maxTurns;

  const candidates = record.candidateProjectKeys
    .map((key) => projectStore.get(key))
    .filter((project): project is NonNullable<typeof project> => project !== undefined);
  const previewDir = sessionPreviewDir(record.id);
  const project = record.projectKey ? projectStore.get(record.projectKey) : undefined;
  let systemPromptAppend = buildSystemPrompt(
    record.expectsOutcome,
    candidates,
    previewDir,
    project,
    currentSettings.ai.soul,
    author,
  );
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

  let run: AgentRun;
  try {
    run = runAgent({
      agent: record.agent,
      command: driver.command(currentSettings),
      prompt: buildAugmentedPrompt(
        buildReplyPrompt(prompt || "Process all queued internal automation triggers from the system instructions.", replyTo),
        attachments,
      ),
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
        if (record.status !== "running") return;
        record.backendTurnId = state.turnId;
        record.backendRuntimeGeneration = state.runtimeGeneration;
        record.backendTurnStatus = state.status;
        persistSummary(record);
      },
    });
  } catch (err) {
    releaseMcp();
    finalizeSession(record, {
      result: "failure",
      summary: `Failed to configure agent CLI: ${err instanceof Error ? err.message : String(err)}`,
    }, undefined, undefined, undefined, undefined, false);
    return false;
  }
  sessionState.activeRuns.set(record.id, run);

  let systemPromptsAcknowledged = systemPrompts.length === 0;
  const acknowledgeSystemPrompts = () => {
    if (systemPromptsAcknowledged) return;
    systemPromptsAcknowledged = true;
    const delivered = new Set(systemPrompts);
    record.pendingSystemPrompts = record.pendingSystemPrompts.filter((prompt) => !delivered.has(prompt));
    persistSummary(record);
    sessionState.emitter.emit("change", record);
  };

  let killedFor: string | null = null;
  let hasNonSyntheticAssistant = false;
  let retryZeroTurn = false;
  // The concrete model id seen in this run's events (set below), used to
  // attribute the result event's usage to the model that actually ran.
  let runModel: string | null = null;
  // turnCount accumulated by prior invocations, captured before this run adds to
  // it — finalize sets record.turnCount to this base plus the run's num_turns.
  const turnCountBase = record.turnCount;

  // True once this run has been superseded — the record's active run for this
  // id is now a different process. Happens when resume() interrupts a running
  // session: it detaches this run from activeRuns and spawns a fresh one on the
  // same record.
  const superseded = () => sessionState.activeRuns.get(record.id) !== run;

  const timeoutHandle = setTimeout(() => {
    killedFor = `Timed out after ${taskTimeoutMs}ms`;
    sessionState.steerPending.delete(record.id);
    driver.interrupt(run, "timeout");
  }, taskTimeoutMs);

  run.emitter.on("event", (event: AgentEvent) => {
    if (superseded()) return;
    // Stderr/warnings can be emitted by a CLI that rejects its configuration
    // before accepting the turn. Require a substantive provider event (or
    // context usage below) before acknowledging invisible instructions.
    if (event.type !== "stderr" && event.type !== "warning") acknowledgeSystemPrompts();
    const sessionWarning = warningFromEvent(event);
    if (sessionWarning && !shouldEmitWarning(sessionWarning)) return;
    const previewPaths = previewPathsFromAgentEvent(event);
    // A schema-constrained previewPath lives on the terminal result event. Put
    // its preview immediately before that result so the outcome remains the
    // transcript's true final item.
    const existingPreviewPaths = previewPaths.flatMap((filePath) => {
      try {
        const absPath = resolveFromDir(record.dir, filePath);
        return statSync(absPath).isFile() && isAgentPreviewArtifact(absPath) ? [absPath] : [];
      } catch {
        return [];
      }
    });
    if (event.type === "result") {
      for (const filePath of existingPreviewPaths) appendPreviewEvent(record, filePath, "agent");
    }
    const entry = appendTranscriptEvent(record.id, event);
    sessionState.emitter.emit("event", { sessionId: record.id, event: entry.event, eventId: entry.id });
    if (sessionWarning) sessionWarnings.publish(sessionWarning);

    const backendTurnId = typeof event.backend_turn_id === "string" ? event.backend_turn_id : null;
    const backendRuntimeGeneration = typeof event.runtime_generation === "number" ? event.runtime_generation : null;
    const backendTurnStatus =
      ["inProgress", "completed", "interrupted", "failed", "unknown"].includes(String(event.backend_turn_status))
        ? event.backend_turn_status as SessionRecord["backendTurnStatus"]
        : null;
    if (
      (backendTurnId && record.backendTurnId !== backendTurnId)
      || (backendRuntimeGeneration !== null && record.backendRuntimeGeneration !== backendRuntimeGeneration)
      || (backendTurnStatus && record.backendTurnStatus !== backendTurnStatus)
    ) {
      if (backendTurnId) record.backendTurnId = backendTurnId;
      if (backendRuntimeGeneration !== null) record.backendRuntimeGeneration = backendRuntimeGeneration;
      if (backendTurnStatus) record.backendTurnStatus = backendTurnStatus;
      persistSummary(record);
    }

    // Track the concrete model the CLI is actually running, so the result
    // event's usage can be attributed to it.
    const em = eventModel(event);
    if (em) runModel = em;
    if (event.type === "system" && typeof event.session_id === "string" && record.backendSessionId !== event.session_id) {
      record.backendSessionId = event.session_id;
      persistSummary(record);
    }

    // Any event the agent emits counts as activity; a text-bearing assistant
    // turn also refreshes the list's chat-style preview.
    record.lastActivityAt = entry.event.createdAt!;
    record.eventCount += 1;

    // Convert the agent-facing handoff conventions into a first-class event.
    if (event.type !== "result") {
      for (const filePath of existingPreviewPaths) appendPreviewEvent(record, filePath, "agent");
    }

    // stdout parse failures and CLI stderr are canonical events too.
    if (event.type === "stderr" && typeof event.text === "string") driver.auth.observeFailure(event.text);

    if (event.type === "assistant" && !isSyntheticAssistantEvent(event)) {
      hasNonSyntheticAssistant = true;
      record.turnCount += 1;
      const text = assistantEventText(event);
      if (text) record.lastMessagePreview = previewText(text);
      if (record.turnCount > record.turnBudget && !killedFor) {
        killedFor = `Exceeded max turns (${record.turnBudget}) without concluding`;
        sessionState.steerPending.delete(record.id);
        driver.interrupt(run, "timeout");
      }
    }

    if (event.type === "result") {
      clearTimeout(timeoutHandle);
      // A cancel()/notifyShuttingDown() can finalize the record before this
      // event arrives.
      if (record.status === "completed") return;
      // Claude Code can dequeue the supplied -p prompt in the same startup
      // batch as an orphaned background-task notification and terminate the
      // resumed invocation without handling the prompt. Wait for this process
      // to release its session file, then replay the same logical turn once.
      if (
        record.agent === "claude-code"
        && resume
        && prompt.trim().length > 0
        && event.num_turns === 0
        && !hasNonSyntheticAssistant
        && zeroTurnRetryAttempt === 0
      ) {
        retryZeroTurn = true;
        return;
      }
      classifyFromResultEvent(record, event, runModel, turnCountBase);
    }
  });

  run.emitter.on("context", (usage: AgentContextUsage) => {
    if (superseded() || !Number.isFinite(usage.currentTokens) || !Number.isFinite(usage.limitTokens)
      || usage.currentTokens < 0 || usage.limitTokens <= 0) return;
    acknowledgeSystemPrompts();
    record.contextUsage = { ...usage, updatedAt: Date.now() };
    persistSummary(record);
    sessionState.emitter.emit("change", record);
    if (usage.currentTokens / usage.limitTokens < 0.7) return;
    run.emitter.emit("event", {
      type: "warning",
      sessionId: record.id,
      code: "context_near_limit" satisfies SessionWarningCode,
      source: "model_context",
      currentTokens: usage.currentTokens,
      limitTokens: usage.limitTokens,
      action: "compact",
      message: "Session context is approaching the model limit. Run compact after the active task finishes.",
    } satisfies AgentEvent);
  });

  run.emitter.on("exit", (exit: AgentExit) => {
    clearTimeout(timeoutHandle);
    releaseMcp();
    // A superseded run's child has just died from resume()'s interrupt kill.
    if (superseded()) return;
    if (record.status === "completed") return;
    if (retryZeroTurn) {
      // The zero-turn result acknowledged hidden triggers without actually
      // processing them. Restore their durable queue state before starting
      // the replacement process.
      const pending = new Set(record.pendingSystemPrompts);
      record.pendingSystemPrompts.unshift(...systemPrompts.filter((item) => !pending.has(item)));
      sessionState.activeRuns.delete(record.id);
      persistSummary(record);
      runProcess(
        record,
        prompt,
        resume,
        attachments,
        permissionMode,
        author,
        perTurnModel,
        perTurnReasoningEffort,
        commandId,
        systemPrompts,
        zeroTurnRetryAttempt + 1,
        false,
        replyTo,
      );
      return;
    }
    if (killedFor) {
      finalizeSession(
        record,
        { result: "failure", summary: killedFor },
        undefined, undefined, undefined, undefined, systemPromptsAcknowledged,
      );
      return;
    }
    if (exit.spawnError) {
      driver.auth.observeFailure(exit.spawnError);
      finalizeSession(
        record,
        { result: "failure", summary: `Failed to start agent CLI: ${exit.spawnError}` },
        undefined, undefined, undefined, undefined, systemPromptsAcknowledged,
      );
      return;
    }
    finalizeSession(
      record,
      {
        result: "failure",
        summary: `Process exited (code ${exit.code}, signal ${exit.signal}) without a result event`,
      },
      undefined, undefined, undefined, undefined, systemPromptsAcknowledged,
    );
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
