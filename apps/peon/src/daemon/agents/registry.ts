import type { EventEmitter } from "node:events";
import path from "node:path";
import type { Request, Router } from "express";
import { storedTimestampMetadata } from "../sessions/index.js";
import type { DaemonSettings } from "../settings/index.js";
import type { ProviderQuotaSnapshot } from "../providers/providerQuota.js";
import type { ProviderCapabilitiesSnapshot } from "../providers/providerCapabilities.js";
import type { AgentContextUsage } from "../sessions/index.js";
import type { AgentCliUpdater } from "./cliUpdater.js";
import type { AgentModelCatalogService } from "./modelDiscovery.js";

// This file is the harness-neutral contract and registry. Everything specific
// to one harness lives in that harness's driver module, and the only place
// that names the built-in harnesses is builtinDrivers.ts.

export type CodingAgent = string;

// Session records written before Peon knew more than one harness carry no
// `agent`; they were all Claude Code. Use this only to read such records.
export const LEGACY_DEFAULT_AGENT: CodingAgent = "claude-code";

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

// Whether a harness can run work right now, as reported on Peon's /status so
// Overseer can refuse to route sessions to a Peon that would fail every turn.
export interface AgentAuthStatus {
  authState?: string;
  available?: boolean;
  checkedAt?: number;
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
  startRuntime?(): void;
  shutdownRuntime?(): void | Promise<void>;
  auth: {
    observeSuccess(): void;
    observeFailure(message: string): void;
  };
  turns?: {
    // The harness can end a resumed invocation before it reads the supplied
    // prompt (num_turns 0, no assistant output). Replay such a turn once,
    // silently, because nothing was attempted.
    replayUnprocessedResume?: boolean;
  };
  tokenUsage: {
    // Claude reports uncached input, cache writes and cache reads as disjoint
    // buckets. Codex reports cached input as a subset of input.
    cacheIncludedInInput: boolean;
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
    logout?: boolean;
  };
  services: {
    status?: () => unknown;
    authStatus?: () => AgentAuthStatus;
    quota?: (force: boolean) => Promise<ProviderQuotaSnapshot>;
    capabilities?: (force: boolean) => Promise<ProviderCapabilitiesSnapshot>;
    cliUpdate?: AgentCliUpdater;
    modelCatalog?: AgentModelCatalogService;
    // Mounted at /driver/<serviceProvider ?? id>. Each harness owns its own
    // login dialogue, so the routes are the driver's, not a shared shape.
    loginRouter?: (actor: (req: Request) => string | null) => Router;
  };
}

// The public name a driver's services are addressed by: login routes, quota,
// usage attribution. `codex-app-server` is served as `codex`.
export function agentServiceName(driver: AgentDriver): string {
  return driver.serviceProvider ?? driver.id;
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

// Shared normalization helpers for driver modules. Peon writes these event
// types itself, so they read the same whichever harness ran the session.
export function previewEvent(raw: Record<string, unknown>): AgentEvent | null {
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

export function canonicalStored(raw: Record<string, unknown>): AgentEvent | null {
  const common = previewEvent(raw);
  if (common) return common;
  if (typeof raw.type !== "string" || !["system", "assistant", "user", "result"].includes(raw.type)) return null;
  const { timestamp: _timestamp, sourceTimestamp: _sourceTimestamp, createdAt: _createdAt, ...fields } = raw;
  return { ...(fields as AgentEvent), ...storedTimestampMetadata(raw) };
}

export function normalizeOutcome(value: unknown, includePreview: boolean): CanonicalOutcome | null {
  const output = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!output || !["success", "failure", "needs_human"].includes(String(output.result)) || typeof output.summary !== "string") return null;
  return { result: output.result as CanonicalOutcome["result"], summary: output.summary,
    ...(includePreview ? { previewPath: typeof output.previewPath === "string" && output.previewPath.trim() ? output.previewPath.trim() : null } : {}) };
}

export function agentAuthByAgent(): Record<CodingAgent, AgentAuthStatus> {
  return Object.fromEntries(listAgentDrivers().flatMap((driver) =>
    driver.services.authStatus ? [[driver.id, driver.services.authStatus()]] : []));
}

export function startAgentDriverRuntimes(): void {
  for (const driver of listAgentDrivers()) driver.startRuntime?.();
}

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
