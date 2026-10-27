import path from "node:path";
import { storedTimestampMetadata } from "../sessions/index.js";
// Session records written before Peon knew more than one harness carry no
// `agent`; they were all Claude Code. Use this only to read such records.
export const LEGACY_DEFAULT_AGENT = "claude-code";
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
// The public name a driver's services are addressed by: login routes, quota,
// usage attribution. `codex-app-server` is served as `codex`.
export function agentServiceName(driver) {
    return driver.serviceProvider ?? driver.id;
}
const drivers = new Map();
export function registerAgentDriver(driver) {
    if (!driver.id.trim())
        throw new Error("agent driver id must not be empty");
    if (drivers.has(driver.id))
        throw new Error(`agent driver already registered: ${driver.id}`);
    drivers.set(driver.id, driver);
    return driver;
}
export function getAgentDriver(id) {
    return typeof id === "string" ? drivers.get(id) : undefined;
}
export function getAgentServiceDriver(provider) {
    if (typeof provider !== "string")
        return undefined;
    return drivers.get(provider)
        ?? [...drivers.values()].find((driver) => driver.serviceProvider === provider);
}
export function requireAgentDriver(id) {
    const driver = getAgentDriver(id);
    if (!driver)
        throw new Error(`Agent driver "${String(id)}" is not registered`);
    if (!driver.available())
        throw new Error(`Agent driver "${driver.id}" is unavailable`);
    return driver;
}
export function listAgentDrivers(options = {}) {
    return [...drivers.values()].filter((driver) => (options.visible === undefined || driver.visible === options.visible)
        && (options.available === undefined || driver.available() === options.available));
}
// Shared normalization helpers for driver modules. Peon writes these event
// types itself, so they read the same whichever harness ran the session.
export function previewEvent(raw) {
    const timestamps = storedTimestampMetadata(raw);
    if (raw.type === "warning") {
        if (typeof raw.sessionId !== "string" || typeof raw.message !== "string"
            || !["context_near_limit", "payload_near_limit", "payload_truncated", "turn_limit_exceeded", "task_timeout"].includes(String(raw.code)))
            return null;
        const fields = [
            "sessionId", "code", "message", "source", "currentBytes", "limitBytes", "retainedBytes",
            "currentTokens", "limitTokens", "action", "logPath", "logError",
            "canResume", "maxTurns", "turnBudget", "turnsUsed", "timeoutMs", "elapsedMs",
        ];
        const event = { type: "warning" };
        for (const field of fields)
            if (raw[field] !== undefined)
                event[field] = raw[field];
        return { ...event, ...timestamps };
    }
    if (raw.type === "preview") {
        if (typeof raw.path !== "string" || !raw.path.trim())
            return null;
        const renderable = new Set([".html", ".htm", ".md", ".markdown", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"]);
        if (raw.author === "agent" && !renderable.has(path.extname(raw.path).toLowerCase()))
            return null;
        return {
            type: "preview", path: raw.path,
            name: typeof raw.name === "string" && raw.name.trim() ? raw.name : raw.path.split(/[\\/]/).pop() || "Preview",
            ...(typeof raw.author === "string" ? { author: raw.author } : {}), ...timestamps,
        };
    }
    if (raw.type === "user_message") {
        const replyTo = storedReplyTo(raw.replyTo);
        return {
            type: "user_message", text: typeof raw.text === "string" ? raw.text : "",
            ...(Array.isArray(raw.attachments) ? { attachments: raw.attachments } : {}),
            ...(typeof raw.permissionMode === "string" ? { permissionMode: raw.permissionMode } : {}),
            ...(typeof raw.author === "string" ? { author: raw.author } : {}),
            ...(typeof raw.model === "string" ? { model: raw.model } : {}),
            ...(typeof raw.reasoningEffort === "string" ? { reasoningEffort: raw.reasoningEffort } : {}),
            ...(typeof raw.commandId === "string" ? { commandId: raw.commandId } : {}),
            ...(replyTo ? { replyTo } : {}), ...timestamps,
        };
    }
    if (raw.type === "participant_message")
        return raw;
    if (raw.type === "stderr")
        return { type: "stderr", text: typeof raw.text === "string" ? raw.text : String(raw.text ?? ""), ...timestamps };
    return null;
}
// This sits at the provider-normalization boundary because Claude's legacy
// reader reconstructs user_message envelopes field-by-field. Keep durable
// reply metadata through a restart while refusing malformed historical rows.
function storedReplyTo(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const replyTo = value;
    if (typeof replyTo.eventId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(replyTo.eventId))
        return null;
    if (typeof replyTo.selectedText !== "string" || !replyTo.selectedText.trim())
        return null;
    if ([...replyTo.selectedText].length > 8_192 || Buffer.byteLength(replyTo.selectedText, "utf8") > 16 * 1024)
        return null;
    return { eventId: replyTo.eventId, selectedText: replyTo.selectedText };
}
export function canonicalStored(raw) {
    const common = previewEvent(raw);
    if (common)
        return common;
    if (typeof raw.type !== "string" || !["system", "assistant", "user", "result"].includes(raw.type))
        return null;
    const { timestamp: _timestamp, sourceTimestamp: _sourceTimestamp, createdAt: _createdAt, ...fields } = raw;
    return { ...fields, ...storedTimestampMetadata(raw) };
}
export function normalizeOutcome(value, includePreview) {
    const output = value && typeof value === "object" ? value : null;
    if (!output || !["success", "failure", "needs_human"].includes(String(output.result)) || typeof output.summary !== "string")
        return null;
    return { result: output.result, summary: output.summary,
        ...(includePreview ? { previewPath: typeof output.previewPath === "string" && output.previewPath.trim() ? output.previewPath.trim() : null } : {}) };
}
export function agentAuthByAgent() {
    return Object.fromEntries(listAgentDrivers().flatMap((driver) => driver.services.authStatus ? [[driver.id, driver.services.authStatus()]] : []));
}
export function startAgentDriverRuntimes() {
    for (const driver of listAgentDrivers())
        driver.startRuntime?.();
}
export async function shutdownAgentDriverRuntimes() {
    await Promise.all(listAgentDrivers().flatMap((driver) => driver.shutdownRuntime ? [driver.shutdownRuntime()] : []));
}
export const agentServices = {
    async quota(agent, force = false) {
        return getAgentServiceDriver(agent)?.services.quota?.(force);
    },
    async quotas(force = false) {
        const providers = await Promise.all(listAgentDrivers().flatMap((driver) => driver.services.quota ? [driver.services.quota(force)] : []));
        return { updatedAt: providers.length ? Math.max(...providers.map((item) => item.updatedAt)) : Date.now(), providers };
    },
    async capabilities(agent, force = false) {
        return getAgentServiceDriver(agent)?.services.capabilities?.(force);
    },
    async allCapabilities(force = false) {
        const providers = await Promise.all(listAgentDrivers().flatMap((driver) => driver.services.capabilities ? [driver.services.capabilities(force)] : []));
        return { updatedAt: providers.length ? Math.max(...providers.map((item) => item.updatedAt)) : Date.now(), providers };
    },
};
