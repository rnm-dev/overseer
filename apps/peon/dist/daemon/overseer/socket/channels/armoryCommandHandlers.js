import { ArmoryOperationError } from "../../../armory/index.js";
const MAX_RESULT_BYTES = 48 * 1024;
function keys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
}
function safeOperation(value) {
    const operation = value;
    return {
        id: String(operation.id ?? ""),
        packageId: String(operation.packageId ?? ""),
        kind: String(operation.kind ?? ""),
        status: String(operation.status ?? ""),
        phase: String(operation.phase ?? ""),
        percent: typeof operation.progress === "number" ? operation.progress : 0,
        message: "",
        errorCode: typeof operation.errorCode === "string" ? operation.errorCode : null,
        startedAt: typeof operation.startedAt === "number" ? operation.startedAt : null,
        finishedAt: typeof operation.finishedAt === "number" ? operation.finishedAt : null,
    };
}
function bounded(result) {
    return Buffer.byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES
        ? result
        : { safeDetail: "Armory result exceeded the bounded command result limit" };
}
function ok(result) {
    return { status: "applied", code: "OK", result: bounded(result) };
}
function failure(error) {
    const code = error instanceof ArmoryOperationError ? error.code : "ARMORY_FAILED";
    return { status: code === "OPERATION_IN_PROGRESS" ? "conflict" : "failed", code };
}
function packageId(command) {
    return command.target.packageId;
}
function targetKeys(command, expected) {
    return keys(command.target, ["peonId", ...expected])
        && expected.every((key) => typeof command.target[key] === "string");
}
function packageTarget(payload, expected, command) {
    return expected === null && keys(payload, []) && targetKeys(command, ["packageId"])
        ? null : "Armory package command requires one package target and an empty payload";
}
function peonTarget(command) {
    return targetKeys(command, []);
}
function safeRegistryUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url.toString() : "";
    }
    catch {
        return "";
    }
}
function handler(validate, execute) {
    return {
        maxConcurrency: 1,
        priority: "control",
        validate,
        execute: async (command) => {
            try {
                return ok(await execute(command));
            }
            catch (error) {
                return failure(error);
            }
        },
    };
}
export function armoryCommandHandlers(services) {
    const packageCommand = (run) => handler(packageTarget, async (command) => ({
        operation: safeOperation(await run(packageId(command))),
    }));
    return {
        "armory.inventory": handler((payload, expected, command) => expected === null && peonTarget(command)
            && keys(payload, ["q", "installedOnly", "limit", "cursor"])
            && (payload.q === undefined || typeof payload.q === "string")
            && (payload.installedOnly === undefined || typeof payload.installedOnly === "boolean")
            && (payload.limit === undefined || Number.isSafeInteger(payload.limit))
            && (payload.cursor === undefined || typeof payload.cursor === "string")
            ? null : "invalid Armory inventory query", async (command) => {
            const query = command.payload;
            const view = await services.inventory.list({
                ...(typeof query.q === "string" ? { q: query.q.slice(0, 200) } : {}),
                ...(typeof query.installedOnly === "boolean" ? { installedOnly: query.installedOnly } : {}),
                limit: typeof query.limit === "number" ? Math.min(100, Math.max(1, query.limit)) : 100,
                ...(typeof query.cursor === "string" ? { cursor: query.cursor.slice(0, 200) } : {}),
            });
            return view;
        }),
        "armory.refresh": handler((payload, expected, command) => expected === null && peonTarget(command) && keys(payload, [])
            ? null : "invalid Armory refresh", async () => (await services.inventory.list({ limit: 100, forceRefresh: true }))),
        "armory.settings": handler((payload, expected, command) => expected === null && peonTarget(command) && keys(payload, [])
            ? null : "invalid Armory settings query", async () => {
            const settings = await services.settings.read();
            const registryUrl = safeRegistryUrl(settings.registryUrl);
            const effectiveRegistryUrl = safeRegistryUrl(process.env.PEON_ARMORY_REGISTRY_URL || settings.registryUrl);
            return {
                registryUrl,
                effectiveRegistryUrl,
                registryOverridden: effectiveRegistryUrl !== registryUrl,
                agentInstallAllowlist: settings.agentInstallAllowlist.slice(0, 1_000),
            };
        }),
        "armory.install": handler((payload, expected, command) => expected === null && targetKeys(command, ["packageId"]) && keys(payload, ["version"])
            && (payload.version === undefined || typeof payload.version === "string") ? null : "invalid install selection", async (command) => ({ operation: safeOperation(await services.installer.install(packageId(command), {
                ...(typeof command.payload.version === "string" ? { version: command.payload.version } : {}),
            })) })),
        "armory.update": handler((payload, expected, command) => expected === null && targetKeys(command, ["packageId"]) && keys(payload, ["version"])
            && (payload.version === undefined || typeof payload.version === "string") ? null : "invalid update selection", async (command) => ({ operation: safeOperation(await services.installer.update(packageId(command), {
                ...(typeof command.payload.version === "string" ? { version: command.payload.version } : {}),
            })) })),
        "armory.enable": packageCommand((id) => services.lifecycle.enable(id)),
        "armory.disable": packageCommand((id) => services.lifecycle.disable(id)),
        "armory.uninstall": packageCommand((id) => services.uninstaller.uninstall(id)),
        "armory.configure": handler((payload, expected, command) => expected === null && targetKeys(command, ["packageId"])
            && keys(payload, ["values", "confirmHostWrites"])
            && payload.values !== null && typeof payload.values === "object" && !Array.isArray(payload.values)
            && Object.values(payload.values).every((value) => typeof value === "string")
            && (payload.confirmHostWrites === undefined || typeof payload.confirmHostWrites === "boolean")
            ? null : "invalid configuration", async (command) => ({ operation: safeOperation(await services.configuration.configure(packageId(command), command.payload.values, { confirmHostWrites: command.payload.confirmHostWrites === true })) })),
        "armory.verify": handler(packageTarget, async (command) => ({
            operation: safeOperation(await services.configuration.verify(packageId(command))),
        })),
        "armory.configuration.delete": handler((payload, expected, command) => expected === null && targetKeys(command, ["packageId"])
            && keys(payload, ["includeHost", "confirmHostWrites"])
            && (payload.includeHost === undefined || typeof payload.includeHost === "boolean")
            && (payload.confirmHostWrites === undefined || typeof payload.confirmHostWrites === "boolean")
            ? null : "invalid configuration deletion", async (command) => ({ operation: safeOperation(await services.configuration.deleteConfiguration(packageId(command), { includeHost: command.payload.includeHost === true, confirmHostWrites: command.payload.confirmHostWrites === true })) })),
        "armory.package": handler(packageTarget, async (command) => (await services.inventory.get(packageId(command)))),
        "armory.configuration": handler(packageTarget, async (command) => ({
            packageId: packageId(command),
            ...(await services.configuration.schema(packageId(command))),
        })),
        "armory.mcp": handler(packageTarget, async (command) => (await services.mcp.describe(packageId(command)))),
        "armory.operation": handler((payload, expected, command) => expected === null && keys(payload, []) && targetKeys(command, ["operationId"])
            ? null : "Armory operation query requires one operation target and an empty payload", async (command) => {
            const operation = await services.operations.get(command.target.operationId);
            if (!operation)
                throw new ArmoryOperationError("PACKAGE_NOT_FOUND", "operation not found");
            return { operation: safeOperation(operation) };
        }),
    };
}
