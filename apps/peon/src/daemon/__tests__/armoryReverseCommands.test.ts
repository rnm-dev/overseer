import assert from "node:assert/strict";
import test from "node:test";
import { armoryCommandHandlers, type ArmoryReverseServices } from "../overseer/socket/channels/armoryCommandHandlers.js";
import type { ValidCommand } from "../overseer/socket/channels/reverseCommandChannel.js";

function command(operation: string, payload: Record<string, unknown> = {}): ValidCommand {
  return {
    commandId: "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    operation,
    target: { peonId: "f4de920f-e33e-4cf5-97d0-3a75e9266090", packageId: "fixture-echo" },
    actor: { userId: "b169219d-45f6-4f42-b78f-3fb931dac7ee", email: "operator@example.com" },
    payload,
    expected: null,
    requestedAt: 1,
  };
}

test("Armory configure result never reflects submitted secret values or hook messages", async () => {
  const operation = {
    id: "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5",
    packageId: "fixture-echo",
    kind: "configure",
    status: "success",
    phase: "done",
    progress: 65,
    message: "hook printed ultra-secret",
    errorCode: null,
    startedAt: 1,
    finishedAt: 2,
  };
  const services = {
    configuration: { configure: async () => operation },
  } as unknown as ArmoryReverseServices;
  const result = await servicesResult(armoryCommandHandlers(services)["armory.configure"]!, command(
    "armory.configure",
    { values: { token: "ultra-secret" } },
  ));
  const wire = JSON.stringify(result);
  assert.equal(wire.includes("ultra-secret"), false);
  assert.equal((result.result as { operation: { message: string } }).operation.message, "");
  assert.equal((result.result as { operation: { percent: number } }).operation.percent, 65);
});

test("Armory inventory is capped and oversized safe results are replaced", async () => {
  let observedLimit = 0;
  const services = {
    inventory: {
      list: async ({ limit }: { limit?: number }) => {
        observedLimit = limit ?? 0;
        return { registry: {}, packages: [{ summary: "x".repeat(60_000) }], total: 1, nextCursor: null };
      },
    },
  } as unknown as ArmoryReverseServices;
  const result = await servicesResult(armoryCommandHandlers(services)["armory.inventory"]!, command(
    "armory.inventory",
    { limit: 10_000 },
  ));
  assert.equal(observedLimit, 100);
  assert.deepEqual(result.result, { safeDetail: "Armory result exceeded the bounded command result limit" });
});

test("Armory handlers reject mixed targets and malformed secret values before execution", () => {
  const services = {} as ArmoryReverseServices;
  const handlers = armoryCommandHandlers(services);
  const mixed = command("armory.configure", { values: { token: "secret" } });
  mixed.target.operationId = "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5";
  assert.match(handlers["armory.configure"]!.validate(mixed.payload, null, mixed)!, /invalid configuration/);

  const malformed = command("armory.configure", { values: { token: 42 } });
  assert.match(handlers["armory.configure"]!.validate(malformed.payload, null, malformed)!, /invalid configuration/);
});

test("Armory verify returns the same bounded safe operation shape", async () => {
  const services = {
    configuration: {
      verify: async () => ({
        id: "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5",
        packageId: "fixture-echo",
        kind: "verify",
        status: "success",
        phase: "done",
        progress: 100,
        message: "provider returned secret diagnostics",
        errorCode: null,
        startedAt: 1,
        finishedAt: 2,
      }),
    },
  } as unknown as ArmoryReverseServices;
  const result = await servicesResult(
    armoryCommandHandlers(services)["armory.verify"]!,
    command("armory.verify"),
  );
  assert.equal((result.result as { operation: { message: string } }).operation.message, "");
});

test("Armory settings fail closed for credential-bearing registry URLs", async () => {
  const services = {
    settings: {
      read: async () => ({
        registryUrl: "https://operator:secret@example.com/armory.json",
        agentInstallAllowlist: ["fixture-echo"],
      }),
    },
  } as unknown as ArmoryReverseServices;
  const settingsCommand = command("armory.settings");
  settingsCommand.target = { peonId: settingsCommand.target.peonId };
  const result = await servicesResult(armoryCommandHandlers(services)["armory.settings"]!, settingsCommand);
  assert.equal(result.result.registryUrl, "");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

async function servicesResult(handler: ReturnType<typeof armoryCommandHandlers>[string], value: ValidCommand) {
  const result = await handler.execute(value);
  assert.equal(result.status, "applied");
  return result as typeof result & { result: Record<string, unknown> };
}
