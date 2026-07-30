import type { ArmoryApiServices, ArmoryInventoryReader } from "../../../armory/index.js";
import { ArmoryOperationError } from "../../../armory/index.js";
import type { PeonSocketFrame } from "../peonSocketProtocol.js";
import type { ReverseCommandExecution, ReverseCommandHandler, ValidCommand } from "./reverseCommandChannel.js";
import type { ReverseCommandHandlersFor } from "./reverseCommandOperations.js";

const MAX_RESULT_BYTES = 48 * 1024;

export interface ArmoryReverseServices extends ArmoryApiServices {
  inventory: ArmoryInventoryReader;
  operations: NonNullable<ArmoryApiServices["operations"]>;
  settings: NonNullable<ArmoryApiServices["settings"]>;
  installer: NonNullable<ArmoryApiServices["installer"]>;
  configuration: NonNullable<ArmoryApiServices["configuration"]>;
  lifecycle: NonNullable<ArmoryApiServices["lifecycle"]>;
  uninstaller: NonNullable<ArmoryApiServices["uninstaller"]>;
  mcp: NonNullable<ArmoryApiServices["mcp"]>;
}

function keys(value: PeonSocketFrame, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function safeOperation(value: unknown): PeonSocketFrame {
  const operation = value as Record<string, unknown>;
  return {
    id: String(operation.id ?? ""),
    packageId: String(operation.packageId ?? ""),
    kind: String(operation.kind ?? ""),
    status: String(operation.status ?? ""),
    phase: String(operation.phase ?? ""),
    percent: typeof operation.percent === "number" ? operation.percent : 0,
    message: "",
    errorCode: typeof operation.errorCode === "string" ? operation.errorCode : null,
    startedAt: typeof operation.startedAt === "number" ? operation.startedAt : null,
    finishedAt: typeof operation.finishedAt === "number" ? operation.finishedAt : null,
  };
}

function bounded(result: PeonSocketFrame): PeonSocketFrame {
  return Buffer.byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES
    ? result
    : { safeDetail: "Armory result exceeded the bounded command result limit" };
}

function ok(result: PeonSocketFrame): ReverseCommandExecution {
  return { status: "applied", code: "OK", result: bounded(result) };
}

function failure(error: unknown): ReverseCommandExecution {
  const code = error instanceof ArmoryOperationError ? error.code : "ARMORY_FAILED";
  return { status: code === "OPERATION_IN_PROGRESS" ? "conflict" : "failed", code };
}

function packageId(command: ValidCommand): string {
  return command.target.packageId!;
}

function targetKeys(command: ValidCommand, expected: string[]): boolean {
  return keys(command.target, ["peonId", ...expected])
    && expected.every((key) => typeof command.target[key as keyof ValidCommand["target"]] === "string");
}

function packageTarget(payload: PeonSocketFrame, expected: PeonSocketFrame | null, command: ValidCommand): string | null {
  return expected === null && keys(payload, []) && targetKeys(command, ["packageId"])
    ? null : "Armory package command requires one package target and an empty payload";
}

function peonTarget(command: ValidCommand): boolean {
  return targetKeys(command, []);
}

function safeRegistryUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url.toString() : "";
  } catch {
    return "";
  }
}

function handler(
  validate: ReverseCommandHandler["validate"],
  execute: (command: ValidCommand) => Promise<PeonSocketFrame>,
): ReverseCommandHandler {
  return {
    maxConcurrency: 1,
    priority: "control",
    validate,
    execute: async (command) => {
      try { return ok(await execute(command)); }
      catch (error) { return failure(error); }
    },
  };
}

export function armoryCommandHandlers(services: ArmoryReverseServices): ReverseCommandHandlersFor<"armory"> {
  const packageCommand = (run: (id: string) => Promise<unknown>) => handler(packageTarget, async (command) => ({
    operation: safeOperation(await run(packageId(command))),
  }));
  return {
    "armory.inventory": handler(
      (payload, expected, command) => expected === null && peonTarget(command)
        && keys(payload, ["q", "installedOnly", "limit", "cursor"])
        && (payload.q === undefined || typeof payload.q === "string")
        && (payload.installedOnly === undefined || typeof payload.installedOnly === "boolean")
        && (payload.limit === undefined || Number.isSafeInteger(payload.limit))
        && (payload.cursor === undefined || typeof payload.cursor === "string")
        ? null : "invalid Armory inventory query",
      async (command) => {
        const query = command.payload;
        const view = await services.inventory.list({
          ...(typeof query.q === "string" ? { q: query.q.slice(0, 200) } : {}),
          ...(typeof query.installedOnly === "boolean" ? { installedOnly: query.installedOnly } : {}),
          limit: typeof query.limit === "number" ? Math.min(100, Math.max(1, query.limit)) : 100,
          ...(typeof query.cursor === "string" ? { cursor: query.cursor.slice(0, 200) } : {}),
        });
        return view as unknown as PeonSocketFrame;
      },
    ),
    "armory.refresh": handler(
      (payload, expected, command) => expected === null && peonTarget(command) && keys(payload, [])
        ? null : "invalid Armory refresh",
      async () =>
      (await services.inventory.list({ limit: 100, forceRefresh: true })) as unknown as PeonSocketFrame),
    "armory.settings": handler(
      (payload, expected, command) => expected === null && peonTarget(command) && keys(payload, [])
        ? null : "invalid Armory settings query",
      async () => {
        const settings = await services.settings.read();
        const registryUrl = safeRegistryUrl(settings.registryUrl);
        const effectiveRegistryUrl = safeRegistryUrl(process.env.PEON_ARMORY_REGISTRY_URL || settings.registryUrl);
        return {
          registryUrl,
          effectiveRegistryUrl,
          registryOverridden: effectiveRegistryUrl !== registryUrl,
          agentInstallAllowlist: settings.agentInstallAllowlist.slice(0, 1_000),
        };
      },
    ),
    "armory.install": handler(
      (payload, expected, command) => expected === null && targetKeys(command, ["packageId"]) && keys(payload, ["version"])
        && (payload.version === undefined || typeof payload.version === "string") ? null : "invalid install selection",
      async (command) => ({ operation: safeOperation(await services.installer.install(packageId(command), {
        ...(typeof command.payload.version === "string" ? { version: command.payload.version } : {}),
      })) }),
    ),
    "armory.update": handler(
      (payload, expected, command) => expected === null && targetKeys(command, ["packageId"]) && keys(payload, ["version"])
        && (payload.version === undefined || typeof payload.version === "string") ? null : "invalid update selection",
      async (command) => ({ operation: safeOperation(await services.installer.update(packageId(command), {
        ...(typeof command.payload.version === "string" ? { version: command.payload.version } : {}),
      })) }),
    ),
    "armory.enable": packageCommand((id) => services.lifecycle.enable(id)),
    "armory.disable": packageCommand((id) => services.lifecycle.disable(id)),
    "armory.uninstall": packageCommand((id) => services.uninstaller.uninstall(id)),
    "armory.configure": handler(
      (payload, expected, command) => expected === null && targetKeys(command, ["packageId"])
        && keys(payload, ["values", "confirmHostWrites"])
        && payload.values !== null && typeof payload.values === "object" && !Array.isArray(payload.values)
        && Object.values(payload.values).every((value) => typeof value === "string")
        && (payload.confirmHostWrites === undefined || typeof payload.confirmHostWrites === "boolean")
        ? null : "invalid configuration",
      async (command) => ({ operation: safeOperation(await services.configuration.configure(
        packageId(command),
        command.payload.values as Record<string, string>,
        { confirmHostWrites: command.payload.confirmHostWrites === true },
      )) }),
    ),
    "armory.verify": handler(packageTarget, async (command) => ({
      operation: safeOperation(await services.configuration.verify(packageId(command))),
    })),
    "armory.configuration.delete": handler(
      (payload, expected, command) => expected === null && targetKeys(command, ["packageId"])
        && keys(payload, ["includeHost", "confirmHostWrites"])
        && (payload.includeHost === undefined || typeof payload.includeHost === "boolean")
        && (payload.confirmHostWrites === undefined || typeof payload.confirmHostWrites === "boolean")
        ? null : "invalid configuration deletion",
      async (command) => ({ operation: safeOperation(await services.configuration.deleteConfiguration(
        packageId(command),
        { includeHost: command.payload.includeHost === true, confirmHostWrites: command.payload.confirmHostWrites === true },
      )) }),
    ),
    "armory.package": handler(packageTarget, async (command) =>
      (await services.inventory.get(packageId(command))) as unknown as PeonSocketFrame),
    "armory.configuration": handler(packageTarget, async (command) => ({
      packageId: packageId(command),
      ...(await services.configuration.schema(packageId(command))),
    }) as unknown as PeonSocketFrame),
    "armory.mcp": handler(packageTarget, async (command) =>
      (await services.mcp.describe(packageId(command))) as PeonSocketFrame),
    "armory.operation": handler(
      (payload, expected, command) => expected === null && keys(payload, []) && targetKeys(command, ["operationId"])
        ? null : "Armory operation query requires one operation target and an empty payload",
      async (command) => {
      const operation = await services.operations.get(command.target.operationId!);
      if (!operation) throw new ArmoryOperationError("PACKAGE_NOT_FOUND", "operation not found");
      return { operation: safeOperation(operation) };
      },
    ),
  };
}
