import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { AgentEvent, AgentExit, AgentReconcileInput, AgentReconcileResult, AgentRun, AgentRunOptions, AgentSteerInput } from "./registry.js";
import {
  CodexAppServerError,
  CodexAppServerRuntime,
  CODEX_APP_SERVER_LIMITS,
  type CodexAppServerNotification,
} from "./runtimes/codexAppServerRuntime.js";
import { codexCommandToolName, normalizeCodexFileChanges } from "./codex.js";
import { guardToolOutput } from "../sessions/index.js";
import type { AgentContextUsage } from "../sessions/index.js";
import { MANAGED_PLUGIN_INQUIRY_TTL_MS } from "../managedPluginInquiries.js";

interface ThreadResponse {
  thread?: { id?: unknown };
  model?: unknown;
  reasoningEffort?: unknown;
}

interface TurnResponse {
  turn?: { id?: unknown };
}

interface TokenUsage {
  inputTokens?: unknown;
  cachedInputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
}

let runtimeSlot: { command: string; runtime: CodexAppServerRuntime } | null = null;
const activeThreadTurns = new Map<string, Promise<void>>();
const configuredRequestPolicies = new WeakSet<CodexAppServerRuntime>();
let managedPluginToolHandler: ((params: unknown, generation: number) => Promise<unknown>) | null = null;

export function configureManagedPluginToolHandler(handler: (params: unknown, generation: number) => Promise<unknown>): void {
  managedPluginToolHandler = handler;
  if (runtimeSlot) configureUnattendedRequests(runtimeSlot.runtime, true);
}

function unavailableHumanInput(kind: string): never {
  throw new Error(`${kind} is unavailable in unattended Peon sessions`);
}

const unattendedRequestHandlers: Record<string, () => unknown> = {
  "item/commandExecution/requestApproval": () => ({ decision: "decline" }),
  "item/fileChange/requestApproval": () => ({ decision: "decline" }),
  "item/permissions/requestApproval": () => unavailableHumanInput("Additional permission approval"),
  "item/tool/requestUserInput": () => unavailableHumanInput("User input"),
  "mcpServer/elicitation/request": () => ({ action: "decline", content: null, _meta: null }),
  "item/tool/call": () => ({
    contentItems: [{ type: "inputText", text: "Dynamic tool calls are unavailable in unattended Peon sessions." }],
    success: false,
  }),
  applyPatchApproval: () => ({ decision: "denied" }),
  execCommandApproval: () => ({ decision: "denied" }),
};

function configureUnattendedRequests(runtime: CodexAppServerRuntime, refresh = false): void {
  if (configuredRequestPolicies.has(runtime) && !refresh) return;
  configuredRequestPolicies.add(runtime);
  for (const [method, handler] of Object.entries(unattendedRequestHandlers)) {
    runtime.registerRequestHandler(method, handler);
  }
  if (managedPluginToolHandler) runtime.registerRequestHandler(
    "item/tool/call",
    (params, context) => managedPluginToolHandler!(params, context.generation),
    MANAGED_PLUGIN_INQUIRY_TTL_MS + 5_000,
  );
}

function sandboxMode(opts: AgentRunOptions): "read-only" | "danger-full-access" {
  return opts.permissionMode === "plan" ? "read-only" : "danger-full-access";
}

function sandboxPolicy(opts: AgentRunOptions): Record<string, unknown> {
  return opts.permissionMode === "plan"
    ? { type: "readOnly", networkAccess: false }
    : { type: "dangerFullAccess" };
}

function appServerMcpConfig(configPath: string | undefined): Record<string, unknown> | undefined {
  if (!configPath) return undefined;
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<string, { url?: unknown; headers?: unknown }>;
  };
  const servers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || typeof server.url !== "string") continue;
    const headers = server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)
      ? Object.fromEntries(Object.entries(server.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    servers[name] = { url: server.url, env_http_headers: {}, http_headers: headers };
  }
  return Object.keys(servers).length ? { mcp_servers: servers } : undefined;
}

function userInput(prompt: string, attachments: unknown[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [{ type: "text", text: prompt, text_elements: [] }];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") continue;
    const value = attachment as Record<string, unknown>;
    if (typeof value.path === "string" && typeof value.mimetype === "string" && value.mimetype.startsWith("image/")) {
      input.push({ type: "localImage", path: value.path });
    }
  }
  return input;
}

function warnForOutboundPayload(
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
  emit: (event: AgentEvent) => void,
): void {
  const currentBytes = Buffer.byteLength(JSON.stringify({
    jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER, method, params,
  }) + "\n", "utf8");
  const limitBytes = CODEX_APP_SERVER_LIMITS.maxPayloadBytes;
  if (currentBytes < limitBytes * 0.7) return;
  emit({
    type: "warning",
    sessionId,
    code: "payload_near_limit",
    source: `app_server:${method}`,
    currentBytes,
    limitBytes,
    message: `The ${method} request is approaching the ${Math.round(limitBytes / 1024 / 1024)} MiB app-server transport limit.`,
  });
}

export function getCodexAppServerRuntime(command: string): CodexAppServerRuntime {
  if (runtimeSlot?.command === command) return runtimeSlot.runtime;
  if (runtimeSlot) {
    const status = runtimeSlot.runtime.getHealth().status;
    if (!["stopped", "failed", "incompatible"].includes(status)) {
      throw new Error(`Codex app-server is already running with command "${runtimeSlot.command}"; restart Peon before changing codexCommand`);
    }
    void runtimeSlot.runtime.stop();
  }
  // The driver sends runtimeWorkspaceRoots on thread/turn startup so Codex can
  // scope runtime-backed tools to the session workspace. App-server guards
  // that parameter behind its experimental API capability, so advertise the
  // capability before using it.
  const runtime = new CodexAppServerRuntime({ command, experimentalApi: true });
  runtimeSlot = { command, runtime };
  return runtime;
}

export function codexAppServerHealth(command?: string): unknown {
  if (command && runtimeSlot?.command !== command) return { status: "stopped" };
  return runtimeSlot?.runtime.getHealth() ?? { status: "stopped" };
}

export async function shutdownCodexAppServerRuntime(): Promise<void> {
  const current = runtimeSlot;
  runtimeSlot = null;
  if (current) await current.runtime.stop();
}

export async function forkCodexAppServerThread(input: {
  command: string;
  backendSessionId: string;
  targetSessionId: string;
  cwd: string;
  lastTurnId?: string;
}, runtimeOverride?: CodexAppServerRuntime): Promise<{ backendSessionId: string }> {
  const runtime = runtimeOverride ?? getCodexAppServerRuntime(input.command);
  await runtime.start();
  const response = await runtime.request<ThreadResponse>("thread/fork", {
    threadId: input.backendSessionId,
    ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
  });
  const backendSessionId = response.thread?.id;
  if (typeof backendSessionId !== "string" || !backendSessionId) {
    throw new Error("Codex app-server returned no thread id for fork");
  }
  return { backendSessionId };
}

export async function reconcileCodexAppServerTurn(
  input: AgentReconcileInput,
  runtimeOverride?: CodexAppServerRuntime,
): Promise<AgentReconcileResult> {
  if (!input.backendSessionId) {
    return { status: "unknown", backendTurnId: input.backendTurnId, runtimeGeneration: null, detail: "missing Codex thread id" };
  }
  const runtime = runtimeOverride ?? getCodexAppServerRuntime(input.command);
  await runtime.start();
  const generation = runtime.getHealth().generation;
  const response = await runtime.request<{ thread?: { turns?: unknown } }>("thread/read", {
    threadId: input.backendSessionId,
    includeTurns: true,
  });
  const turns = Array.isArray(response.thread?.turns)
    ? response.thread.turns.filter((turn): turn is Record<string, unknown> => !!turn && typeof turn === "object")
    : [];
  const turn = (input.backendTurnId
    ? turns.find((candidate) => candidate.id === input.backendTurnId)
    : turns.at(-1)) ?? null;
  if (!turn || typeof turn.id !== "string") {
    return {
      status: "unknown", backendTurnId: input.backendTurnId, runtimeGeneration: generation,
      detail: input.backendTurnId ? "persisted Codex turn is absent from thread history" : "Codex thread has no turn history",
    };
  }
  const status = turn.status;
  if (status === "inProgress") {
    await runtime.request("turn/interrupt", { threadId: input.backendSessionId, turnId: turn.id });
    return { status: "interrupted", backendTurnId: turn.id, runtimeGeneration: generation };
  }
  if (status === "completed" || status === "interrupted" || status === "failed") {
    return { status, backendTurnId: turn.id, runtimeGeneration: generation };
  }
  return { status: "unknown", backendTurnId: turn.id, runtimeGeneration: generation, detail: `unsupported Codex turn status: ${String(status)}` };
}

async function acquireThread(threadId: string): Promise<() => void> {
  const previous = activeThreadTurns.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  activeThreadTurns.set(threadId, queued);
  await previous;
  return () => {
    release();
    if (activeThreadTurns.get(threadId) === queued) activeThreadTurns.delete(threadId);
  };
}

function timestamp(ms: unknown): Pick<AgentEvent, "sourceTimestamp"> {
  return typeof ms === "number" && Number.isFinite(ms) ? { sourceTimestamp: new Date(ms).toISOString() } : {};
}

function itemEvents(item: Record<string, unknown>, opts: AgentRunOptions, completedAtMs: unknown): AgentEvent[] {
  const meta = timestamp(completedAtMs);
  if (item.type === "agentMessage" && typeof item.text === "string") {
    return opts.outcomeSchema ? [] : [{
      type: "assistant",
      message: { model: opts.model, content: [{ type: "text", text: item.text }] },
      ...meta,
    }];
  }
  if (item.type === "commandExecution") {
    const id = String(item.id ?? "command");
    const guarded = guardToolOutput(opts.sessionId, id, String(item.aggregatedOutput ?? ""));
    return [
      { type: "assistant", message: { content: [{ type: "tool_use", id, name: codexCommandToolName(item.command), input: { command: item.command, cwd: item.cwd } }] }, ...meta },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: guarded.content }] }, ...meta },
      ...(guarded.warning ? [{ type: "warning", ...guarded.warning } as AgentEvent] : []),
    ];
  }
  if (item.type === "fileChange") {
    const id = String(item.id ?? "file-change");
    const legacyItem = { ...item, changes: item.changes, status: item.status };
    const changes = normalizeCodexFileChanges(legacyItem, opts.cwd);
    const groups = changes.length ? changes.map((change) => [change]) : [[]];
    return groups.flatMap((group, index) => {
      const toolId = index === 0 ? id : `${id}:${index + 1}`;
      const events: AgentEvent[] = [{
        type: "assistant",
        message: { content: [{ type: "tool_use", id: toolId, name: "Edit", input: { changes: group, ...(item.status === "failed" ? { partial: true } : {}) } }] },
        ...meta,
      }];
      if (item.status === "failed" || item.status === "declined") events.push({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: toolId, content: `File edit ${String(item.status)}` }] },
        ...meta,
      });
      return events;
    });
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const id = String(item.id ?? "tool");
    const server = typeof item.server === "string" ? `${item.server}:` : "";
    const result = item.result ?? item.contentItems ?? item.error ?? "";
    const content = typeof result === "string" ? result : JSON.stringify(result);
    const guarded = guardToolOutput(opts.sessionId, id, content, "tool_output");
    return [
      { type: "assistant", message: { content: [{ type: "tool_use", id, name: `${server}${String(item.tool ?? "Tool")}`, input: item.arguments ?? {} }] }, ...meta },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: guarded.content }] }, ...meta },
      ...(guarded.warning ? [{ type: "warning", ...guarded.warning } as AgentEvent] : []),
    ];
  }
  return [];
}

export function createCodexAppServerRun(opts: AgentRunOptions, runtime: CodexAppServerRuntime): AgentRun {
  configureUnattendedRequests(runtime);
  const emitter = new EventEmitter();
  let threadId = opts.backendSessionId ?? null;
  let turnId: string | null = null;
  let generation = 0;
  let lastMessage = "";
  let usage: TokenUsage = {};
  let actualModel: string | null = opts.model ?? null;
  let releaseThread: (() => void) | null = null;
  let finished = false;
  let interrupted = false;
  let interruptPending = false;
  let steerInFlight = false;
  const fileChangePatches = new Map<string, Record<string, unknown>[]>();
  const startedAt = Date.now();
  let unsubscribeNotification = () => {};
  let runtimeErrorListener: ((error: CodexAppServerError) => void) | null = null;

  const emit = (event: AgentEvent) => emitter.emit("event", event);
  const exit = (value: AgentExit) => {
    if (finished) return;
    finished = true;
    unsubscribeNotification();
    if (runtimeErrorListener) runtime.off("runtimeError", runtimeErrorListener);
    fileChangePatches.clear();
    releaseThread?.();
    releaseThread = null;
    setImmediate(() => emitter.emit("exit", value));
  };
  const fail = (message: string) => {
    if (finished) return;
    emit({
      type: "result", subtype: "error", is_error: true, errors: [message],
      ...(turnId ? { backend_turn_id: turnId, backend_turn_status: "failed" } : {}),
      ...(generation ? { runtime_generation: generation } : {}),
    });
    exit({ code: 1, signal: null, spawnError: null });
  };

  const onNotification = (notification: CodexAppServerNotification) => {
    if (finished || notification.generation !== generation || !threadId || notification.threadId !== threadId) return;
    const params = notification.params && typeof notification.params === "object" ? notification.params as Record<string, unknown> : {};
    if (notification.turnId && !turnId) return;
    if (turnId && notification.turnId && notification.turnId !== turnId) return;
    if (notification.method === "item/fileChange/patchUpdated") {
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      const changes = Array.isArray(params.changes)
        ? params.changes.filter((change): change is Record<string, unknown> => !!change && typeof change === "object")
        : [];
      if (itemId) fileChangePatches.set(itemId, changes.map((change) => ({ ...change })));
      return;
    }
    if (notification.method === "item/completed") {
      const item = params.item && typeof params.item === "object" ? params.item as Record<string, unknown> : null;
      if (!item) return;
      const itemId = typeof item.id === "string" ? item.id : null;
      const patchChanges = itemId ? fileChangePatches.get(itemId) : undefined;
      if (itemId) fileChangePatches.delete(itemId);
      const completedItem = item.type === "fileChange" && patchChanges
        ? { ...item, changes: patchChanges }
        : item;
      if (completedItem.type === "agentMessage" && typeof completedItem.text === "string") lastMessage = completedItem.text;
      for (const event of itemEvents(completedItem, opts, params.completedAtMs)) emit(event);
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      const tokenUsage = params.tokenUsage && typeof params.tokenUsage === "object" ? params.tokenUsage as Record<string, unknown> : {};
      usage = tokenUsage.last && typeof tokenUsage.last === "object" ? tokenUsage.last as TokenUsage : {};
      const currentTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : null;
      const limitTokens = typeof tokenUsage.modelContextWindow === "number" ? tokenUsage.modelContextWindow : null;
      if (currentTokens !== null && limitTokens !== null && currentTokens >= 0 && limitTokens > 0) {
        emitter.emit("context", { currentTokens, limitTokens } satisfies AgentContextUsage);
      }
      return;
    }
    if (notification.method === "model/rerouted") {
      if (typeof params.toModel === "string" && params.toModel) actualModel = params.toModel;
      return;
    }
    if (notification.method === "error") {
      const error = params.error && typeof params.error === "object" ? params.error as Record<string, unknown> : {};
      if (params.willRetry !== true) fail(String(error.message ?? "Codex app-server turn failed"));
      return;
    }
    if (notification.method !== "turn/completed") return;
    const turn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : {};
    if (turnId && typeof turn.id === "string" && turn.id !== turnId) return;
    if (interrupted || turn.status === "interrupted") {
      exit({ code: null, signal: "SIGTERM", spawnError: null });
      return;
    }
    if (turn.status === "failed") {
      const error = turn.error && typeof turn.error === "object" ? turn.error as Record<string, unknown> : {};
      fail(String(error.message ?? "Codex app-server turn failed"));
      return;
    }
    let structuredOutput: unknown;
    if (opts.outcomeSchema) {
      try { structuredOutput = JSON.parse(lastMessage); } catch { structuredOutput = undefined; }
    }
    emit({
      type: "result", subtype: "success", is_error: false, num_turns: 1,
      duration_ms: typeof turn.durationMs === "number" ? turn.durationMs : Date.now() - startedAt,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cachedInputTokens,
      },
      result: lastMessage,
      ...(structuredOutput ? { structured_output: structuredOutput } : {}),
      ...(actualModel ? { model: actualModel } : {}),
      ...(turnId ? { backend_turn_id: turnId, backend_turn_status: "completed" } : {}),
      ...(generation ? { runtime_generation: generation } : {}),
      ...timestamp(typeof turn.completedAt === "number" ? turn.completedAt * 1_000 : undefined),
    });
    exit({ code: 0, signal: null, spawnError: null });
  };

  queueMicrotask(async () => {
    try {
      await runtime.start();
      if (finished) return;
      generation = runtime.getHealth().generation;
      unsubscribeNotification = runtime.onNotification(onNotification);
      runtimeErrorListener = (error) => {
        if (!finished && generation === runtime.getHealth().generation) fail(error.message);
      };
      runtime.on("runtimeError", runtimeErrorListener);

      let thread: ThreadResponse;
      const config = appServerMcpConfig(opts.mcpConfigPath);
      const threadOverrides = {
        cwd: opts.cwd,
        runtimeWorkspaceRoots: [opts.cwd],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: sandboxMode(opts),
        developerInstructions: opts.systemPromptAppend,
        ...(config ? { config } : {}),
      };
      if (opts.resume) {
        if (!threadId) throw new Error("codex app-server session cannot resume before its thread id is known");
        // MCP bindings are immutable turn leases. A resumed Codex thread keeps
        // the MCP servers it was created with even when thread/resume carries a
        // different config, leaving new packages invisible and old binding URLs
        // stale. Forking preserves the complete native conversation while
        // constructing a thread against this turn's exact MCP snapshot.
        if (config) {
          const params = { threadId, ...threadOverrides, threadSource: "peon" };
          warnForOutboundPayload(opts.sessionId, "thread/fork", params, emit);
          thread = await runtime.request<ThreadResponse>("thread/fork", params);
          const reboundThreadId = thread.thread?.id;
          if (typeof reboundThreadId !== "string" || !reboundThreadId) throw new Error("Codex app-server thread/fork returned no thread id");
          threadId = reboundThreadId;
          emit({ type: "system", subtype: "init", session_id: threadId, model: typeof thread.model === "string" ? thread.model : opts.model });
        } else {
          const params = { threadId, ...threadOverrides };
          warnForOutboundPayload(opts.sessionId, "thread/resume", params, emit);
          thread = await runtime.request<ThreadResponse>("thread/resume", params);
        }
      } else {
        const params = {
          ...threadOverrides,
          ...(opts.model ? { model: opts.model } : {}),
          threadSource: "peon",
        };
        warnForOutboundPayload(opts.sessionId, "thread/start", params, emit);
        thread = await runtime.request<ThreadResponse>("thread/start", params);
        const nativeThreadId = thread.thread?.id;
        if (typeof nativeThreadId !== "string" || !nativeThreadId) throw new Error("Codex app-server thread/start returned no thread id");
        threadId = nativeThreadId;
        emit({ type: "system", subtype: "init", session_id: threadId, model: typeof thread.model === "string" ? thread.model : opts.model });
      }
      // A resumed thread answers with the model it was created with, which is
      // not what this turn asked for: `turn/start` below carries the override
      // and decides. Letting the thread's history rename the run is what made a
      // follow-up on a different model report — and bill — the old one. A
      // fresh thread keeps taking the server's canonical answer, and
      // `model/rerouted` still outranks both.
      if ((!opts.resume || !opts.model) && typeof thread.model === "string" && thread.model) actualModel = thread.model;
      if (!threadId || finished) return;
      releaseThread = await acquireThread(threadId);
      if (finished) { releaseThread(); releaseThread = null; return; }
      const turnParams = {
        threadId,
        input: userInput(opts.prompt, opts.attachments ?? []),
        cwd: opts.cwd,
        runtimeWorkspaceRoots: [opts.cwd],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: sandboxPolicy(opts),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
        ...(opts.outcomeSchema ? { outputSchema: opts.outcomeSchema } : {}),
      };
      warnForOutboundPayload(opts.sessionId, "turn/start", turnParams, emit);
      const response = await runtime.request<TurnResponse>("turn/start", turnParams);
      const nativeTurnId = response.turn?.id;
      if (typeof nativeTurnId !== "string" || !nativeTurnId) throw new Error("Codex app-server turn/start returned no turn id");
      turnId = nativeTurnId;
      opts.onBackendState?.({ turnId, status: "inProgress", runtimeGeneration: generation });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

  return {
    emitter,
    steer(input: AgentSteerInput) {
      if (
        finished || interrupted || steerInFlight || !threadId || !turnId ||
        runtime.getHealth().status !== "healthy" || input.permissionMode || input.model || input.reasoningEffort
      ) return undefined;
      steerInFlight = true;
      const expectedTurnId = turnId;
      const params = {
        threadId,
        expectedTurnId,
        input: userInput(input.prompt, input.attachments),
      };
      warnForOutboundPayload(opts.sessionId, "turn/steer", params, emit);
      return runtime.request<{ turnId?: unknown }>("turn/steer", params).then((response) => {
        if (response.turnId !== expectedTurnId) throw new Error("Codex app-server turn/steer acknowledged an unexpected turn");
      }).finally(() => {
        steerInFlight = false;
      });
    },
    kill() {
      if (finished || interruptPending) return;
      interrupted = true;
      interruptPending = true;
      if (threadId && turnId && runtime.getHealth().status === "healthy") {
        runtime.request("turn/interrupt", { threadId, turnId }).catch(() => {
          exit({ code: null, signal: "SIGTERM", spawnError: null });
        });
      } else {
        exit({ code: null, signal: "SIGTERM", spawnError: null });
      }
    },
  };
}

export function runCodexAppServer(opts: AgentRunOptions): AgentRun {
  return createCodexAppServerRun(opts, getCodexAppServerRuntime(opts.command));
}
