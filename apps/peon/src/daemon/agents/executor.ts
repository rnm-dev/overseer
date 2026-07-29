import { getAgentDriver, requireAgentDriver } from "./registry.js";
import type { AgentEvent, AgentExit, AgentRun, AgentRunOptions } from "./registry.js";

// Provider-neutral contract used by sessions service. Concrete CLI flags and event
// shapes live behind the adapters below; this module is the proxy that selects
// an adapter for every invocation.
export type { AgentEvent, AgentExit, AgentRun, AgentRunOptions } from "./registry.js";

export function runAgent(opts: AgentRunOptions): AgentRun {
  return requireAgentDriver(opts.agent).run(opts);
}

// Read-time compatibility boundary for transcript files written before the
// canonical event contract existed. New files are already normalized before
// append; this keeps old Claude-shaped history from bypassing the proxy merely
// because it was persisted by an older daemon build.
export function normalizeStoredAgentEvent(agent: string, raw: Record<string, unknown>): AgentEvent | null {
  const driver = getAgentDriver(agent);
  if (driver) return driver.normalizeStoredEvent(raw);
  // Keep historical transcripts inspectable even when their runtime driver is
  // no longer installed. Only already-canonical envelopes cross this fallback.
  if (typeof raw.type !== "string" || !["system", "assistant", "user", "user_message", "result", "stderr", "preview", "warning"].includes(raw.type)) return null;
  return raw as AgentEvent;
}
