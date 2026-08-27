import { getAgentDriver, requireAgentDriver } from "./registry.js";
export function runAgent(opts) {
    return requireAgentDriver(opts.agent).run(opts);
}
// Read-time compatibility boundary for transcript files written before the
// canonical event contract existed. New files are already normalized before
// append; this keeps old Claude-shaped history from bypassing the proxy merely
// because it was persisted by an older daemon build.
export function normalizeStoredAgentEvent(agent, raw) {
    const driver = getAgentDriver(agent);
    if (driver)
        return driver.normalizeStoredEvent(raw);
    // Keep historical transcripts inspectable even when their runtime driver is
    // no longer installed. Only already-canonical envelopes cross this fallback.
    if (typeof raw.type !== "string" || !["system", "assistant", "user", "user_message", "participant_message", "result", "stderr", "preview", "warning"].includes(raw.type))
        return null;
    return raw;
}
