import { getAgentDriver, agentServices } from "../../../agents/index.js";
import { analyticsForSessions, parseSessionAnalyticsQuery, SessionAnalyticsQueryError } from "../../../sessionAnalytics.js";
import { sessions } from "../../../sessions/index.js";
const PERIODS = new Set(["day", "yesterday", "week", "month"]);
const PROVIDERS = new Set(["claude-code", "codex"]);
const FORBIDDEN_RUNTIME_KEY = /(?:credential|secret|token|password|authorization|authresponse|environment|executablepath|filetransferroot)/i;
function hasForbiddenRuntimeKey(value, seen = new Set()) {
    if (!value || typeof value !== "object")
        return false;
    if (seen.has(value))
        return true;
    seen.add(value);
    if (Array.isArray(value))
        return value.some((item) => hasForbiddenRuntimeKey(item, seen));
    return Object.entries(value).some(([key, nested]) => FORBIDDEN_RUNTIME_KEY.test(key) || hasForbiddenRuntimeKey(nested, seen));
}
export function safeRuntimeQueryResult(value) {
    const body = value;
    if (hasForbiddenRuntimeKey(body)) {
        return { status: "failed", code: "INTERNAL" };
    }
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 56 * 1024) {
        return { status: "rejected", code: "PAYLOAD_TOO_LARGE" };
    }
    return { status: "applied", code: "OK", result: body };
}
function payload(command) {
    return command.payload;
}
function handler(execute) {
    return {
        priority: "normal",
        maxConcurrency: 2,
        validate: (_payload, expected) => expected === null ? null : "runtime queries do not accept expected state",
        execute,
    };
}
export function runtimeQueryHandlers() {
    return {
        "runtime.stats": handler((command) => {
            const period = payload(command).period;
            if (typeof period !== "string" || !PERIODS.has(period))
                return { status: "rejected", code: "BAD_COMMAND" };
            return safeRuntimeQueryResult(sessions.statsForPeriod(period));
        }),
        "runtime.analytics": handler((command) => {
            const query = payload(command).query;
            if (!query || typeof query !== "object" || Array.isArray(query))
                return { status: "rejected", code: "BAD_COMMAND" };
            try {
                return safeRuntimeQueryResult(analyticsForSessions(sessions.list(), parseSessionAnalyticsQuery(query)));
            }
            catch (error) {
                if (error instanceof SessionAnalyticsQueryError)
                    return { status: "rejected", code: "BAD_COMMAND" };
                throw error;
            }
        }),
        "runtime.quota": handler(async (command) => {
            const { provider, refresh } = payload(command);
            if (typeof provider !== "string" || !PROVIDERS.has(provider) || typeof refresh !== "boolean"
                || !getAgentDriver(provider)?.capabilities.quota)
                return { status: "rejected", code: "UNKNOWN_PROVIDER" };
            return safeRuntimeQueryResult(await agentServices.quota(provider, refresh));
        }),
        "runtime.capabilities": handler(async (command) => {
            const { provider, refresh } = payload(command);
            if (typeof provider !== "string" || !PROVIDERS.has(provider) || typeof refresh !== "boolean"
                || !getAgentDriver(provider))
                return { status: "rejected", code: "UNKNOWN_PROVIDER" };
            return safeRuntimeQueryResult(await agentServices.capabilities(provider, refresh));
        }),
    };
}
