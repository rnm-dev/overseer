import { EventEmitter } from "node:events";
import {
  getAgentDriver,
  listAgentDrivers,
  REASONING_EFFORTS,
  type CodingAgent,
  type ModelInfo,
  type ReasoningEffort,
  type ReasoningEffortInfo,
} from "../agents/index.js";
import type { DaemonSettings } from "../settings/index.js";

export { REASONING_EFFORTS };
export type { CodingAgent, ModelInfo, ReasoningEffort, ReasoningEffortInfo };
export const DEFAULT_MODEL = "claude-sonnet-5";

function allDrivers(): ReturnType<typeof listAgentDrivers> {
  return listAgentDrivers();
}

export interface AiProvider {
  agent: CodingAgent;
  label: string;
  models: ModelInfo[];
  reasoningEfforts?: ReasoningEffortInfo[];
  available?: boolean;
  visible?: boolean;
  legacy?: boolean;
  capabilities?: ReturnType<typeof publicCapabilities>;
  status?: unknown;
  defaultModel?: string;
  catalogSource?: "cli" | "stale-cli" | "fallback";
  catalogUpdatedAt?: number | null;
  catalogError?: string | null;
}

interface CachedModelCatalog {
  models: ModelInfo[] | null;
  checkedAt: number;
  updatedAt: number | null;
  error: string | null;
}

const MODEL_CATALOG_TTL_MS = 5 * 60_000;
const MODEL_CATALOG_FAILURE_TTL_MS = 30_000;
const cachedCatalogs = new Map<CodingAgent, CachedModelCatalog>();
const catalogRefreshes = new Map<CodingAgent, Promise<void>>();
const catalogEvents = new EventEmitter();

export function onAgentModelCatalogChange(listener: () => void): () => void {
  catalogEvents.on("change", listener);
  return () => catalogEvents.off("change", listener);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeModels(agent: CodingAgent): ModelInfo[] | null {
  return cachedCatalogs.get(agent)?.models ?? null;
}

function modelsFor(agent: CodingAgent): ModelInfo[] {
  const driver = getAgentDriver(agent);
  return runtimeModels(agent) ?? driver?.models ?? [];
}

function fromModels(models: ModelInfo[], value: unknown): string | undefined {
  return typeof value === "string"
    ? models.find((model) => model.id === value || model.alias === value)?.id
    : undefined;
}

function effortForModels(models: ModelInfo[], value: unknown, model: unknown): ReasoningEffort | undefined {
  const selected = models.find((candidate) => candidate.id === fromModels(models, model))
    ?? models.find((candidate) => candidate.default)
    ?? models[0];
  return selected?.reasoningEfforts?.some((item) => item.id === value) ? value as ReasoningEffort : undefined;
}

function providerEfforts(agent: CodingAgent): ReasoningEffortInfo[] | undefined {
  const live = runtimeModels(agent);
  const driver = getAgentDriver(agent);
  if (!live) return driver?.reasoningEfforts;
  const defaultEffort = (live.find((model) => model.default) ?? live[0])
    ?.reasoningEfforts?.find((item) => item.default)?.id;
  const seen = new Set<string>();
  const efforts = live.flatMap((model) => model.reasoningEfforts ?? []).flatMap((item) => {
    if (seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ id: item.id, label: item.label, ...(item.id === defaultEffort ? { default: true as const } : {}) }];
  });
  return efforts.length ? efforts : undefined;
}

function catalogMetadata(agent: CodingAgent): Pick<AiProvider, "catalogSource" | "catalogUpdatedAt" | "catalogError"> {
  const cached = cachedCatalogs.get(agent);
  return {
    catalogSource: cached?.models ? (cached.error ? "stale-cli" : "cli") : "fallback",
    catalogUpdatedAt: cached?.updatedAt ?? null,
    catalogError: cached?.error ?? null,
  };
}

export function invalidateAgentModelCatalog(agent?: CodingAgent): void {
  if (agent) cachedCatalogs.delete(agent); else cachedCatalogs.clear();
  catalogEvents.emit("change");
}

export async function refreshAgentModelCatalog(agent: CodingAgent, command: string, force = false): Promise<void> {
  const driver = getAgentDriver(agent);
  const service = driver?.services.modelCatalog;
  if (!driver || !service) return;
  const current = cachedCatalogs.get(agent);
  const ttl = current?.error ? MODEL_CATALOG_FAILURE_TTL_MS : MODEL_CATALOG_TTL_MS;
  if (!force && current && Date.now() - current.checkedAt < ttl) return;
  const active = catalogRefreshes.get(agent);
  if (active) return active;
  const refresh = (async () => {
    try {
      const models = await service.discover(command);
      if (!models.length) throw new Error(`${driver.label} CLI returned an empty model catalog`);
      const now = Date.now();
      cachedCatalogs.set(agent, { models: models.map((model) => ({ ...model })), checkedAt: now, updatedAt: now, error: null });
    } catch (error) {
      const previous = cachedCatalogs.get(agent);
      cachedCatalogs.set(agent, {
        models: previous?.models ?? null,
        checkedAt: Date.now(),
        updatedAt: previous?.updatedAt ?? null,
        error: safeError(error),
      });
    }
    catalogEvents.emit("change");
  })();
  catalogRefreshes.set(agent, refresh);
  try { await refresh; } finally {
    if (catalogRefreshes.get(agent) === refresh) catalogRefreshes.delete(agent);
  }
}

export async function refreshAgentModelCatalogs(current: DaemonSettings, force = false): Promise<void> {
  await Promise.all(listAgentDrivers({ visible: true, available: true }).map((driver) =>
    refreshAgentModelCatalog(driver.id, driver.command(current), force)));
}

function publicCapabilities(driver: NonNullable<ReturnType<typeof getAgentDriver>>) {
  return { ...driver.capabilities };
}

export function codingAgents(): CodingAgent[] {
  return allDrivers().map((driver) => driver.id);
}

export function aiProviders(): AiProvider[] {
  return allDrivers().map((driver) => ({
    agent: driver.id, label: driver.label, models: modelsFor(driver.id),
    reasoningEfforts: providerEfforts(driver.id), available: driver.available(),
    visible: driver.visible, legacy: driver.legacy, capabilities: publicCapabilities(driver),
    status: driver.services.status?.() ?? null,
    defaultModel: providerDefaultModel(driver.id),
    ...catalogMetadata(driver.id),
  }));
}

export function narrowAgent(value: unknown): CodingAgent | undefined {
  return getAgentDriver(value)?.id;
}

export function narrowNewSessionAgent(value: unknown): CodingAgent | undefined {
  const driver = getAgentDriver(value);
  return driver?.available() && driver.visible ? driver.id : undefined;
}

export function providerDefaultModel(agent: CodingAgent): string {
  const driver = getAgentDriver(agent);
  const models = modelsFor(agent);
  const model = models.find((candidate) => candidate.default) ?? models[0];
  if (!model) throw new Error(`no model catalog for agent ${agent}`);
  return model.id;
}

export function canonicalModel(agent: CodingAgent, value: unknown): string | undefined {
  const live = runtimeModels(agent);
  return live ? fromModels(live, value) : getAgentDriver(agent)?.canonicalModel(value);
}

export function isModelForAgent(agent: CodingAgent, value: unknown): value is string {
  return canonicalModel(agent, value) !== undefined;
}

export function modelCatalog(
  defaultAgent: CodingAgent,
  defaultModel: string | null,
  defaultReasoningEffort: ReasoningEffort | null = null,
): AiProvider[] {
  return listAgentDrivers({ visible: true, available: true }).map((driver) => {
    const driverModels = modelsFor(driver.id);
    const selected = driver.id === defaultAgent
      ? (defaultModel && canonicalModel(driver.id, defaultModel)) || providerDefaultModel(defaultAgent)
      : null;
    const known = selected ? driverModels.some((model) => model.id === selected) : true;
    const configuredEffort = driver.id === defaultAgent
      ? narrowReasoningEffort(defaultReasoningEffort, driver.id, selected)
      : undefined;
    const models = driverModels.map(({ default: _default, ...model }) => {
      const reasoningEfforts = model.reasoningEfforts?.map(({ default: _effortDefault, ...item }) =>
        configuredEffort && model.id === selected && item.id === configuredEffort
          ? { ...item, default: true as const }
          : configuredEffort && model.id === selected
            ? item
            : { ...item, ...(_effortDefault ? { default: true as const } : {}) });
      return model.id === selected
        ? { ...model, ...(reasoningEfforts ? { reasoningEfforts } : {}), default: true as const }
        : {
            ...model,
            ...(reasoningEfforts ? { reasoningEfforts } : {}),
            ...(driver.id !== defaultAgent && _default ? { default: true as const } : {}),
          };
    });
    if (selected && !known) models.push({ id: selected, label: selected, default: true });
    return {
      agent: driver.id, label: driver.label, models,
      reasoningEfforts: providerEfforts(driver.id)?.map((item) => ({ ...item })),
      available: driver.available(), visible: driver.visible, legacy: driver.legacy,
      capabilities: publicCapabilities(driver),
      status: driver.services.status?.() ?? null,
      defaultModel: providerDefaultModel(driver.id),
      ...catalogMetadata(driver.id),
    };
  });
}

export function listConfiguredAgents(options: { visible?: boolean; available?: boolean } = {}): string[] {
  return listAgentDrivers(options).map((driver) => driver.id);
}

export function isValidModel(value: unknown): value is string {
  return canonicalModel("claude-code", value) !== undefined;
}

export function narrowModel(value: unknown, agent: CodingAgent = "claude-code"): string | undefined {
  return canonicalModel(agent, value);
}

export function resolveModel(agent: CodingAgent, turnModel: unknown, sessionModel: unknown, savedAgent: CodingAgent, savedModel: unknown): string {
  const driver = getAgentDriver(agent);
  if (!driver) throw new Error(`Agent driver "${agent}" is not registered`);
  return canonicalModel(agent, turnModel) ?? canonicalModel(agent, sessionModel)
    ?? (savedAgent === agent ? canonicalModel(agent, savedModel) : undefined) ?? providerDefaultModel(agent);
}

export function resolveReasoningEffort(
  agent: CodingAgent,
  turnEffort: unknown,
  sessionEffort: unknown,
  savedAgent: CodingAgent,
  savedEffort: unknown,
  model: unknown,
): ReasoningEffort | undefined {
  const driver = getAgentDriver(agent);
  if (!driver) throw new Error(`Agent driver "${agent}" is not registered`);
  return narrowReasoningEffort(turnEffort, agent, model)
    ?? narrowReasoningEffort(sessionEffort, agent, model)
    ?? (savedAgent === agent ? narrowReasoningEffort(savedEffort, agent, model) : undefined);
}

export function reasoningEffortsForModel(agent: CodingAgent, model: unknown): ReasoningEffortInfo[] {
  const driver = getAgentDriver(agent);
  const models = modelsFor(agent);
  const canonical = canonicalModel(agent, model) ?? models.find((candidate) => candidate.default)?.id;
  return driver ? models.find((candidate) => candidate.id === canonical)?.reasoningEfforts?.map((item) => ({ ...item })) ?? [] : [];
}

export function narrowReasoningEffort(
  value: unknown,
  agent: CodingAgent = "claude-code",
  model?: unknown,
): ReasoningEffort | undefined {
  const live = runtimeModels(agent);
  return live ? effortForModels(live, value, model) : getAgentDriver(agent)?.reasoningEffort(value, model);
}
