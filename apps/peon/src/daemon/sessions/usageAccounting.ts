import type { AgentEvent } from "../agents/index.js";
import type { SessionRecord, SessionUsage } from "./sessionTypes.js";

export const usageNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function usageFromEvent(event: AgentEvent): SessionUsage {
  const raw = event.usage as Record<string, unknown> | undefined;
  return {
    totalCostUsd: usageNumber(event.total_cost_usd), durationMs: usageNumber(event.duration_ms),
    inputTokens: usageNumber(raw?.input_tokens), outputTokens: usageNumber(raw?.output_tokens),
    cacheCreationInputTokens: usageNumber(raw?.cache_creation_input_tokens),
    cacheReadInputTokens: usageNumber(raw?.cache_read_input_tokens),
    reasoningOutputTokens: usageNumber(raw?.reasoning_output_tokens),
    quality: event.usage_quality === "reported" ? "reported" : event.usage_quality === "partial" ? "partial" : "legacy",
    source: typeof event.usage_source === "string" ? event.usage_source : "legacy-result",
  };
}

export function usageModelsFromEvent(event: AgentEvent): Record<string, SessionUsage> | undefined {
  if (!event.usage_by_model || typeof event.usage_by_model !== "object") return undefined;
  const rows = Object.entries(event.usage_by_model).filter(([, value]) => value && typeof value === "object");
  if (!rows.length) return undefined;
  return Object.fromEntries(rows.map(([model, raw]) => [model, usageFromEvent({
    type: "result", usage: raw, usage_quality: event.usage_quality, usage_source: event.usage_source,
    total_cost_usd: (raw as Record<string, unknown>).cost_usd,
  })]));
}

export function addUsage(acc: SessionUsage | null | undefined, add: SessionUsage): SessionUsage {
  const sum = (a: number | null | undefined, b: number | null | undefined): number | null =>
    a == null && b == null ? null : (a ?? 0) + (b ?? 0);
  return {
    totalCostUsd: sum(acc?.totalCostUsd, add.totalCostUsd), durationMs: sum(acc?.durationMs, add.durationMs),
    inputTokens: sum(acc?.inputTokens, add.inputTokens), outputTokens: sum(acc?.outputTokens, add.outputTokens),
    cacheCreationInputTokens: sum(acc?.cacheCreationInputTokens, add.cacheCreationInputTokens),
    cacheReadInputTokens: sum(acc?.cacheReadInputTokens, add.cacheReadInputTokens),
    reasoningOutputTokens: sum(acc?.reasoningOutputTokens, add.reasoningOutputTokens),
    quality: add.quality === "partial" || acc?.quality === "partial" ? "partial"
      : add.quality === "reported" && (!acc || acc.quality === "reported") ? "reported" : "legacy",
    source: acc && acc.source !== add.source ? "mixed" : add.source,
  };
}

export function accumulateUsage(record: SessionRecord, usage: SessionUsage, model?: string | null, models?: Record<string, SessionUsage>): void {
  record.usage = addUsage(record.usage, usage);
  record.usageByModel ??= {};
  for (const [key, value] of Object.entries(models ?? { [model || "unknown"]: usage })) {
    record.usageByModel[key] = addUsage(record.usageByModel[key], value);
  }
}
