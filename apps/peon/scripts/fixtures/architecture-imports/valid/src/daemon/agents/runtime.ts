import { settings } from "../settings/index.js";

export type RuntimeConfig = { enabled: boolean };

export function createAgentRuntime(): RuntimeConfig {
  return { enabled: !settings.get().paused };
}
