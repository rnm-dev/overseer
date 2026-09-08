import { EventEmitter } from "node:events";
import { getAgentDriver, listAgentDrivers, REASONING_EFFORTS, } from "../agents/index.js";
export { REASONING_EFFORTS };
export const DEFAULT_MODEL = "claude-sonnet-5";
function allDrivers() {
    return listAgentDrivers();
}
const MODEL_CATALOG_TTL_MS = 5 * 60_000;
const MODEL_CATALOG_FAILURE_TTL_MS = 30_000;
const cachedCatalogs = new Map();
const catalogRefreshes = new Map();
const catalogEvents = new EventEmitter();
export function onAgentModelCatalogChange(listener) {
    catalogEvents.on("change", listener);
    return () => catalogEvents.off("change", listener);
}
function safeError(error) {
    return error instanceof Error ? error.message : String(error);
}
function runtimeModels(agent) {
    return cachedCatalogs.get(agent)?.models ?? null;
}
function modelsFor(agent) {
    const driver = getAgentDriver(agent);
    return runtimeModels(agent) ?? driver?.models ?? [];
}
function fromModels(models, value) {
    return typeof value === "string"
        ? models.find((model) => model.id === value || model.alias === value)?.id
        : undefined;
}
function effortForModels(models, value, model) {
    const selected = models.find((candidate) => candidate.id === fromModels(models, model))
        ?? models.find((candidate) => candidate.default)
        ?? models[0];
    return selected?.reasoningEfforts?.some((item) => item.id === value) ? value : undefined;
}
function providerEfforts(agent) {
    const live = runtimeModels(agent);
    const driver = getAgentDriver(agent);
    if (!live)
        return driver?.reasoningEfforts;
    const defaultEffort = (live.find((model) => model.default) ?? live[0])
        ?.reasoningEfforts?.find((item) => item.default)?.id;
    const seen = new Set();
    const efforts = live.flatMap((model) => model.reasoningEfforts ?? []).flatMap((item) => {
        if (seen.has(item.id))
            return [];
        seen.add(item.id);
        return [{ id: item.id, label: item.label, ...(item.id === defaultEffort ? { default: true } : {}) }];
    });
    return efforts.length ? efforts : undefined;
}
function catalogMetadata(agent) {
    const cached = cachedCatalogs.get(agent);
    return {
        catalogSource: cached?.models ? (cached.error ? "stale-cli" : "cli") : "fallback",
        catalogUpdatedAt: cached?.updatedAt ?? null,
        catalogError: cached?.error ?? null,
    };
}
export function invalidateAgentModelCatalog(agent) {
    if (agent)
        cachedCatalogs.delete(agent);
    else
        cachedCatalogs.clear();
    catalogEvents.emit("change");
}
export async function refreshAgentModelCatalog(agent, command, force = false) {
    const driver = getAgentDriver(agent);
    const service = driver?.services.modelCatalog;
    if (!driver || !service)
        return;
    const current = cachedCatalogs.get(agent);
    const ttl = current?.error ? MODEL_CATALOG_FAILURE_TTL_MS : MODEL_CATALOG_TTL_MS;
    if (!force && current && Date.now() - current.checkedAt < ttl)
        return;
    const active = catalogRefreshes.get(agent);
    if (active)
        return active;
    const refresh = (async () => {
        try {
            const models = await service.discover(command);
            if (!models.length)
                throw new Error(`${driver.label} CLI returned an empty model catalog`);
            const now = Date.now();
            cachedCatalogs.set(agent, { models: models.map((model) => ({ ...model })), checkedAt: now, updatedAt: now, error: null });
        }
        catch (error) {
            const previous = cachedCatalogs.get(agent);
            cachedCatalogs.set(agent, {
                models: previous?.models ?? null,
                checkedAt: Date.now(),
                updatedAt: previous?.updatedAt ?? null,
                error: safeError(error),
            });
        }
        catalogEvents.emit("change");
    })();
    catalogRefreshes.set(agent, refresh);
    try {
        await refresh;
    }
    finally {
        if (catalogRefreshes.get(agent) === refresh)
            catalogRefreshes.delete(agent);
    }
}
export async function refreshAgentModelCatalogs(current, force = false) {
    await Promise.all(listAgentDrivers({ visible: true, available: true }).map((driver) => refreshAgentModelCatalog(driver.id, driver.command(current), force)));
}
function publicCapabilities(driver) {
    return { ...driver.capabilities };
}
export function codingAgents() {
    return allDrivers().map((driver) => driver.id);
}
export function aiProviders() {
    return allDrivers().map((driver) => ({
        agent: driver.id, label: driver.label, models: modelsFor(driver.id),
        reasoningEfforts: providerEfforts(driver.id), available: driver.available(),
        visible: driver.visible, legacy: driver.legacy, capabilities: publicCapabilities(driver),
        status: driver.services.status?.() ?? null,
        defaultModel: providerDefaultModel(driver.id),
        ...catalogMetadata(driver.id),
    }));
}
export function narrowAgent(value) {
    return getAgentDriver(value)?.id;
}
export function narrowNewSessionAgent(value) {
    const driver = getAgentDriver(value);
    return driver?.available() && driver.visible ? driver.id : undefined;
}
export function providerDefaultModel(agent) {
    const driver = getAgentDriver(agent);
    const models = modelsFor(agent);
    const model = models.find((candidate) => candidate.default) ?? models[0];
    if (!model)
        throw new Error(`no model catalog for agent ${agent}`);
    return model.id;
}
export function canonicalModel(agent, value) {
    const live = runtimeModels(agent);
    return live ? fromModels(live, value) : getAgentDriver(agent)?.canonicalModel(value);
}
export function isModelForAgent(agent, value) {
    return canonicalModel(agent, value) !== undefined;
}
export function modelCatalog(defaultAgent, defaultModel, defaultReasoningEffort = null) {
    return listAgentDrivers({ visible: true, available: true }).map((driver) => {
        const driverModels = modelsFor(driver.id);
        const selected = driver.id === defaultAgent
            ? (defaultModel && canonicalModel(driver.id, defaultModel)) || providerDefaultModel(defaultAgent)
            : null;
        const known = selected ? driverModels.some((model) => model.id === selected) : true;
        const configuredEffort = driver.id === defaultAgent
            ? narrowReasoningEffort(defaultReasoningEffort, driver.id, selected)
            : undefined;
        const models = driverModels.map(({ default: _default, ...model }) => {
            const reasoningEfforts = model.reasoningEfforts?.map(({ default: _effortDefault, ...item }) => configuredEffort && model.id === selected && item.id === configuredEffort
                ? { ...item, default: true }
                : configuredEffort && model.id === selected
                    ? item
                    : { ...item, ...(_effortDefault ? { default: true } : {}) });
            return model.id === selected
                ? { ...model, ...(reasoningEfforts ? { reasoningEfforts } : {}), default: true }
                : {
                    ...model,
                    ...(reasoningEfforts ? { reasoningEfforts } : {}),
                    ...(driver.id !== defaultAgent && _default ? { default: true } : {}),
                };
        });
        if (selected && !known)
            models.push({ id: selected, label: selected, default: true });
        return {
            agent: driver.id, label: driver.label, models,
            reasoningEfforts: providerEfforts(driver.id)?.map((item) => ({ ...item })),
            available: driver.available(), visible: driver.visible, legacy: driver.legacy,
            capabilities: publicCapabilities(driver),
            status: driver.services.status?.() ?? null,
            defaultModel: providerDefaultModel(driver.id),
            ...catalogMetadata(driver.id),
        };
    });
}
export function listConfiguredAgents(options = {}) {
    return listAgentDrivers(options).map((driver) => driver.id);
}
export function isValidModel(value) {
    return canonicalModel("claude-code", value) !== undefined;
}
export function narrowModel(value, agent = "claude-code") {
    return canonicalModel(agent, value);
}
export function resolveModel(agent, turnModel, sessionModel, savedAgent, savedModel) {
    const driver = getAgentDriver(agent);
    if (!driver)
        throw new Error(`Agent driver "${agent}" is not registered`);
    return canonicalModel(agent, turnModel) ?? canonicalModel(agent, sessionModel)
        ?? (savedAgent === agent ? canonicalModel(agent, savedModel) : undefined) ?? providerDefaultModel(agent);
}
export function resolveReasoningEffort(agent, turnEffort, sessionEffort, savedAgent, savedEffort, model) {
    const driver = getAgentDriver(agent);
    if (!driver)
        throw new Error(`Agent driver "${agent}" is not registered`);
    return narrowReasoningEffort(turnEffort, agent, model)
        ?? narrowReasoningEffort(sessionEffort, agent, model)
        ?? (savedAgent === agent ? narrowReasoningEffort(savedEffort, agent, model) : undefined);
}
export function reasoningEffortsForModel(agent, model) {
    const driver = getAgentDriver(agent);
    const models = modelsFor(agent);
    const canonical = canonicalModel(agent, model) ?? models.find((candidate) => candidate.default)?.id;
    return driver ? models.find((candidate) => candidate.id === canonical)?.reasoningEfforts?.map((item) => ({ ...item })) ?? [] : [];
}
export function narrowReasoningEffort(value, agent = "claude-code", model) {
    const live = runtimeModels(agent);
    return live ? effortForModels(live, value, model) : getAgentDriver(agent)?.reasoningEffort(value, model);
}
