import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { guardToolOutput, type AgentContextUsage } from "../sessions/index.js";
import type { AgentEvent, AgentExit, AgentRun, AgentRunOptions, ModelInfo, ReasoningEffortInfo } from "./registry.js";
import { startOpencodeServer, withOpencodeServer, type OpencodeServer } from "./opencodeServer.js";

// Every Peon model id is an OpenRouter model id (`anthropic/claude-sonnet-4.5`).
export const OPENCODE_PROVIDER_ID = "openrouter";
const SETTLE_AFTER_IDLE_MS = 300;
const ABORT_GRACE_MS = 5_000;

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// --- configuration ----------------------------------------------------------

function mcpConfig(configPath: string | undefined): Json | undefined {
  if (!configPath) return undefined;
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: Record<string, { url?: unknown; headers?: unknown }> };
  const servers: Json = {};
  for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || typeof server.url !== "string") continue;
    const headers = object(server.headers)
      ? Object.fromEntries(Object.entries(server.headers as Json).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    servers[name] = { type: "remote", url: server.url, headers, enabled: true };
  }
  return Object.keys(servers).length ? servers : undefined;
}

// Per-turn opencode configuration. Peon is unattended: nothing may stop to ask
// for permission, and sharing stays off.
export function opencodeTurnConfig(opts: Pick<AgentRunOptions, "mcpConfigPath">): Json {
  const mcp = mcpConfig(opts.mcpConfigPath);
  return {
    autoupdate: false,
    share: "disabled",
    permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow", doom_loop: "allow" },
    ...(mcp ? { mcp } : {}),
  };
}

const ALLOW_ALL = [{ permission: "*", pattern: "*", action: "allow" }];

// opencode 1.19 cannot read back a message stored with a JSON-schema `format`
// (listing and forking such a session fail), so outcomes are requested in the
// system prompt and parsed from the final text instead.
export function outcomeInstructions(schema: Record<string, unknown>): string {
  return [
    "When you have finished, your final message must be only a single JSON object, with no prose and no code fence,",
    `that matches this JSON schema: ${JSON.stringify(schema)}`,
  ].join(" ");
}

export function parseOutcomeText(value: string): unknown {
  const trimmed = value.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  for (const candidate of [trimmed, fenced, trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (object(parsed)) return parsed;
    } catch {
      // Try the next shape.
    }
  }
  return undefined;
}

function promptParts(prompt: string, attachments: unknown[]): Json[] {
  const parts: Json[] = [{ type: "text", text: prompt }];
  for (const attachment of attachments) {
    const value = object(attachment);
    if (!value || typeof value.path !== "string" || typeof value.mimetype !== "string") continue;
    if (!value.mimetype.startsWith("image/") && value.mimetype !== "application/pdf") continue;
    parts.push({
      type: "file",
      mime: value.mimetype,
      url: pathToFileURL(value.path).href,
      ...(typeof value.name === "string" ? { filename: value.name } : {}),
    });
  }
  return parts;
}

// --- event normalization ----------------------------------------------------

const TOOL_NAMES: Record<string, string> = {
  bash: "Bash", read: "Read", edit: "Edit", write: "Write", multiedit: "MultiEdit", patch: "Edit", apply_patch: "Edit",
  glob: "Glob", grep: "Grep", list: "LS", webfetch: "WebFetch", websearch: "WebSearch",
  todowrite: "TodoWrite", todoread: "TodoRead", task: "Task", skill: "Skill",
};

// Map opencode's tool vocabulary onto the canonical (Claude-shaped) one the
// clients render, so Edit/Write/Bash cards look the same for every harness.
export function canonicalTool(tool: string, input: Json): { name: string; input: Json } {
  const name = TOOL_NAMES[tool] ?? tool;
  const filePath = typeof input.filePath === "string" ? input.filePath : undefined;
  if (tool === "edit") return { name, input: { file_path: filePath, old_string: input.oldString, new_string: input.newString, ...(input.replaceAll ? { replace_all: true } : {}) } };
  if (tool === "write") return { name, input: { file_path: filePath, content: input.content } };
  if (tool === "read") return { name, input: { file_path: filePath, ...(input.offset === undefined ? {} : { offset: input.offset }), ...(input.limit === undefined ? {} : { limit: input.limit }) } };
  return { name, input };
}

interface MessageUsage {
  model: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  total: number;
}

function messageUsage(info: Json): MessageUsage | null {
  const tokens = object(info.tokens);
  if (!tokens) return null;
  const cache = object(tokens.cache) ?? {};
  const n = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  const usage = {
    model: typeof info.modelID === "string" ? info.modelID : "unknown",
    input: n(tokens.input), output: n(tokens.output), reasoning: n(tokens.reasoning),
    cacheRead: n(cache.read), cacheWrite: n(cache.write),
    cost: typeof info.cost === "number" && Number.isFinite(info.cost) && info.cost >= 0 ? info.cost : 0,
    total: 0,
  };
  usage.total = n(tokens.total) || usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
  return usage;
}

// opencode reports final counts per assistant message; a turn is the sum of
// the messages it produced. Cache reads and writes are disjoint from input,
// and reasoning is reported beside output, so it is folded into output.
export class OpencodeUsage {
  private readonly messages = new Map<string, MessageUsage>();

  observe(messageId: string, usage: MessageUsage): boolean {
    const previous = this.messages.get(messageId);
    if (previous && JSON.stringify(previous) === JSON.stringify(usage)) return false;
    this.messages.set(messageId, usage);
    return true;
  }

  cost(): number {
    let total = 0;
    for (const usage of this.messages.values()) total += usage.cost;
    return total;
  }

  report(): Json {
    const wire = (rows: MessageUsage[]) => {
      const sum = (key: keyof MessageUsage) => rows.reduce((acc, row) => acc + (row[key] as number), 0);
      return {
        input_tokens: sum("input"),
        output_tokens: sum("output") + sum("reasoning"),
        cache_read_input_tokens: sum("cacheRead"),
        cache_creation_input_tokens: sum("cacheWrite"),
        reasoning_output_tokens: sum("reasoning"),
      };
    };
    const rows = [...this.messages.values()];
    const byModel = new Map<string, MessageUsage[]>();
    for (const row of rows) byModel.set(row.model, [...byModel.get(row.model) ?? [], row]);
    return {
      usage: wire(rows),
      usage_by_model: Object.fromEntries([...byModel].map(([model, list]) => [model, wire(list)])),
      usage_quality: "reported",
      usage_source: "opencode-message-tokens-v1",
      total_cost_usd: this.cost(),
    };
  }
}

function errorMessage(error: unknown): string | null {
  const value = object(error);
  if (!value) return null;
  const data = object(value.data);
  const message = text(data?.message) ?? text(value.message);
  const name = text(value.name);
  return message ? (name && name !== "UnknownError" ? `${name}: ${message}` : message) : name;
}

// --- model catalog ----------------------------------------------------------

const contextLimits = new Map<string, number>();

export function opencodeContextLimit(model: string | undefined): number | null {
  return model ? contextLimits.get(model) ?? null : null;
}

function effortLabel(id: string): string {
  return id === "xhigh" ? "Extra high" : id[0]?.toUpperCase() + id.slice(1);
}

// Preferred defaults, in order, matched as id prefixes against the catalog.
const DEFAULT_MODEL_PREFIXES = ["anthropic/claude-sonnet", "openai/gpt-5", "google/gemini-3-pro"];

export function normalizeOpencodeProviders(response: unknown): ModelInfo[] {
  const providers = Array.isArray(object(response)?.providers) ? (object(response)!.providers as unknown[]) : [];
  const openrouter = providers.map(object).find((provider) => provider?.id === OPENCODE_PROVIDER_ID);
  const models = Object.values(object(openrouter?.models) ?? {}).map(object).filter((model): model is Json => {
    if (!model || typeof model.id !== "string") return false;
    const capabilities = object(model.capabilities);
    return capabilities?.toolcall === true && model.status !== "deprecated";
  });
  models.sort((a, b) => String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")) || String(a.id).localeCompare(String(b.id)));
  const ids = models.map((model) => String(model.id));
  const defaultId = DEFAULT_MODEL_PREFIXES.map((prefix) => ids.find((id) => id.startsWith(prefix))).find(Boolean) ?? ids[0];
  return models.map((model) => {
    const id = String(model.id);
    const limit = object(model.limit);
    if (typeof limit?.context === "number" && limit.context > 0) contextLimits.set(id, limit.context);
    const efforts: ReasoningEffortInfo[] = Object.keys(object(model.variants) ?? {})
      .filter((variant) => /^[a-z][a-z0-9_-]{0,31}$/.test(variant))
      .map((variant) => ({ id: variant, label: effortLabel(variant) }));
    return {
      id,
      label: text(model.name) ?? id,
      ...(id === defaultId ? { default: true as const } : {}),
      ...(efforts.length ? { reasoningEfforts: efforts } : {}),
    };
  });
}

export async function discoverOpencodeModels(command: string): Promise<ModelInfo[]> {
  const response = await withOpencodeServer({ command, cwd: os.tmpdir(), config: { autoupdate: false, share: "disabled" } },
    (server) => server.request("GET", "/config/providers"));
  const models = normalizeOpencodeProviders(response);
  if (!models.length) throw new Error("opencode lists no OpenRouter models; check the OpenRouter API key");
  return models;
}

// --- fork -------------------------------------------------------------------

export async function forkOpencodeSession(input: { command: string; backendSessionId: string; cwd: string }): Promise<{ backendSessionId: string }> {
  const forked = await withOpencodeServer({ command: input.command, cwd: input.cwd, config: { autoupdate: false, share: "disabled" } },
    (server) => server.request<Json>("POST", `/session/${encodeURIComponent(input.backendSessionId)}/fork`, { body: {} }));
  if (typeof forked?.id !== "string" || !forked.id) throw new Error("opencode returned no session id for fork");
  return { backendSessionId: forked.id };
}

// --- run --------------------------------------------------------------------

export function runOpencode(opts: AgentRunOptions, start: typeof startOpencodeServer = startOpencodeServer): AgentRun {
  const emitter = new EventEmitter();
  const usage = new OpencodeUsage();
  const startedAt = Date.now();
  const stream = new AbortController();
  const emittedParts = new Set<string>();
  let server: OpencodeServer | null = null;
  let sessionId = opts.backendSessionId ?? null;
  let finished = false;
  let interrupted = false;
  let busySeen = false;
  let lastText = "";
  let failure: string | null = null;
  let actualModel: string | null = opts.model ?? null;
  let settleTimer: NodeJS.Timeout | null = null;

  const emit = (event: AgentEvent) => emitter.emit("event", event);
  const exit = (value: AgentExit) => {
    if (finished) return;
    finished = true;
    if (settleTimer) clearTimeout(settleTimer);
    stream.abort();
    const current = server;
    server = null;
    void (current?.stop() ?? Promise.resolve()).finally(() => setImmediate(() => emitter.emit("exit", value)));
  };
  const fail = (message: string) => {
    if (finished) return;
    emit({ type: "result", subtype: "error", is_error: true, errors: [message], ...usage.report(), duration_ms: Date.now() - startedAt });
    exit({ code: 1, signal: null, spawnError: null });
  };
  const complete = () => {
    if (finished) return;
    if (interrupted) {
      emit({ type: "system", subtype: "usage", ...usage.report(), duration_ms: Date.now() - startedAt });
      exit({ code: null, signal: "SIGTERM", spawnError: null });
      return;
    }
    if (failure) { fail(failure); return; }
    const structured = opts.outcomeSchema ? parseOutcomeText(lastText) : undefined;
    emit({
      type: "result", subtype: "success", is_error: false, num_turns: 1,
      duration_ms: Date.now() - startedAt,
      ...usage.report(),
      result: lastText,
      ...(structured ? { structured_output: structured } : {}),
      ...(actualModel ? { model: actualModel } : {}),
    });
    exit({ code: 0, signal: null, spawnError: null });
  };

  const onPart = (part: Json) => {
    const id = typeof part.id === "string" ? part.id : null;
    if (!id || emittedParts.has(id)) return;
    if (part.type === "text") {
      const time = object(part.time);
      if (part.synthetic === true || typeof time?.end !== "number" || typeof part.text !== "string" || !part.text.trim()) return;
      emittedParts.add(id);
      lastText = part.text;
      if (!opts.outcomeSchema) emit({ type: "assistant", message: { model: actualModel ?? undefined, content: [{ type: "text", text: part.text }] } });
      return;
    }
    if (part.type !== "tool") return;
    const state = object(part.state);
    if (state?.status !== "completed" && state?.status !== "error") return;
    emittedParts.add(id);
    const callId = typeof part.callID === "string" && part.callID ? part.callID : id;
    const tool = canonicalTool(String(part.tool ?? "tool"), object(state.input) ?? {});
    const isError = state.status === "error";
    const output = isError ? String(state.error ?? "Tool failed") : String(state.output ?? "");
    const guarded = guardToolOutput(opts.sessionId, callId, output, tool.name === "Bash" ? "command_output" : "tool_output");
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: callId, name: tool.name, input: tool.input }] } });
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: callId, content: guarded.content, ...(isError ? { is_error: true } : {}) }] } });
    if (guarded.warning) emit({ type: "warning", ...guarded.warning } as AgentEvent);
  };

  const onAssistantMessage = (info: Json) => {
    if (typeof info.modelID === "string" && info.modelID) actualModel = info.modelID;
    const time = object(info.time);
    if (info.error) {
      const message = errorMessage(info.error);
      if (message && !/MessageAbortedError/.test(message)) failure = message;
    }
    if (typeof time?.completed !== "number" || typeof info.id !== "string") return;
    const counted = messageUsage(info);
    if (!counted || !usage.observe(info.id, counted)) return;
    emit({ type: "system", subtype: "usage", ...usage.report(), duration_ms: Date.now() - startedAt });
    const limitTokens = opencodeContextLimit(counted.model);
    if (limitTokens && counted.total > 0) emitter.emit("context", { currentTokens: counted.total, limitTokens } satisfies AgentContextUsage);
    if (opts.maxBudgetUsd && usage.cost() > opts.maxBudgetUsd && !interrupted) {
      failure = `Turn cost $${usage.cost().toFixed(4)} exceeded the $${opts.maxBudgetUsd} budget`;
      void server?.request("POST", `/session/${encodeURIComponent(sessionId!)}/abort`).catch(() => {});
    }
  };

  const onEvent = (event: Json) => {
    const properties = object(event.properties) ?? {};
    if (properties.sessionID !== sessionId) return;
    if (event.type === "session.status") {
      const status = object(properties.status);
      if (status?.type === "busy") busySeen = true;
      if (status?.type === "retry" && typeof status.message === "string") {
        emit({ type: "stderr", text: `opencode is retrying (attempt ${String(status.attempt ?? "?")}): ${status.message}` });
      }
      return;
    }
    if (event.type === "message.part.updated") {
      const part = object(properties.part);
      if (part) onPart(part);
      return;
    }
    if (event.type === "message.updated") {
      const info = object(properties.info);
      if (info?.role === "assistant") onAssistantMessage(info);
      return;
    }
    if (event.type === "session.error") {
      const message = errorMessage(properties.error);
      if (message && !/MessageAbortedError/.test(message)) failure = message;
      return;
    }
    if (event.type === "session.idle" && busySeen) {
      // The last message update can trail the idle signal by a few
      // milliseconds; let it land before reporting the turn.
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(complete, SETTLE_AFTER_IDLE_MS);
    }
  };

  queueMicrotask(async () => {
    try {
      if (!opts.model) throw new Error("No OpenRouter model selected for this opencode session");
      server = await start({ command: opts.command, cwd: opts.cwd, config: opencodeTurnConfig(opts) });
      if (finished) { await server.stop(); return; }
      server.onExit((code, signal) => {
        if (!finished) fail(`opencode serve exited unexpectedly (${signal ?? `code ${String(code)}`})`);
      });
      if (opts.resume) {
        if (!sessionId) throw new Error("opencode session cannot resume before its session id is known");
        await server.request("GET", `/session/${encodeURIComponent(sessionId)}`);
      } else {
        const created = await server.request<Json>("POST", "/session", { body: { permission: ALLOW_ALL } });
        if (typeof created?.id !== "string" || !created.id) throw new Error("opencode returned no session id");
        sessionId = created.id;
        emit({ type: "system", subtype: "init", session_id: sessionId, model: opts.model });
      }
      const events = server.events(stream.signal);
      // Subscribe before prompting so no event of this turn is missed.
      const first = events.next();
      void (async () => {
        try {
          let next = await first;
          while (!next.done && !finished) {
            onEvent(next.value);
            next = await events.next();
          }
          if (!finished && !stream.signal.aborted) fail("opencode event stream closed before the turn finished");
        } catch (error) {
          if (!finished) fail(error instanceof Error ? error.message : String(error));
        }
      })();
      const system = [opts.systemPromptAppend, opts.outcomeSchema ? outcomeInstructions(opts.outcomeSchema) : ""].filter(Boolean).join("\n\n");
      await server.request("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        body: {
          model: { providerID: OPENCODE_PROVIDER_ID, modelID: opts.model },
          ...(opts.permissionMode === "plan" ? { agent: "plan" } : {}),
          ...(system ? { system } : {}),
          ...(opts.reasoningEffort ? { variant: opts.reasoningEffort } : {}),
          parts: promptParts(opts.prompt, opts.attachments ?? []),
        },
      });
      opts.onAccepted?.();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

  return {
    emitter,
    kill() {
      if (finished || interrupted) return;
      interrupted = true;
      const current = server;
      if (!current || !sessionId) { exit({ code: null, signal: "SIGTERM", spawnError: null }); return; }
      // Abort lets opencode close the turn cleanly (session.idle follows);
      // stop the server regardless if it does not within the grace period.
      void current.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`).catch(() => {});
      setTimeout(() => exit({ code: null, signal: "SIGTERM", spawnError: null }), ABORT_GRACE_MS).unref?.();
    },
  };
}
