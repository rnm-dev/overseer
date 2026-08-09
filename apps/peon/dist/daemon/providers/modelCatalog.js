import { getAgentDriver, listAgentDrivers, REASONING_EFFORTS, } from "../agents/index.js";
export { REASONING_EFFORTS };
export const DEFAULT_MODEL = "claude-sonnet-5";
function allDrivers() {
    return listAgentDrivers();
}
function publicCapabilities(driver) {
    return { ...driver.capabilities };
}
export function codingAgents() {
    return allDrivers().map((driver) => driver.id);
}
export function aiProviders() {
    return allDrivers().map((driver) => ({
        agent: driver.id, label: driver.label, models: driver.models,
        reasoningEfforts: driver.reasoningEfforts, available: driver.available(),
        visible: driver.visible, legacy: driver.legacy, capabilities: publicCapabilities(driver),
        status: driver.services.status?.() ?? null,
        defaultModel: providerDefaultModel(driver.id),
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
    const model = driver?.models.find((candidate) => candidate.default) ?? driver?.models[0];
    if (!model)
        throw new Error(`no model catalog for agent ${agent}`);
    return model.id;
}
export function canonicalModel(agent, value) {
    return getAgentDriver(agent)?.canonicalModel(value);
}
export function isModelForAgent(agent, value) {
    return canonicalModel(agent, value) !== undefined;
}
export function modelCatalog(defaultAgent, defaultModel, defaultReasoningEffort = null) {
    return listAgentDrivers({ visible: true, available: true }).map((driver) => {
        const selected = driver.id === defaultAgent
            ? (defaultModel && driver.canonicalModel(defaultModel)) || providerDefaultModel(defaultAgent)
            : null;
        const known = selected ? driver.models.some((model) => model.id === selected) : true;
        const configuredEffort = driver.id === defaultAgent
            ? driver.reasoningEffort(defaultReasoningEffort, selected)
            : undefined;
        const models = driver.models.map(({ default: _default, ...model }) => {
            const reasoningEfforts = model.reasoningEfforts?.map(({ default: _effortDefault, ...item }) => configuredEffort && model.id === selected && item.id === configuredEffort
                ? { ...item, default: true }
                : configuredEffort && model.id === selected
                    ? item
                    : { ...item, ...(_effortDefault ? { default: true } : {}) });
            return model.id === selected
                ? { ...model, ...(reasoningEfforts ? { reasoningEfforts } : {}), default: true }
                : { ...model, ...(reasoningEfforts ? { reasoningEfforts } : {}) };
        });
        if (selected && !known)
            models.push({ id: selected, label: selected, default: true });
        return {
            agent: driver.id, label: driver.label, models,
            reasoningEfforts: driver.reasoningEfforts?.map((item) => ({ ...item })),
            available: driver.available(), visible: driver.visible, legacy: driver.legacy,
            capabilities: publicCapabilities(driver),
            status: driver.services.status?.() ?? null,
            defaultModel: providerDefaultModel(driver.id),
        };
    });
}
export function listConfiguredAgents(options = {}) {
    return listAgentDrivers(options).map((driver) => driver.id);
}
export function isValidModel(value) {
    return getAgentDriver("claude-code")?.canonicalModel(value) !== undefined;
}
export function narrowModel(value, agent = "claude-code") {
    return canonicalModel(agent, value);
}
export function resolveModel(agent, turnModel, sessionModel, savedAgent, savedModel) {
    const driver = getAgentDriver(agent);
    if (!driver)
        throw new Error(`Agent driver "${agent}" is not registered`);
    return driver.canonicalModel(turnModel) ?? driver.canonicalModel(sessionModel)
        ?? (savedAgent === agent ? driver.canonicalModel(savedModel) : undefined) ?? providerDefaultModel(agent);
}
export function reasoningEffortsForModel(agent, model) {
    const driver = getAgentDriver(agent);
    const canonical = driver?.canonicalModel(model) ?? driver?.models.find((candidate) => candidate.default)?.id;
    return driver?.models.find((candidate) => candidate.id === canonical)?.reasoningEfforts?.map((item) => ({ ...item })) ?? [];
}
export function narrowReasoningEffort(value, agent = "claude-code", model) {
    return getAgentDriver(agent)?.reasoningEffort(value, model);
}
