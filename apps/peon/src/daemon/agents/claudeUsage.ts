const fields = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const;
type Usage = Partial<Record<typeof fields[number], number>>;
export function claudeUsage(raw: unknown): Usage {
  const out: Usage = {};
  if (!raw || typeof raw !== "object") return out;
  for (const field of fields) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[field] = value;
  }
  return out;
}

// CLI single-shot results: modelUsage includes the whole agent tree, while
// usage is main-loop only. Never add both. No streaming-input mode is used.
export function claudeResultUsage(raw: Record<string, unknown>): Record<string, unknown> {
  const models: Record<string, Record<string, number>> = {};
  if (raw.modelUsage && typeof raw.modelUsage === "object") {
    for (const [model, value] of Object.entries(raw.modelUsage)) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      const usage = claudeUsage({ input_tokens: item.inputTokens, output_tokens: item.outputTokens,
        cache_creation_input_tokens: item.cacheCreationInputTokens, cache_read_input_tokens: item.cacheReadInputTokens });
      if (Object.keys(usage).length !== fields.length) continue;
      models[model] = { ...usage };
      if (typeof item.costUSD === "number" && Number.isFinite(item.costUSD) && item.costUSD >= 0) models[model]!.cost_usd = item.costUSD;
    }
  }
  const rows = Object.values(models);
  if (rows.length) return {
    usage: Object.fromEntries(fields.map((key) => [key, rows.reduce((sum, item) => sum + (item[key] ?? 0), 0)])),
    usage_by_model: models, usage_source: "claude-model-usage-v1",
    usage_quality: rows.length === Object.keys(raw.modelUsage as object).length ? "reported" : "partial",
  };
  return { usage: claudeUsage(raw.usage), usage_source: "claude-main-loop-v1", usage_quality: "partial" };
}

export class ClaudeInputAccumulator {
  private messages = new Map<string, Usage>();
  observe(raw: Record<string, unknown>): boolean {
    if (raw.type !== "assistant" || raw.parent_tool_use_id) return false;
    const message = raw.message as Record<string, unknown> | undefined;
    if (typeof message?.id !== "string" || this.messages.has(message.id)) return false;
    const usage = claudeUsage(message.usage);
    delete usage.output_tokens; // message_start placeholder, not final output.
    this.messages.set(message.id, usage);
    return Object.keys(usage).length > 0;
  }
  report(): Record<string, unknown> {
    const usage: Usage = {};
    for (const row of this.messages.values()) for (const key of fields) {
      if (row[key] !== undefined) usage[key] = (usage[key] ?? 0) + row[key]!;
    }
    return { usage, usage_quality: "partial", usage_source: "claude-main-loop-input-v1" };
  }
}
