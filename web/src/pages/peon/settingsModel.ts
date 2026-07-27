import { effortsForModel, optionMatches, type ModelProvider } from "./models";

// Settings always show a concrete model. Keep the submitted value aligned with
// that visible selection when the operator switches to another provider.
export function resolveDefaultModel(provider: ModelProvider | null, current: string | null | undefined): string | null {
  if (!provider) return null;
  if (current && provider.models.some((model) => model.id === current || model.alias === current)) return current;
  return provider.models.find((model) => model.default)?.id ?? provider.models[0]?.id ?? null;
}

// Unlike the model, the effort is genuinely optional: null means "whatever the
// model itself defaults to", which stays the setting's resting state. Only an
// effort the effective model still advertises survives — switching provider or
// model drops one that no longer applies rather than saving a value the peon
// would reject.
export function resolveDefaultReasoningEffort(
  provider: ModelProvider | null,
  model: string | null | undefined,
  current: string | null | undefined,
): string | null {
  if (!current) return null;
  return effortsForModel(provider, model).some((effort) => optionMatches(effort, current)) ? current : null;
}

// Current Peon builds expose aiDefaultModel as a legacy Claude-only setting.
// Codex chooses the model marked `default` in /models, and rejects the legacy
// field even when defaultAgent is changed to Codex. Omitting the property keeps
// PATCH partial and allows the provider switch to persist.
export function buildSettingsPayload<T extends { aiDefaultModel?: string | null; aiDefaultReasoningEffort?: string | null }>(
  form: T,
  provider: ModelProvider | null,
  catalogLoaded: boolean,
): T {
  const payload = { ...form };
  // GET uses null for settings which have never been configured, while PATCH
  // validates values that are present (for example, name must be a non-empty
  // string and fileTransferRoot must be a string). PATCH is partial, so do not
  // echo those unset values back as explicit nulls.
  for (const key of Object.keys(payload) as Array<keyof T>) {
    if (payload[key] === null) delete payload[key];
  }
  if (!catalogLoaded) return payload;
  const model = resolveDefaultModel(provider, form.aiDefaultModel);
  if (provider?.agent === "claude-code") payload.aiDefaultModel = model;
  else delete payload.aiDefaultModel;
  // Sent explicitly even when null — that is how the operator clears a
  // configured effort back to the model's own default, and the null-stripping
  // above would otherwise swallow it. Providers advertising no efforts get no
  // key at all. Peons predating the setting ignore the unknown field.
  if (effortsForModel(provider, model).length === 0) delete payload.aiDefaultReasoningEffort;
  else payload.aiDefaultReasoningEffort = resolveDefaultReasoningEffort(provider, model, form.aiDefaultReasoningEffort);
  return payload;
}
