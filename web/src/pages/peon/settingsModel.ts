import type { ModelProvider } from "./models";

// Settings always show a concrete model. Keep the submitted value aligned with
// that visible selection when the operator switches to another provider.
export function resolveDefaultModel(provider: ModelProvider | null, current: string | null | undefined): string | null {
  if (!provider) return null;
  if (current && provider.models.some((model) => model.id === current || model.alias === current)) return current;
  return provider.models.find((model) => model.default)?.id ?? provider.models[0]?.id ?? null;
}

// Current Peon builds expose aiDefaultModel as a legacy Claude-only setting.
// Codex chooses the model marked `default` in /models, and rejects the legacy
// field even when defaultAgent is changed to Codex. Omitting the property keeps
// PATCH partial and allows the provider switch to persist.
export function buildSettingsPayload<T extends { aiDefaultModel?: string | null }>(
  form: T,
  provider: ModelProvider | null,
  catalogLoaded: boolean,
): T {
  const payload = { ...form };
  if (!catalogLoaded) return payload;
  if (provider?.agent === "claude-code") payload.aiDefaultModel = resolveDefaultModel(provider, form.aiDefaultModel);
  else delete payload.aiDefaultModel;
  return payload;
}
