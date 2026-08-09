import {
  getAgentDriver,
  listAgentDrivers,
  REASONING_EFFORTS,
  type CodingAgent,
  type ModelInfo,
  type ReasoningEffort,
  type ReasoningEffortInfo,
} from "../agents/index.js";

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
}

function publicCapabilities(driver: NonNullable<ReturnType<typeof getAgentDriver>>) {
  return { ...driver.capabilities };
}

export function codingAgents(): CodingAgent[] {
  return allDrivers().map((driver) => driver.id);
}

export function aiProviders(): AiProvider[] {
  return allDrivers().map((driver) => ({
    agent: driver.id, label: driver.label, models: driver.models,
    reasoningEfforts: driver.reasoningEfforts, available: driver.available(),
    visible: driver.visible, legacy: driver.legacy, capabilities: publicCapabilities(driver),
    status: driver.services.status?.() ?? null,
    defaultModel: providerDefaultModel(driver.id),
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
  const model = driver?.models.find((candidate) => candidate.default) ?? driver?.models[0];
  if (!model) throw new Error(`no model catalog for agent ${agent}`);
  return model.id;
}

export function canonicalModel(agent: CodingAgent, value: unknown): string | undefined {
  return getAgentDriver(agent)?.canonicalModel(value);
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
    const selected = driver.id === defaultAgent
      ? (defaultModel && driver.canonicalModel(defaultModel)) || providerDefaultModel(defaultAgent)
      : null;
    const known = selected ? driver.models.some((model) => model.id === selected) : true;
    const configuredEffort = driver.id === defaultAgent
      ? driver.reasoningEffort(defaultReasoningEffort, selected)
      : undefined;
    const models = driver.models.map(({ default: _default, ...model }) => {
      const reasoningEfforts = model.reasoningEfforts?.map(({ default: _effortDefault, ...item }) =>
        configuredEffort && model.id === selected && item.id === configuredEffort
          ? { ...item, default: true as const }
          : configuredEffort && model.id === selected
            ? item
            : { ...item, ...(_effortDefault ? { default: true as const } : {}) });
      return model.id === selected
        ? { ...model, ...(reasoningEfforts ? { reasoningEfforts } : {}), default: true as const }
        : { ...model, ...(reasoningEfforts ? { reasoningEfforts } : {}) };
    });
    if (selected && !known) models.push({ id: selected, label: selected, default: true });
    return {
      agent: driver.id, label: driver.label, models,
      reasoningEfforts: driver.reasoningEfforts?.map((item) => ({ ...item })),
      available: driver.available(), visible: driver.visible, legacy: driver.legacy,
      capabilities: publicCapabilities(driver),
      status: driver.services.status?.() ?? null,
      defaultModel: providerDefaultModel(driver.id),
    };
  });
}

export function listConfiguredAgents(options: { visible?: boolean; available?: boolean } = {}): string[] {
  return listAgentDrivers(options).map((driver) => driver.id);
}

export function isValidModel(value: unknown): value is string {
  return getAgentDriver("claude-code")?.canonicalModel(value) !== undefined;
}

export function narrowModel(value: unknown, agent: CodingAgent = "claude-code"): string | undefined {
  return canonicalModel(agent, value);
}

export function resolveModel(agent: CodingAgent, turnModel: unknown, sessionModel: unknown, savedAgent: CodingAgent, savedModel: unknown): string {
  const driver = getAgentDriver(agent);
  if (!driver) throw new Error(`Agent driver "${agent}" is not registered`);
  return driver.canonicalModel(turnModel) ?? driver.canonicalModel(sessionModel)
    ?? (savedAgent === agent ? driver.canonicalModel(savedModel) : undefined) ?? providerDefaultModel(agent);
}

export function reasoningEffortsForModel(agent: CodingAgent, model: unknown): ReasoningEffortInfo[] {
  const driver = getAgentDriver(agent);
  const canonical = driver?.canonicalModel(model) ?? driver?.models.find((candidate) => candidate.default)?.id;
  return driver?.models.find((candidate) => candidate.id === canonical)?.reasoningEfforts?.map((item) => ({ ...item })) ?? [];
}

export function narrowReasoningEffort(
  value: unknown,
  agent: CodingAgent = "claude-code",
  model?: unknown,
): ReasoningEffort | undefined {
  return getAgentDriver(agent)?.reasoningEffort(value, model);
}
