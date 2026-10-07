import { getAgentDriver, type ModelInfo, type ReasoningEffort } from "../../agents/index.js";
import { refreshAgentModelCatalog } from "../../providers/modelCatalog.js";

const efforts = (ids: ReasoningEffort[], defaultId: ReasoningEffort) => ids.map((id) => ({
  id, label: id, ...(id === defaultId ? { default: true as const } : {}),
}));

export const claudeCliModels: ModelInfo[] = [
  { id: "claude-sonnet-5", alias: "sonnet", label: "Sonnet 5", default: true,
    reasoningEfforts: efforts(["low", "medium", "high", "xhigh", "max"], "high") },
  { id: "claude-opus-5", alias: "opus", label: "Opus 5",
    reasoningEfforts: efforts(["low", "medium", "high", "xhigh", "max"], "high") },
  { id: "claude-fable-5-1", label: "Fable 5.1",
    reasoningEfforts: efforts(["low", "medium", "high", "xhigh", "max"], "high") },
  { id: "claude-haiku-4-5-20251001", alias: "haiku", label: "Haiku 4.5", reasoningEfforts: [] },
];

export const codexCliModels: ModelInfo[] = [
  { id: "gpt-5.6-sol", label: "5.6 Sol", default: true,
    reasoningEfforts: efforts(["low", "medium", "high", "xhigh", "max", "ultra"], "low") },
  { id: "gpt-6-astra", label: "6 Astra",
    reasoningEfforts: efforts(["low", "medium", "high", "xhigh", "max"], "medium") },
  { id: "gpt-5.5", label: "5.5", reasoningEfforts: efforts(["low", "medium", "high", "xhigh"], "medium") },
  { id: "gpt-5.4", label: "5.4", reasoningEfforts: efforts(["low", "medium", "high", "xhigh"], "medium") },
  { id: "gpt-5.4-mini", label: "5.4 Mini", reasoningEfforts: efforts(["low", "medium", "high", "xhigh"], "medium") },
];

export async function discoverFixtureModels(agent: string, models: ModelInfo[]): Promise<void> {
  const driver = getAgentDriver(agent);
  if (!driver) throw new Error(`Missing test driver ${agent}`);
  const original = driver.services.modelCatalog;
  try {
    driver.services.modelCatalog = { discover: async () => models };
    await refreshAgentModelCatalog(agent, "fixture-cli", true);
  } finally {
    driver.services.modelCatalog = original;
  }
}

export async function discoverBuiltinFixtureModels(): Promise<void> {
  await discoverFixtureModels("claude-code", claudeCliModels);
  await discoverFixtureModels("codex-app-server", codexCliModels);
}
