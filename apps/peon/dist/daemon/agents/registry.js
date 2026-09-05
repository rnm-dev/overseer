import path from "node:path";
import { storedTimestampMetadata } from "../sessions/index.js";
import { claudeCodeAuth } from "../providers/claudeCodeAuth.js";
import { CODEX_OUTCOME_SCHEMA, OUTCOME_SCHEMA } from "../sessions/index.js";
import { forkClaudeCodeSession, normalizeClaudeCodeEvent, runClaudeCode } from "./claudeCode.js";
import { codexAppServerHealth, forkCodexAppServerThread, getCodexAppServerRuntime, reconcileCodexAppServerTurn, runCodexAppServer, shutdownCodexAppServerRuntime } from "./codexAppServer.js";
import { getClaudeQuota, getCodexQuota } from "../providers/providerQuota.js";
import { getClaudeCapabilities, getCodexCapabilities } from "../providers/providerCapabilities.js";
import { createSelfUpdatingCliUpdater } from "./cliUpdater.js";
import { ClaudeLoginService } from "./claudeLogin.js";
import { CodexLoginService } from "./codexLogin.js";
import { settings as loginSettings } from "../settings/index.js";
import { claudeModelCatalogService, createCodexModelCatalogService, } from "./modelDiscovery.js";
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
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
function previewEvent(raw) {
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
function canonicalStored(raw) {
    const common = previewEvent(raw);
    if (common)
        return common;
    if (typeof raw.type !== "string" || !["system", "assistant", "user", "result"].includes(raw.type))
        return null;
    const { timestamp: _timestamp, sourceTimestamp: _sourceTimestamp, createdAt: _createdAt, ...fields } = raw;
    return { ...fields, ...storedTimestampMetadata(raw) };
}
function normalizeOutcome(value, includePreview) {
    const output = value && typeof value === "object" ? value : null;
    if (!output || !["success", "failure", "needs_human"].includes(String(output.result)) || typeof output.summary !== "string")
        return null;
    return { result: output.result, summary: output.summary,
        ...(includePreview ? { previewPath: typeof output.previewPath === "string" && output.previewPath.trim() ? output.previewPath.trim() : null } : {}) };
}
const effort = (ids, defaultId) => ids.map((id) => ({ id, label: id === "xhigh" ? "Extra high" : id[0].toUpperCase() + id.slice(1), ...(id === defaultId ? { default: true } : {}) }));
const claudeFrontierEfforts = () => effort(["low", "medium", "high", "xhigh", "max"], "high");
const codexEfforts = (ids, defaultId) => effort(ids, defaultId);
const claudeModels = [
    { id: "claude-fable-5-1", label: "Fable 5.1", reasoningEfforts: claudeFrontierEfforts() },
    { id: "claude-opus-5", label: "Opus 5", alias: "opus", reasoningEfforts: claudeFrontierEfforts() },
    { id: "claude-sonnet-5", label: "Sonnet 5", alias: "sonnet", default: true, reasoningEfforts: claudeFrontierEfforts() },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", alias: "haiku" },
    { id: "claude-fable-5", label: "Fable 5", reasoningEfforts: claudeFrontierEfforts() },
];
const codexModels = [
    { id: "gpt-6-astra", label: "6 Astra", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh", "max"], "medium") },
    { id: "gpt-5.6-sol", label: "5.6 Sol", default: true, reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh", "max", "ultra"], "low") },
    { id: "gpt-5.6-terra", label: "5.6 Terra", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh", "max", "ultra"], "medium") },
    { id: "gpt-5.6-luna", label: "5.6 Luna", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh", "max"], "medium") },
    { id: "gpt-5.5", label: "5.5", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh"], "medium") },
    { id: "gpt-5.3-codex-spark", label: "5.3 Codex Spark", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh"], "high") },
    { id: "gpt-5.4", label: "5.4", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh"], "medium") },
    { id: "gpt-5.4-mini", label: "5.4 Mini", reasoningEfforts: codexEfforts(["low", "medium", "high", "xhigh"], "medium") },
];
const codexModelCatalogService = createCodexModelCatalogService(getCodexAppServerRuntime);
const claudeLogin = new ClaudeLoginService({
    command: () => loginSettings.get().agentCommand || "claude",
    onSuccess: () => { claudeCodeAuth.clearObservedFailure(); void claudeCodeAuth.refresh(); },
});
const codexLogin = new CodexLoginService({ command: () => loginSettings.get().codexCommand || "codex" });
const fromCatalog = (models, value) => typeof value === "string" ? models.find((model) => model.id === value || model.alias === value)?.id : undefined;
const modelEffort = (models, value, model) => {
    const selected = models.find((candidate) => candidate.id === fromCatalog(models, model))
        ?? models.find((candidate) => candidate.default)
        ?? models[0];
    return selected?.reasoningEfforts?.some((item) => item.id === value) ? value : undefined;
};
registerAgentDriver({
    id: "claude-code", label: "Claude Code", available: () => true, visible: true, models: claudeModels,
    reasoningEfforts: effort(["low", "medium", "high", "xhigh", "max"], "high"),
    canonicalModel: (value) => fromCatalog(claudeModels, value) ?? (typeof value === "string" && /^claude-[a-z0-9.-]+$/i.test(value) ? value : undefined),
    reasoningEffort: (value, model) => modelEffort(claudeModels, value, model),
    command: (current) => current.agentCommand,
    conversation: { initialBackendId: (id) => id, recoverBackendId: (id, persisted) => persisted ?? id },
    outcomeSchema: (expects) => expects ? OUTCOME_SCHEMA : undefined, normalizeOutcome: (value) => normalizeOutcome(value, false),
    normalizeStoredEvent(raw) {
        // Provider normalization must not reinterpret persisted accounting or strip
        // harness-owned invocation identity when replaying after restart/branch.
        if (raw.type === "result" || (raw.type === "system" && raw.subtype === "usage"))
            return canonicalStored(raw);
        const common = previewEvent(raw);
        const event = common ?? normalizeClaudeCodeEvent(raw);
        return event ? { ...event, ...storedTimestampMetadata(raw) } : null;
    },
    run: runClaudeCode,
    forkConversation: forkClaudeCodeSession,
    interrupt: (run) => run.kill(), shutdown: (run) => run.kill(),
    shutdownRuntime: () => claudeLogin.shutdown(),
    auth: {
        observeSuccess: () => claudeCodeAuth.clearObservedFailure(),
        observeFailure: (message) => { if (claudeCodeAuth.isLikelyAuthFailure(message))
            claudeCodeAuth.recordPossibleAuthFailure(message, Date.now()); },
    },
    capabilities: { steering: false, cancellation: true, recovery: true, quota: true, status: true, cliUpdate: true, branching: true, branchAtTurn: false, login: true },
    services: {
        claudeLogin,
        status: () => claudeCodeAuth.getState(), quota: getClaudeQuota,
        capabilities: getClaudeCapabilities,
        modelCatalog: claudeModelCatalogService,
        cliUpdate: createSelfUpdatingCliUpdater({
            packageName: "@anthropic-ai/claude-code",
            versionPattern: /\bClaude Code\b/i,
            nativePathFragments: ["/.local/share/claude/versions/"],
        }),
    },
});
registerAgentDriver({
    id: "codex-app-server", serviceProvider: "codex", label: "Codex", available: () => true, visible: true, models: codexModels,
    reasoningEfforts: effort(["low", "medium", "high", "xhigh", "max", "ultra"], "medium"),
    canonicalModel: (value) => fromCatalog(codexModels, value),
    reasoningEffort: (value, model) => modelEffort(codexModels, value, model),
    command: (current) => current.codexCommand,
    conversation: { initialBackendId: () => null, recoverBackendId: (_id, persisted) => persisted },
    outcomeSchema: (expects) => expects ? CODEX_OUTCOME_SCHEMA : undefined,
    normalizeOutcome: (value) => normalizeOutcome(value, true),
    normalizeStoredEvent: canonicalStored,
    run: runCodexAppServer,
    steer: (run, input, callbacks) => {
        const attempt = run.steer?.(input);
        if (!attempt)
            return false;
        void attempt.then(callbacks.accepted, callbacks.rejected);
        return true;
    },
    reconcile: reconcileCodexAppServerTurn,
    forkConversation: forkCodexAppServerThread,
    interrupt: (run) => run.kill(), shutdown: (run) => run.kill(),
    shutdownRuntime: async () => { await Promise.all([shutdownCodexAppServerRuntime(), codexLogin.shutdown()]); },
    auth: { observeSuccess() { }, observeFailure() { } },
    capabilities: { steering: true, cancellation: true, recovery: true, quota: true, status: true, cliUpdate: true, branching: true, branchAtTurn: true, login: true },
    services: {
        codexLogin,
        status: () => codexAppServerHealth(), quota: getCodexQuota,
        capabilities: getCodexCapabilities,
        modelCatalog: codexModelCatalogService,
        cliUpdate: createSelfUpdatingCliUpdater({ packageName: "@openai/codex", versionPattern: /\bcodex(?:-cli)?\b/i }),
    },
});
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
