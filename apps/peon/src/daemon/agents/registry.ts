import type { EventEmitter } from "node:events";
import path from "node:path";
import { storedTimestampMetadata } from "../sessions/index.js";
import { claudeCodeAuth } from "../providers/claudeCodeAuth.js";
import { CODEX_OUTCOME_SCHEMA, OUTCOME_SCHEMA } from "../sessions/index.js";
import type { DaemonSettings } from "../settings/index.js";
import { forkClaudeCodeSession, normalizeClaudeCodeEvent, runClaudeCode } from "./claudeCode.js";
import { codexAppServerHealth, forkCodexAppServerThread, getCodexAppServerRuntime, reconcileCodexAppServerTurn, runCodexAppServer, shutdownCodexAppServerRuntime } from "./codexAppServer.js";
import { getClaudeQuota, getCodexQuota, type ProviderQuotaSnapshot } from "../providers/providerQuota.js";
import { getClaudeCapabilities, getCodexCapabilities, type ProviderCapabilitiesSnapshot } from "../providers/providerCapabilities.js";
import type { AgentContextUsage } from "../sessions/index.js";
import { createSelfUpdatingCliUpdater, type AgentCliUpdater } from "./cliUpdater.js";
import { ClaudeLoginService } from "./claudeLogin.js";
import { CodexLoginService } from "./codexLogin.js";
import { settings as loginSettings } from "../settings/index.js";
import {
  claudeModelCatalogService,
  createCodexModelCatalogService,
  type AgentModelCatalogService,
} from "./modelDiscovery.js";

export type CodingAgent = string;

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = string;

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
  type: "system" | "assistant" | "user" | "user_message" | "participant_message" | "result" | "stderr" | "preview" | "warning";
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
  onAccepted?(): void;
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
  serviceProvider?: string;
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
  forkConversation?(input: { command: string; backendSessionId: string; targetSessionId: string; cwd: string; lastTurnId?: string }): Promise<{ backendSessionId: string }>;
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
    branching?: boolean;
    branchAtTurn?: boolean;
    login?: boolean;
  };
  services: {
    status?: () => unknown;
    quota?: (force: boolean) => Promise<ProviderQuotaSnapshot>;
    capabilities?: (force: boolean) => Promise<ProviderCapabilitiesSnapshot>;
    cliUpdate?: AgentCliUpdater;
    modelCatalog?: AgentModelCatalogService;
    claudeLogin?: ClaudeLoginService;
    codexLogin?: CodexLoginService;
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

export function getAgentServiceDriver(provider: unknown): AgentDriver | undefined {
  if (typeof provider !== "string") return undefined;
  return drivers.get(provider)
    ?? [...drivers.values()].find((driver) => driver.serviceProvider === provider);
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
      || !["context_near_limit", "payload_near_limit", "payload_truncated", "turn_limit_exceeded", "task_timeout"].includes(String(raw.code))) return null;
    const fields = [
      "sessionId", "code", "message", "source", "currentBytes", "limitBytes", "retainedBytes",
      "currentTokens", "limitTokens", "action", "logPath", "logError",
      "canResume", "maxTurns", "turnBudget", "turnsUsed", "timeoutMs", "elapsedMs",
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
  if (raw.type === "user_message") {
    const replyTo = storedReplyTo(raw.replyTo);
    return {
      type: "user_message", text: typeof raw.text === "string" ? raw.text : "",
      ...(Array.isArray(raw.attachments) ? { attachments: raw.attachments } : {}),
      ...(typeof raw.permissionMode === "string" ? { permissionMode: raw.permissionMode } : {}),
      ...(typeof raw.author === "string" ? { author: raw.author } : {}),
      ...(typeof raw.model === "string" ? { model: raw.model } : {}),
      ...(typeof raw.reasoningEffort === "string" ? { reasoningEffort: raw.reasoningEffort } : {}),
      ...(typeof raw.commandId === "string" ? { commandId: raw.commandId } : {}),
      ...(replyTo ? { replyTo } : {}), ...timestamps,
    };
  }
  if (raw.type === "participant_message") return raw as AgentEvent;
  if (raw.type === "stderr") return { type: "stderr", text: typeof raw.text === "string" ? raw.text : String(raw.text ?? ""), ...timestamps };
  return null;
}

// This sits at the provider-normalization boundary because Claude's legacy
// reader reconstructs user_message envelopes field-by-field. Keep durable
// reply metadata through a restart while refusing malformed historical rows.
function storedReplyTo(value: unknown): { eventId: string; selectedText: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const replyTo = value as Record<string, unknown>;
  if (typeof replyTo.eventId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(replyTo.eventId)) return null;
  if (typeof replyTo.selectedText !== "string" || !replyTo.selectedText.trim()) return null;
  if ([...replyTo.selectedText].length > 8_192 || Buffer.byteLength(replyTo.selectedText, "utf8") > 16 * 1024) return null;
  return { eventId: replyTo.eventId, selectedText: replyTo.selectedText };
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
  { id: "claude-fable-5-1", label: "Fable 5.1", reasoningEfforts: claudeFrontierEfforts() },
  { id: "claude-opus-5", label: "Opus 5", alias: "opus", reasoningEfforts: claudeFrontierEfforts() },
  { id: "claude-sonnet-5", label: "Sonnet 5", alias: "sonnet", default: true, reasoningEfforts: claudeFrontierEfforts() },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", alias: "haiku" },
  { id: "claude-fable-5", label: "Fable 5", reasoningEfforts: claudeFrontierEfforts() },
];
const codexModels: ModelInfo[] = [
  { id: "gpt-6-astra", label: "6 Astra", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh", "max"], "medium") },
  { id: "gpt-5.6-sol", label: "5.6 Sol", default: true, reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh", "max", "ultra"], "low") },
  { id: "gpt-5.6-terra", label: "5.6 Terra", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh", "max", "ultra"], "medium") },
  { id: "gpt-5.6-luna", label: "5.6 Luna", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh", "max"], "medium") },
  { id: "gpt-5.5", label: "5.5", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh"], "medium") },
  { id: "gpt-5.3-codex-spark", label: "5.3 Codex Spark", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh"], "high") },
  { id: "gpt-5.4", label: "5.4", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh"], "medium") },
  { id: "gpt-5.4-mini", label: "5.4 Mini", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh"], "medium") },
];
const codexModelCatalogService = createCodexModelCatalogService(getCodexAppServerRuntime);
const claudeLogin = new ClaudeLoginService({
  command: () => loginSettings.get().agentCommand || "claude",
  onSuccess: () => { claudeCodeAuth.clearObservedFailure(); void claudeCodeAuth.refresh(); },
});
const codexLogin = new CodexLoginService({ command: () => loginSettings.get().codexCommand || "codex" });
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
  normalizeStoredEvent(raw) {
    // Provider normalization must not reinterpret persisted accounting or strip
    // harness-owned invocation identity when replaying after restart/branch.
    if (raw.type === "result" || (raw.type === "system" && raw.subtype === "usage")) return canonicalStored(raw);
    const common = previewEvent(raw);
    const event = common ?? normalizeClaudeCodeEvent(raw);
    return event ? { ...event, ...storedTimestampMetadata(raw) } : null;
  },
  run: runClaudeCode,
  forkConversation: forkClaudeCodeSession,
  interrupt: (run) => run.kill(), shutdown: (run) => run.kill(),
  shutdownRuntime: () => claudeLogin.shutdown(),
  auth: {
    observeSuccess: () => claudeCodeAuth.clearObservedFailure(),
    observeFailure: (message) => { if (claudeCodeAuth.isLikelyAuthFailure(message)) claudeCodeAuth.recordPossibleAuthFailure(message, Date.now()); },
  },
  capabilities: { steering: false, cancellation: true, recovery: true, quota: true, status: true, cliUpdate: true, branching: true, branchAtTurn: false, login: true },
  services: {
    claudeLogin,
    status: () => claudeCodeAuth.getState(), quota: getClaudeQuota,
    capabilities: getClaudeCapabilities,
    modelCatalog: claudeModelCatalogService,
    cliUpdate: createSelfUpdatingCliUpdater({
      packageName: "@anthropic-ai/claude-code",
      versionPattern: /\bClaude Code\b/i,
      nativePathFragments: ["/.local/share/claude/versions/"],
    }),
  },
});

registerAgentDriver({
  id: "codex-app-server", serviceProvider: "codex", label: "Codex", available: () => true, visible: true, models: codexModels,
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
  forkConversation: forkCodexAppServerThread,
  interrupt: (run) => run.kill(), shutdown: (run) => run.kill(),
  shutdownRuntime: async () => { await Promise.all([shutdownCodexAppServerRuntime(), codexLogin.shutdown()]); },
  auth: { observeSuccess() {}, observeFailure() {} },
  capabilities: { steering: true, cancellation: true, recovery: true, quota: true, status: true, cliUpdate: true, branching: true, branchAtTurn: true, login: true },
  services: {
    codexLogin,
    status: () => codexAppServerHealth(), quota: getCodexQuota,
    capabilities: getCodexCapabilities,
    modelCatalog: codexModelCatalogService,
    cliUpdate: createSelfUpdatingCliUpdater({ packageName: "@openai/codex", versionPattern: /\bcodex(?:-cli)?\b/i }),
  },
});

export async function shutdownAgentDriverRuntimes(): Promise<void> {
  await Promise.all(listAgentDrivers().flatMap((driver) => driver.shutdownRuntime ? [driver.shutdownRuntime()] : []));
}

export const agentServices = {
  async quota(agent: string, force = false): Promise<ProviderQuotaSnapshot | undefined> {
    return getAgentServiceDriver(agent)?.services.quota?.(force);
  },
  async quotas(force = false) {
    const providers = await Promise.all(listAgentDrivers().flatMap((driver) => driver.services.quota ? [driver.services.quota(force)] : []));
    return { updatedAt: providers.length ? Math.max(...providers.map((item) => item.updatedAt)) : Date.now(), providers };
  },
  async capabilities(agent: string, force = false): Promise<ProviderCapabilitiesSnapshot | undefined> {
    return getAgentServiceDriver(agent)?.services.capabilities?.(force);
  },
  async allCapabilities(force = false) {
    const providers = await Promise.all(listAgentDrivers().flatMap((driver) => driver.services.capabilities ? [driver.services.capabilities(force)] : []));
    return { updatedAt: providers.length ? Math.max(...providers.map((item) => item.updatedAt)) : Date.now(), providers };
  },
};
