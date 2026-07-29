import type { EventEmitter } from "node:events";
import path from "node:path";
import { storedTimestampMetadata } from "../agentEventMetadata.js";
import { claudeCodeAuth } from "../claudeCodeAuth.js";
import { CODEX_OUTCOME_SCHEMA, OUTCOME_SCHEMA } from "../sessionPrompts.js";
import type { DaemonSettings } from "../settings/index.js";
import { normalizeClaudeCodeEvent, runClaudeCode } from "./claudeCode.js";
import { runCodex } from "./codex.js";
import { codexAppServerHealth, reconcileCodexAppServerTurn, runCodexAppServer, shutdownCodexAppServerRuntime } from "./codexAppServer.js";
import { getClaudeQuota, getCodexQuota, type ProviderQuotaSnapshot } from "../providerQuota.js";
import { getClaudeCapabilities, getCodexCapabilities, type ProviderCapabilitiesSnapshot } from "../providerCapabilities.js";
import type { AgentContextUsage } from "../sessionWarningTypes.js";

export type CodingAgent = string;

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelInfo {
  id: string;
  label: string;
  default?: true;
  alias?: string;
  reasoningEfforts?: ReasoningEffortInfo[];
}

export interface ReasoningEffortInfo {
  id: ReasoningEffort;
  label: string;
  default?: true;
}

export interface AgentEvent extends Record<string, unknown> {
  type: "system" | "assistant" | "user" | "user_message" | "result" | "stderr" | "preview" | "warning";
  createdAt?: number;
  sourceTimestamp?: string;
}

export interface AgentExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
}

export interface AgentBackendState {
  turnId: string | null;
  runtimeGeneration: number | null;
  status: "inProgress" | "completed" | "interrupted" | "failed" | "unknown";
}

export interface AgentRun {
  emitter: EventEmitter;
  kill(signal?: NodeJS.Signals): void;
  steer?(input: AgentSteerInput): Promise<void> | undefined;
}

export type { AgentContextUsage };

export interface AgentConversation {
  initialBackendId(sessionId: string): string | null;
  recoverBackendId(sessionId: string, persistedBackendId: string | null): string | null;
}

export interface AgentRunOptions {
  agent: CodingAgent;
  command: string;
  prompt: string;
  cwd: string;
  systemPromptAppend: string;
  outcomeSchema?: Record<string, unknown>;
  outcomeSchemaPath?: string;
  sessionId: string;
  backendSessionId?: string | null;
  resume?: boolean;
  mcpConfigPath?: string;
  allowedTools?: string;
  maxBudgetUsd?: number;
  permissionMode?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  attachments?: unknown[];
  onBackendState?(state: AgentBackendState): void;
}

export interface AgentSteerInput {
  prompt: string;
  attachments: unknown[];
  permissionMode?: string;
  author?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  commandId?: string;
}

export interface AgentSteerCallbacks {
  accepted(): void;
  rejected(error: unknown): void;
}

export interface AgentReconcileInput {
  command: string;
  backendSessionId: string | null;
  backendTurnId: string | null;
  runtimeGeneration: number | null;
}

export interface AgentReconcileResult {
  status: "completed" | "interrupted" | "failed" | "unknown";
  backendTurnId: string | null;
  runtimeGeneration: number | null;
  detail?: string;
}

export interface CanonicalOutcome {
  result: "success" | "failure" | "needs_human";
  summary: string;
  previewPath?: string | null;
}

export interface AgentDriver {
  id: CodingAgent;
  label: string;
  available(): boolean;
  visible: boolean;
  legacy?: boolean;
  models: ModelInfo[];
  reasoningEfforts?: ReasoningEffortInfo[];
  canonicalModel(value: unknown): string | undefined;
  reasoningEffort(value: unknown, model?: unknown): ReasoningEffort | undefined;
  command(settings: DaemonSettings): string;
  conversation: AgentConversation;
  outcomeSchema(expectsOutcome: boolean): Record<string, unknown> | undefined;
  normalizeOutcome(value: unknown): CanonicalOutcome | null;
  normalizeStoredEvent(raw: Record<string, unknown>): AgentEvent | null;
  run(options: AgentRunOptions): AgentRun;
  steer?(run: AgentRun, input: AgentSteerInput, callbacks: AgentSteerCallbacks): boolean;
  reconcile?(input: AgentReconcileInput): Promise<AgentReconcileResult>;
  interrupt(run: AgentRun, reason: "cancel" | "timeout" | "superseded" | "shutdown"): void;
  shutdown(run: AgentRun): void;
  shutdownRuntime?(): void | Promise<void>;
  auth: {
    observeSuccess(): void;
    observeFailure(message: string): void;
  };
  capabilities: {
    steering: boolean;
    cancellation: boolean;
    recovery: boolean;
    quota: boolean;
    status: boolean;
    cliUpdate: boolean;
  };
  services: {
    status?: () => unknown;
    quota?: (force: boolean) => Promise<ProviderQuotaSnapshot>;
    capabilities?: (force: boolean) => Promise<ProviderCapabilitiesSnapshot>;
    cliUpdate?: { packageName: string };
  };
}

const drivers = new Map<CodingAgent, AgentDriver>();

export function registerAgentDriver(driver: AgentDriver): AgentDriver {
  if (!driver.id.trim()) throw new Error("agent driver id must not be empty");
  if (drivers.has(driver.id)) throw new Error(`agent driver already registered: ${driver.id}`);
  drivers.set(driver.id, driver);
  return driver;
}

export function getAgentDriver(id: unknown): AgentDriver | undefined {
  return typeof id === "string" ? drivers.get(id) : undefined;
}

export function requireAgentDriver(id: unknown): AgentDriver {
  const driver = getAgentDriver(id);
  if (!driver) throw new Error(`Agent driver "${String(id)}" is not registered`);
  if (!driver.available()) throw new Error(`Agent driver "${driver.id}" is unavailable`);
  return driver;
}

export function listAgentDrivers(options: { visible?: boolean; available?: boolean } = {}): AgentDriver[] {
  return [...drivers.values()].filter((driver) =>
    (options.visible === undefined || driver.visible === options.visible)
    && (options.available === undefined || driver.available() === options.available));
}

function previewEvent(raw: Record<string, unknown>): AgentEvent | null {
  const timestamps = storedTimestampMetadata(raw);
  if (raw.type === "warning") {
    if (typeof raw.sessionId !== "string" || typeof raw.message !== "string"
      || !["context_near_limit", "payload_near_limit", "payload_truncated"].includes(String(raw.code))) return null;
    const fields = [
      "sessionId", "code", "message", "source", "currentBytes", "limitBytes", "retainedBytes",
      "currentTokens", "limitTokens", "action", "logPath", "logError",
    ] as const;
    const event: AgentEvent = { type: "warning" };
    for (const field of fields) if (raw[field] !== undefined) event[field] = raw[field];
    return { ...event, ...timestamps };
  }
  if (raw.type === "preview") {
    if (typeof raw.path !== "string" || !raw.path.trim()) return null;
    const renderable = new Set([".html", ".htm", ".md", ".markdown", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"]);
    if (raw.author === "agent" && !renderable.has(path.extname(raw.path).toLowerCase())) return null;
    return {
      type: "preview", path: raw.path,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : raw.path.split(/[\\/]/).pop() || "Preview",
      ...(typeof raw.author === "string" ? { author: raw.author } : {}), ...timestamps,
    };
  }
  if (raw.type === "user_message") return {
    type: "user_message", text: typeof raw.text === "string" ? raw.text : "",
    ...(Array.isArray(raw.attachments) ? { attachments: raw.attachments } : {}),
    ...(typeof raw.permissionMode === "string" ? { permissionMode: raw.permissionMode } : {}),
    ...(typeof raw.author === "string" ? { author: raw.author } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(typeof raw.reasoningEffort === "string" ? { reasoningEffort: raw.reasoningEffort } : {}),
    ...(typeof raw.commandId === "string" ? { commandId: raw.commandId } : {}), ...timestamps,
  };
  if (raw.type === "stderr") return { type: "stderr", text: typeof raw.text === "string" ? raw.text : String(raw.text ?? ""), ...timestamps };
  return null;
}

function canonicalStored(raw: Record<string, unknown>): AgentEvent | null {
  const common = previewEvent(raw);
  if (common) return common;
  if (typeof raw.type !== "string" || !["system", "assistant", "user", "result"].includes(raw.type)) return null;
  const { timestamp: _timestamp, sourceTimestamp: _sourceTimestamp, createdAt: _createdAt, ...fields } = raw;
  return { ...(fields as AgentEvent), ...storedTimestampMetadata(raw) };
}

function normalizeOutcome(value: unknown, includePreview: boolean): CanonicalOutcome | null {
  const output = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!output || !["success", "failure", "needs_human"].includes(String(output.result)) || typeof output.summary !== "string") return null;
  return { result: output.result as CanonicalOutcome["result"], summary: output.summary,
    ...(includePreview ? { previewPath: typeof output.previewPath === "string" && output.previewPath.trim() ? output.previewPath.trim() : null } : {}) };
}

const effort = (ids: ReasoningEffort[], defaultId: ReasoningEffort): ReasoningEffortInfo[] => ids.map((id) => ({ id, label: id === "xhigh" ? "Extra high" : id[0].toUpperCase() + id.slice(1), ...(id === defaultId ? { default: true as const } : {}) }));
const claudeFrontierEfforts = () => effort(["low", "medium", "high", "xhigh", "max"], "high");
const codexEfforts = (ids: ReasoningEffort[], defaultId: ReasoningEffort) => effort(ids, defaultId);

const claudeModels: ModelInfo[] = [
  { id: "claude-opus-5", label: "Opus 5", alias: "opus", reasoningEfforts: claudeFrontierEfforts() },
  { id: "claude-sonnet-5", label: "Sonnet 5", alias: "sonnet", default: true, reasoningEfforts: claudeFrontierEfforts() },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", alias: "haiku" },
  { id: "claude-fable-5", label: "Fable 5", reasoningEfforts: claudeFrontierEfforts() },
];
const codexModels: ModelInfo[] = [
  { id: "gpt-5.6-sol", label: "5.6 Sol", default: true, reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh", "max", "ultra"], "low") },
  { id: "gpt-5.6-terra", label: "5.6 Terra", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh", "max", "ultra"], "medium") },
  { id: "gpt-5.6-luna", label: "5.6 Luna", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh", "max"], "medium") },
  { id: "gpt-5.5", label: "5.5", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh"], "medium") },
  { id: "gpt-5.3-codex-spark", label: "5.3 Codex Spark", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh"], "high") },
  { id: "gpt-5.4", label: "5.4", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh"], "medium") },
  { id: "gpt-5.4-mini", label: "5.4 Mini", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh"], "medium") },
];
const fromCatalog = (models: ModelInfo[], value: unknown) => typeof value === "string" ? models.find((model) => model.id === value || model.alias === value)?.id : undefined;
const modelEffort = (models: ModelInfo[], value: unknown, model: unknown): ReasoningEffort | undefined => {
  const selected = models.find((candidate) => candidate.id === fromCatalog(models, model))
    ?? models.find((candidate) => candidate.default)
    ?? models[0];
  return selected?.reasoningEfforts?.some((item) => item.id === value) ? value as ReasoningEffort : undefined;
};

registerAgentDriver({
  id: "claude-code", label: "Claude Code", available: () => true, visible: true, models: claudeModels,
  reasoningEfforts: effort(["low", "medium", "high", "xhigh", "max"], "high"),
  canonicalModel: (value) => fromCatalog(claudeModels, value) ?? (typeof value === "string" && /^claude-[a-z0-9.-]+$/i.test(value) ? value : undefined),
  reasoningEffort: (value, model) => modelEffort(claudeModels, value, model),
  command: (current) => current.agentCommand,
  conversation: { initialBackendId: (id) => id, recoverBackendId: (id, persisted) => persisted ?? id },
  outcomeSchema: (expects) => expects ? OUTCOME_SCHEMA : undefined, normalizeOutcome: (value) => normalizeOutcome(value, false),
  normalizeStoredEvent(raw) { const common = previewEvent(raw); const event = common ?? normalizeClaudeCodeEvent(raw); return event ? { ...event, ...storedTimestampMetadata(raw) } : null; },
  run: runClaudeCode,
  interrupt: (run) => run.kill(), shutdown: (run) => run.kill(),
  auth: {
    observeSuccess: () => claudeCodeAuth.clearObservedFailure(),
    observeFailure: (message) => { if (claudeCodeAuth.isLikelyAuthFailure(message)) claudeCodeAuth.recordPossibleAuthFailure(message, Date.now()); },
  },
  capabilities: { steering: false, cancellation: true, recovery: true, quota: true, status: true, cliUpdate: true },
  services: {
    status: () => claudeCodeAuth.getState(), quota: getClaudeQuota,
    capabilities: getClaudeCapabilities, cliUpdate: { packageName: "@anthropic-ai/claude-code" },
  },
});

registerAgentDriver({
  id: "codex", label: "Codex (legacy)", available: () => true, visible: true, legacy: true, models: codexModels,
  reasoningEfforts: effort(["low", "medium", "high", "xhigh", "max", "ultra"], "medium"),
  canonicalModel: (value) => fromCatalog(codexModels, value),
  reasoningEffort: (value, model) => modelEffort(codexModels, value, model),
  command: (current) => current.codexCommand,
  conversation: { initialBackendId: () => null, recoverBackendId: (_id, persisted) => persisted },
  outcomeSchema: (expects) => expects ? CODEX_OUTCOME_SCHEMA : undefined, normalizeOutcome: (value) => normalizeOutcome(value, true),
  normalizeStoredEvent: canonicalStored, run: runCodex,
  interrupt: (run) => run.kill(), shutdown: (run) => run.kill(),
  auth: { observeSuccess() {}, observeFailure() {} },
  capabilities: { steering: false, cancellation: true, recovery: true, quota: true, status: false, cliUpdate: true },
  services: { quota: getCodexQuota, capabilities: getCodexCapabilities, cliUpdate: { packageName: "@openai/codex" } },
});

registerAgentDriver({
  id: "codex-app-server", label: "Codex", available: () => true, visible: true, models: codexModels,
  reasoningEfforts: effort(["low", "medium", "high", "xhigh", "max", "ultra"], "medium"),
  canonicalModel: (value) => fromCatalog(codexModels, value),
  reasoningEffort: (value, model) => modelEffort(codexModels, value, model),
  command: (current) => current.codexCommand,
  conversation: { initialBackendId: () => null, recoverBackendId: (_id, persisted) => persisted },
  outcomeSchema: (expects) => expects ? CODEX_OUTCOME_SCHEMA : undefined,
  normalizeOutcome: (value) => normalizeOutcome(value, true),
  normalizeStoredEvent: canonicalStored,
  run: runCodexAppServer,
  steer: (run, input, callbacks) => {
    const attempt = run.steer?.(input);
    if (!attempt) return false;
    void attempt.then(callbacks.accepted, callbacks.rejected);
    return true;
  },
  reconcile: reconcileCodexAppServerTurn,
  interrupt: (run) => run.kill(), shutdown: (run) => run.kill(),
  shutdownRuntime: shutdownCodexAppServerRuntime,
  auth: { observeSuccess() {}, observeFailure() {} },
  capabilities: { steering: true, cancellation: true, recovery: true, quota: false, status: true, cliUpdate: false },
  services: { status: () => codexAppServerHealth() },
});

export async function shutdownAgentDriverRuntimes(): Promise<void> {
  await Promise.all(listAgentDrivers().flatMap((driver) => driver.shutdownRuntime ? [driver.shutdownRuntime()] : []));
}

export const agentServices = {
  async quota(agent: string, force = false): Promise<ProviderQuotaSnapshot | undefined> {
    return getAgentDriver(agent)?.services.quota?.(force);
  },
  async quotas(force = false) {
    const providers = await Promise.all(listAgentDrivers().flatMap((driver) => driver.services.quota ? [driver.services.quota(force)] : []));
    return { updatedAt: providers.length ? Math.max(...providers.map((item) => item.updatedAt)) : Date.now(), providers };
  },
  async capabilities(agent: string, force = false): Promise<ProviderCapabilitiesSnapshot | undefined> {
    return getAgentDriver(agent)?.services.capabilities?.(force);
  },
  async allCapabilities(force = false) {
    const providers = await Promise.all(listAgentDrivers().flatMap((driver) => driver.services.capabilities ? [driver.services.capabilities(force)] : []));
    return { updatedAt: providers.length ? Math.max(...providers.map((item) => item.updatedAt)) : Date.now(), providers };
  },
};
