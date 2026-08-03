import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDir } from "./xdgPaths.js";
export const MANAGED_PLUGIN_INQUIRY_CAPABILITY = "managed-plugin-inquiry-v1";
export const MANAGED_PLUGIN_INQUIRY_TTL_MS = 10 * 60_000;
const MANAGED_PLUGIN_IDS = new Set(["posthog@openai-curated-remote"]);
const INQUIRY_RECONCILE_MS = 1_000;
export class ManagedPluginInquiryError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function bounded(value, limit) {
    return typeof value === "string" && value.length <= limit ? value : null;
}
function safeStrings(value, limit = 16) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length <= 128).slice(0, limit) : [];
}
function publicInquiry(inquiry) {
    const { threadId: _thread, turnId: _turn, runtimeGeneration: _generation, marketplaceName: _marketplace, marketplacePath: _path, catalogPluginName: _catalogPluginName, ...result } = inquiry;
    return result;
}
export class ManagedPluginInquiryService {
    file;
    listSessions;
    now;
    records = new Map();
    waiters = new Map();
    reconcileTimers = new Map();
    runtime = null;
    runtimeHealthListener = null;
    constructor(file = path.join(stateDir(), "managed-plugin-inquiries-v1.json"), listSessions, now = Date.now) {
        this.file = file;
        this.listSessions = listSessions;
        this.now = now;
        this.restore();
    }
    bindRuntime(runtime) {
        if (this.runtime === runtime)
            return;
        if (this.runtime && this.runtimeHealthListener)
            this.runtime.off("health", this.runtimeHealthListener);
        this.runtime = runtime;
        this.runtimeHealthListener = (health) => this.handleHealth(health);
        runtime.on("health", this.runtimeHealthListener);
    }
    async handleDynamicToolCall(params, generation) {
        const call = this.dynamicCall(params);
        if (!call || call.tool !== "request_plugin_install") {
            return { contentItems: [{ type: "inputText", text: "Dynamic tool calls are unavailable in unattended Peon sessions." }], success: false };
        }
        const args = object(call.arguments);
        const pluginId = bounded(args?.plugin_id, 160);
        if (!pluginId)
            return { contentItems: [{ type: "inputText", text: "The managed plugin id is invalid." }], success: false };
        if (!MANAGED_PLUGIN_IDS.has(pluginId))
            return { contentItems: [{ type: "inputText", text: "The requested plugin is not managed by this Peon." }], success: false };
        const session = this.listSessions().find((candidate) => candidate.backendSessionId === call.threadId);
        if (!session || session.status !== "running" || session.backendTurnId !== call.turnId) {
            return { contentItems: [{ type: "inputText", text: "The originating session turn is no longer active." }], success: false };
        }
        const duplicate = [...this.records.values()].find((candidate) => candidate.status === "pending"
            && candidate.threadId === call.threadId && candidate.turnId === call.turnId && candidate.plugin.id === pluginId);
        if (duplicate)
            return this.wait(duplicate.inquiryId);
        const plugin = await this.lookupPlugin(pluginId);
        if (!plugin)
            return { contentItems: [{ type: "inputText", text: "The requested managed plugin is not available." }], success: false };
        const timestamp = this.now();
        const inquiry = {
            version: "inquiry-v1", inquiryId: randomUUID(), kind: "managed_plugin_install", status: "pending",
            sessionId: session.id, threadId: call.threadId, turnId: call.turnId, runtimeGeneration: generation,
            marketplaceName: plugin.marketplaceName, marketplacePath: plugin.marketplacePath, catalogPluginName: plugin.catalogPluginName,
            plugin: plugin.metadata, createdAt: new Date(timestamp).toISOString(),
            expiresAt: new Date(timestamp + MANAGED_PLUGIN_INQUIRY_TTL_MS).toISOString(), updatedAt: new Date(timestamp).toISOString(),
            respondedBy: null, terminalCode: null, authPolicy: null, appsNeedingAuth: [],
        };
        this.records.set(inquiry.inquiryId, inquiry);
        this.persist();
        this.scheduleReconcile(inquiry.inquiryId);
        return this.wait(inquiry.inquiryId);
    }
    list(sessionId) {
        this.reconcile();
        return [...this.records.values()].filter((item) => item.sessionId === sessionId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicInquiry);
    }
    get(sessionId, inquiryId) {
        this.reconcile();
        const inquiry = this.require(sessionId, inquiryId);
        return publicInquiry(inquiry);
    }
    async respond(sessionId, inquiryId, actor, action) {
        this.reconcile();
        const inquiry = this.require(sessionId, inquiryId);
        if (inquiry.respondedBy && inquiry.respondedBy !== actor)
            throw new ManagedPluginInquiryError(403, "INQUIRY_ACTOR_MISMATCH", "inquiry was answered by another operator");
        if (inquiry.status !== "pending")
            return publicInquiry(inquiry);
        if (action === "cancel") {
            this.terminal(inquiry, "cancelled", "INQUIRY_CANCELLED", actor, false);
            return publicInquiry(inquiry);
        }
        const runtime = this.runtime;
        const health = runtime?.getHealth();
        if (!runtime || health?.status !== "healthy")
            return this.fail(inquiry, "INQUIRY_RUNTIME_LOST", actor);
        if (health.generation !== inquiry.runtimeGeneration)
            return this.fail(inquiry, "INQUIRY_STALE_GENERATION", actor);
        const session = this.listSessions().find((candidate) => candidate.id === sessionId);
        if (!session || session.status !== "running" || session.backendSessionId !== inquiry.threadId || session.backendTurnId !== inquiry.turnId) {
            return this.fail(inquiry, "INQUIRY_TURN_ENDED", actor);
        }
        inquiry.status = "installing";
        inquiry.respondedBy = actor;
        inquiry.updatedAt = new Date(this.now()).toISOString();
        this.persist();
        try {
            const response = object(await runtime.request("plugin/install", {
                pluginName: inquiry.catalogPluginName ?? inquiry.plugin.name,
                marketplacePath: inquiry.marketplacePath,
                remoteMarketplaceName: inquiry.marketplacePath ? null : inquiry.marketplaceName,
            }, 120_000));
            if (runtime.getHealth().generation !== inquiry.runtimeGeneration)
                return this.fail(inquiry, "INQUIRY_STALE_GENERATION", actor);
            const authPolicy = response?.authPolicy === "ON_INSTALL" || response?.authPolicy === "ON_USE" ? response.authPolicy : null;
            const apps = Array.isArray(response?.appsNeedingAuth) ? response.appsNeedingAuth.map(object).filter((app) => !!app)
                .filter((app) => typeof app.id === "string" && typeof app.name === "string").slice(0, 32).map((app) => ({
                id: String(app.id).slice(0, 160), name: String(app.name).slice(0, 160), category: bounded(app.category, 160), description: bounded(app.description, 1_000),
            })) : [];
            inquiry.authPolicy = authPolicy;
            inquiry.appsNeedingAuth = apps;
            this.terminal(inquiry, apps.length ? "auth_required" : "installed", null, actor, true);
            return publicInquiry(inquiry);
        }
        catch {
            return this.fail(inquiry, "INQUIRY_FAILED", actor);
        }
    }
    async lookupPlugin(pluginId) {
        const runtime = this.runtime;
        if (!runtime)
            return null;
        const response = object(await runtime.request("plugin/list", { forceRefetch: false }));
        const marketplaces = Array.isArray(response?.marketplaces) ? response.marketplaces.map(object).filter((item) => !!item) : [];
        for (const marketplace of marketplaces) {
            const summaries = Array.isArray(marketplace.plugins) ? marketplace.plugins.map(object).filter((item) => !!item) : [];
            const summary = summaries.find((item) => item.id === pluginId || item.name === pluginId || `${item.name}@${marketplace.name}` === pluginId);
            if (!summary || !this.validSummary(summary))
                continue;
            const marketplaceName = String(marketplace.name);
            const marketplacePath = bounded(marketplace.path, 4_096);
            const catalogPluginName = marketplacePath ? summary.name : bounded(summary.remotePluginId, 320) ?? summary.name;
            const detail = object(await runtime.request("plugin/read", { pluginName: catalogPluginName, marketplacePath, remoteMarketplaceName: marketplacePath ? null : marketplaceName }));
            const plugin = object(detail?.plugin);
            const iface = object(summary.interface);
            const detailSummary = object(plugin?.summary) ?? summary;
            return { marketplaceName, marketplacePath, catalogPluginName, metadata: {
                    id: String(detailSummary.id), name: String(detailSummary.name),
                    displayName: bounded(iface?.displayName, 160) ?? String(detailSummary.name),
                    description: bounded(plugin?.description, 2_000) ?? bounded(iface?.shortDescription, 1_000),
                    developerName: bounded(iface?.developerName, 160), category: bounded(iface?.category, 160),
                    capabilities: safeStrings(iface?.capabilities), authPolicy: detailSummary.authPolicy,
                    installPolicy: detailSummary.installPolicy, installed: detailSummary.installed === true,
                } };
        }
        return null;
    }
    validSummary(value) {
        return typeof value.id === "string" && value.id.length <= 160 && typeof value.name === "string" && value.name.length <= 160
            && typeof value.installed === "boolean" && ["ON_INSTALL", "ON_USE"].includes(String(value.authPolicy))
            && ["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(String(value.installPolicy));
    }
    dynamicCall(value) {
        const call = object(value);
        return call && typeof call.tool === "string" && typeof call.threadId === "string" && typeof call.turnId === "string"
            ? call : null;
    }
    wait(id) {
        return new Promise((resolve) => {
            const waiting = this.waiters.get(id) ?? [];
            waiting.push({ resolve });
            this.waiters.set(id, waiting);
        });
    }
    require(sessionId, inquiryId) {
        const inquiry = this.records.get(inquiryId);
        if (!inquiry || inquiry.sessionId !== sessionId)
            throw new ManagedPluginInquiryError(404, "UNKNOWN_INQUIRY", "unknown inquiry");
        return inquiry;
    }
    fail(inquiry, code, actor) {
        this.terminal(inquiry, code === "INQUIRY_EXPIRED" ? "expired" : "failed", code, actor, false);
        return publicInquiry(inquiry);
    }
    terminal(inquiry, status, code, actor, success) {
        inquiry.status = status;
        inquiry.terminalCode = code;
        inquiry.respondedBy ??= actor;
        inquiry.updatedAt = new Date(this.now()).toISOString();
        this.persist();
        const timer = this.reconcileTimers.get(inquiry.inquiryId);
        if (timer)
            clearTimeout(timer);
        this.reconcileTimers.delete(inquiry.inquiryId);
        for (const waiter of this.waiters.get(inquiry.inquiryId) ?? [])
            waiter.resolve({
                contentItems: [{ type: "inputText", text: success ? "The operator installed the managed plugin." : "The managed plugin installation was not approved." }], success,
            });
        this.waiters.delete(inquiry.inquiryId);
    }
    scheduleReconcile(inquiryId) {
        if (this.reconcileTimers.has(inquiryId))
            return;
        const timer = setTimeout(() => {
            this.reconcileTimers.delete(inquiryId);
            const inquiry = this.records.get(inquiryId);
            if (!inquiry || (inquiry.status !== "pending" && inquiry.status !== "installing"))
                return;
            this.reconcile();
            if (inquiry.status === "pending" || inquiry.status === "installing")
                this.scheduleReconcile(inquiryId);
        }, INQUIRY_RECONCILE_MS);
        timer.unref?.();
        this.reconcileTimers.set(inquiryId, timer);
    }
    reconcile() {
        const now = this.now();
        for (const inquiry of this.records.values()) {
            if (inquiry.status !== "pending" && inquiry.status !== "installing")
                continue;
            if (Date.parse(inquiry.expiresAt) <= now) {
                this.fail(inquiry, "INQUIRY_EXPIRED", null);
                continue;
            }
            const session = this.listSessions().find((candidate) => candidate.id === inquiry.sessionId);
            if (!session || session.status !== "running" || session.backendSessionId !== inquiry.threadId || session.backendTurnId !== inquiry.turnId)
                this.fail(inquiry, "INQUIRY_TURN_ENDED", null);
        }
    }
    handleHealth(health) {
        for (const inquiry of this.records.values())
            if ((inquiry.status === "pending" || inquiry.status === "installing")
                && (health.status !== "healthy" || health.generation !== inquiry.runtimeGeneration))
                this.fail(inquiry, "INQUIRY_RUNTIME_LOST", null);
    }
    restore() {
        try {
            const parsed = JSON.parse(readFileSync(this.file, "utf8"));
            if (parsed.version !== 1 || !Array.isArray(parsed.inquiries))
                return;
            for (const inquiry of parsed.inquiries)
                if (inquiry?.version === "inquiry-v1" && typeof inquiry.inquiryId === "string") {
                    if (inquiry.status === "pending" || inquiry.status === "installing") {
                        inquiry.status = "failed";
                        inquiry.terminalCode = "INQUIRY_RUNTIME_LOST";
                        inquiry.updatedAt = new Date(this.now()).toISOString();
                    }
                    this.records.set(inquiry.inquiryId, inquiry);
                }
            this.persist();
        }
        catch { /* Missing or corrupt state fails closed and exposes nothing. */ }
    }
    persist() {
        mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const temp = `${this.file}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify({ version: 1, inquiries: [...this.records.values()] }), { mode: 0o600 });
        renameSync(temp, this.file);
    }
}
