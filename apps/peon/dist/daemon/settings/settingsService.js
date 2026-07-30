import { EventEmitter } from "node:events";
import { canonicalModel, isModelForAgent, listConfiguredAgents, narrowNewSessionAgent, narrowReasoningEffort, providerDefaultModel, reasoningEffortsForModel, } from "../modelCatalog.js";
import { SettingsStore } from "./settingsStore.js";
function parseModelValue(value) {
    return typeof value === "string" || value === null || value === undefined ? value : undefined;
}
function parseEffortValue(value) {
    return typeof value === "string" || value === null || value === undefined ? value : undefined;
}
function modelDefaultEffort(agent, model) {
    return reasoningEffortsForModel(agent, model ?? providerDefaultModel(agent)).find((item) => item.default)?.id ?? null;
}
export class SettingsService extends EventEmitter {
    store;
    constructor(store = new SettingsStore()) {
        super();
        this.store = store;
    }
    get() {
        return this.store.get();
    }
    getPeonSocketSettings() {
        const s = this.get();
        return {
            overseerUrl: s.overseerUrl,
            overseerToken: s.overseerToken,
            ...(s.peonId.trim() ? { peonId: s.peonId } : {}),
        };
    }
    getPeonRegistrarSettings() {
        const s = this.get();
        return {
            name: s.name,
            overseerUrl: s.overseerUrl,
            overseerToken: s.overseerToken,
            fileTransferRoot: s.fileTransferRoot || "",
            heartbeatIntervalMs: s.heartbeatIntervalMs,
            paused: s.paused,
        };
    }
    getUpdateCheckerSettings() {
        const s = this.get();
        return {
            updateCheckIntervalMs: s.updateCheckIntervalMs,
            overseerUrl: s.overseerUrl,
            overseerToken: s.overseerToken,
        };
    }
    getFleetSettingsView() {
        const s = this.get();
        return {
            name: s.name || null,
            paused: s.paused,
            defaultAgent: s.defaultAgent,
            fileTransferRoot: s.fileTransferRoot || null,
            heartbeatIntervalMs: s.heartbeatIntervalMs,
            aiDefaultModel: s.ai.defaultModel ?? null,
            aiDefaultReasoningEffort: s.ai.defaultReasoningEffort ?? null,
            soul: s.ai.soul || null,
        };
    }
    getDaemonConfigurationView(settings = this.get()) {
        return {
            name: settings.name || null,
            defaultAgent: settings.defaultAgent,
            fileTransferRoot: settings.fileTransferRoot || null,
            heartbeatIntervalMs: settings.heartbeatIntervalMs,
            aiDefaultModel: settings.ai.defaultModel ?? null,
            soul: settings.ai.soul || null,
        };
    }
    patchDaemonConfiguration(body) {
        const value = this.ensureRecord(body);
        const allowed = new Set([
            "name", "defaultAgent", "fileTransferRoot", "heartbeatIntervalMs", "aiDefaultModel", "soul",
        ]);
        const unknown = Object.keys(value).find((key) => !allowed.has(key));
        if (unknown)
            this.throwBadRequest(`${unknown} is not remotely manageable`);
        if (Object.keys(value).length === 0)
            return { settings: this.get(), view: this.getDaemonConfigurationView() };
        if (typeof value.name === "string" && Buffer.byteLength(value.name) > 200) {
            this.throwBadRequest("name exceeds 200 UTF-8 bytes");
        }
        if (typeof value.fileTransferRoot === "string" && Buffer.byteLength(value.fileTransferRoot) > 4096) {
            this.throwBadRequest("fileTransferRoot exceeds 4096 UTF-8 bytes");
        }
        if (typeof value.soul === "string" && Buffer.byteLength(value.soul) > 48 * 1024) {
            this.throwBadRequest("soul exceeds 49152 UTF-8 bytes");
        }
        const normalized = { ...value };
        for (const nullable of ["name", "fileTransferRoot", "soul"]) {
            if (nullable in normalized && normalized[nullable] === null)
                normalized[nullable] = "";
        }
        const patch = this.validateAndNormalizeFleetPatch(normalized, this.get());
        const updated = this.update(patch);
        return { settings: updated, view: this.getDaemonConfigurationView(updated) };
    }
    getControlSettingsView(s = this.get()) {
        // Never hand durable credentials to a browser. Besides exposing a full-admin
        // secret, the old response let a stale Settings tab send an obsolete token
        // back with an unrelated edit and silently break enrollment.
        const safe = { ...s };
        for (const key of ["overseerToken", "pairingSecret", "strongholdToken"])
            delete safe[key];
        return {
            ...safe,
            overseerTokenSet: Boolean(s.overseerToken),
            pairingArmed: Boolean(s.pairingSecret && s.pairingSecretExpiresAt > Date.now()),
            aiDefaultModel: s.ai.defaultModel ?? null,
            aiDefaultReasoningEffort: s.ai.defaultReasoningEffort ?? null,
            soul: s.ai.soul || null,
        };
    }
    patchFleetSettings(body) {
        const patch = this.validateAndNormalizeFleetPatch(body, this.get());
        const updated = Object.keys(patch).length === 0 ? this.get() : this.update(patch);
        return { settings: updated, view: this.getFleetSettingsViewFrom(updated) };
    }
    patchControlSettings(body) {
        const patch = this.validateAndNormalizeControlPatch(body, this.get());
        const updated = Object.keys(patch).length === 0 ? this.get() : this.update(patch);
        return { settings: updated, view: this.getControlSettingsView(updated) };
    }
    update(patch) {
        const updated = this.store.update(patch);
        this.emit("change", updated);
        return updated;
    }
    validateAndNormalizeFleetPatch(payload, current) {
        const body = this.ensureRecord(payload);
        const patch = {};
        if ("paused" in body) {
            if (typeof body.paused !== "boolean")
                this.throwBadRequest("paused must be a boolean");
            patch.paused = body.paused;
        }
        if ("name" in body) {
            const name = body.name;
            if (typeof name !== "string" || name.trim() === "")
                this.throwBadRequest("name must be a non-empty string");
            patch.name = name;
        }
        if ("fileTransferRoot" in body) {
            const fileTransferRoot = body.fileTransferRoot;
            if (typeof fileTransferRoot !== "string") {
                this.throwBadRequest("fileTransferRoot must be a string (empty string disables file transfer)");
            }
            patch.fileTransferRoot = fileTransferRoot;
        }
        if ("defaultAgent" in body) {
            const agent = narrowNewSessionAgent(body.defaultAgent);
            if (!agent) {
                this.throwBadRequest(`defaultAgent must be one of: ${this.listAgents()}`);
            }
            patch.defaultAgent = agent;
        }
        if ("heartbeatIntervalMs" in body) {
            const heartbeatIntervalMs = body.heartbeatIntervalMs;
            if (typeof heartbeatIntervalMs !== "number" || !Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs < 1000 || heartbeatIntervalMs > 60_000) {
                this.throwBadRequest("heartbeatIntervalMs must be a number between 1000 and 60000");
            }
            patch.heartbeatIntervalMs = heartbeatIntervalMs;
        }
        if ("soul" in body) {
            const soul = body.soul;
            if (typeof soul !== "string")
                this.throwBadRequest("soul must be a string (empty string disables it)");
            patch.ai = { ...current.ai, soul };
        }
        const candidateAgent = patch.defaultAgent ?? current.defaultAgent;
        if ("aiDefaultModel" in body) {
            const model = parseModelValue(body.aiDefaultModel);
            if (model !== null && !isModelForAgent(candidateAgent, model)) {
                this.throwBadRequest(`aiDefaultModel is not valid for defaultAgent ${candidateAgent}`);
            }
            if (model === null) {
                patch.ai = { ...current.ai, ...patch.ai, defaultModel: null };
            }
            else {
                const canonical = canonicalModel(candidateAgent, model);
                if (canonical === undefined)
                    this.throwBadRequest(`aiDefaultModel is not valid for defaultAgent ${candidateAgent}`);
                patch.ai = { ...current.ai, ...patch.ai, defaultModel: canonical };
            }
        }
        else if (patch.defaultAgent && current.ai.defaultModel !== null && !isModelForAgent(candidateAgent, current.ai.defaultModel)) {
            patch.ai = { ...current.ai, ...patch.ai, defaultModel: null };
        }
        const effectiveModel = patch.ai?.defaultModel ?? current.ai.defaultModel;
        if ("aiDefaultReasoningEffort" in body) {
            const effort = parseEffortValue(body.aiDefaultReasoningEffort);
            if (effort === undefined)
                this.throwBadRequest("aiDefaultReasoningEffort must be a string or null");
            const normalized = effort === null ? null : narrowReasoningEffort(effort, candidateAgent, effectiveModel);
            if (effort !== null && !normalized) {
                this.throwBadRequest(`aiDefaultReasoningEffort is not valid for model ${effectiveModel ?? providerDefaultModel(candidateAgent)}`);
            }
            patch.ai = { ...current.ai, ...patch.ai, defaultReasoningEffort: normalized ?? null };
        }
        else if ((patch.defaultAgent || patch.ai?.defaultModel !== undefined)
            && current.ai.defaultReasoningEffort !== null
            && !narrowReasoningEffort(current.ai.defaultReasoningEffort, candidateAgent, effectiveModel)) {
            patch.ai = { ...current.ai, ...patch.ai, defaultReasoningEffort: modelDefaultEffort(candidateAgent, effectiveModel) };
        }
        return patch;
    }
    validateAndNormalizeControlPatch(payload, current) {
        const body = this.ensureRecord(payload);
        const managedCredential = [
            "overseerToken",
            "pairingSecret",
            "pairingSecretExpiresAt",
            "peonId",
            "strongholdToken",
        ].find((key) => key in body);
        if (managedCredential) {
            this.throwBadRequest(`${managedCredential} is managed by enrollment and cannot be changed through general settings`);
        }
        const patch = { ...body };
        const requestedAgent = "defaultAgent" in body ? narrowNewSessionAgent(body.defaultAgent) : current.defaultAgent;
        if (!requestedAgent) {
            this.throwBadRequest(`defaultAgent must be one of: ${this.listAgents()}`);
        }
        const flatModelProvided = "aiDefaultModel" in body;
        const nestedModelProvided = typeof body.ai === "object" && body.ai !== null && "defaultModel" in body.ai;
        const flatEffortProvided = "aiDefaultReasoningEffort" in body;
        const nestedEffortProvided = typeof body.ai === "object" && body.ai !== null && "defaultReasoningEffort" in body.ai;
        const flatSoulProvided = "soul" in body;
        const nestedSoulProvided = typeof body.ai === "object" && body.ai !== null && "soul" in body.ai;
        const requestedSoul = flatSoulProvided
            ? body.soul
            : nestedSoulProvided
                ? body.ai.soul
                : current.ai.soul;
        if ((flatSoulProvided || nestedSoulProvided) && requestedSoul !== null && typeof requestedSoul !== "string") {
            this.throwBadRequest("soul must be a string or null");
        }
        const requestedModel = flatModelProvided
            ? parseModelValue(body.aiDefaultModel)
            : nestedModelProvided
                ? parseModelValue(body.ai.defaultModel)
                : current.ai.defaultModel;
        if ((flatModelProvided || nestedModelProvided) && requestedModel !== null && !isModelForAgent(requestedAgent, requestedModel)) {
            this.throwBadRequest(`aiDefaultModel is not valid for defaultAgent ${requestedAgent}`);
        }
        const agentChanged = requestedAgent !== current.defaultAgent;
        const normalizedModel = (() => {
            if (!flatModelProvided && !nestedModelProvided) {
                return agentChanged && current.ai.defaultModel !== null && !isModelForAgent(requestedAgent, current.ai.defaultModel)
                    ? null
                    : current.ai.defaultModel;
            }
            if (requestedModel === null)
                return null;
            const canonical = canonicalModel(requestedAgent, requestedModel);
            if (canonical === undefined)
                this.throwBadRequest(`aiDefaultModel is not valid for defaultAgent ${requestedAgent}`);
            return canonical;
        })();
        const requestedEffort = flatEffortProvided
            ? parseEffortValue(body.aiDefaultReasoningEffort)
            : nestedEffortProvided
                ? parseEffortValue(body.ai.defaultReasoningEffort)
                : current.ai.defaultReasoningEffort;
        if ((flatEffortProvided || nestedEffortProvided) && requestedEffort === undefined) {
            this.throwBadRequest("aiDefaultReasoningEffort must be a string or null");
        }
        const modelChanged = normalizedModel !== current.ai.defaultModel;
        const normalizedEffort = (() => {
            if (!flatEffortProvided && !nestedEffortProvided && (agentChanged || modelChanged)) {
                return current.ai.defaultReasoningEffort !== null
                    && narrowReasoningEffort(current.ai.defaultReasoningEffort, requestedAgent, normalizedModel)
                    ? current.ai.defaultReasoningEffort
                    : modelDefaultEffort(requestedAgent, normalizedModel);
            }
            if (requestedEffort === null || requestedEffort === undefined)
                return null;
            const canonical = narrowReasoningEffort(requestedEffort, requestedAgent, normalizedModel);
            if (!canonical) {
                this.throwBadRequest(`aiDefaultReasoningEffort is not valid for model ${normalizedModel ?? providerDefaultModel(requestedAgent)}`);
            }
            return canonical;
        })();
        delete patch.aiDefaultModel;
        delete patch.aiDefaultReasoningEffort;
        delete patch.soul;
        patch.defaultAgent = requestedAgent;
        const requestedAi = typeof body.ai === "object" && body.ai !== null
            ? body.ai
            : {};
        patch.ai = {
            ...current.ai,
            ...requestedAi,
            defaultModel: normalizedModel,
            defaultReasoningEffort: normalizedEffort,
            soul: typeof requestedSoul === "string" ? requestedSoul : "",
        };
        return patch;
    }
    getFleetSettingsViewFrom(settings) {
        return {
            name: settings.name || null,
            paused: settings.paused,
            defaultAgent: settings.defaultAgent,
            fileTransferRoot: settings.fileTransferRoot || null,
            heartbeatIntervalMs: settings.heartbeatIntervalMs,
            aiDefaultModel: settings.ai.defaultModel ?? null,
            aiDefaultReasoningEffort: settings.ai.defaultReasoningEffort ?? null,
            soul: settings.ai.soul || null,
        };
    }
    throwBadRequest(error) {
        const e = new Error(error);
        e.code = "BAD_REQUEST";
        e.error = error;
        throw e;
    }
    listAgents() {
        return listConfiguredAgents({ visible: true, available: true }).join(", ");
    }
    ensureRecord(payload) {
        if (payload === null || typeof payload !== "object")
            return {};
        return payload;
    }
}
export const settings = new SettingsService();
