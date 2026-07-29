import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ArmoryOperation, ArmorySettings } from "../armory/contracts.js";
import type { ArmoryInventoryListView, ArmoryInventoryQuery, ArmoryInventoryReader } from "../armory/inventory.js";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-armory-api-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-armory-api-state-"));
process.env.XDG_DATA_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-armory-api-data-"));

const { settings } = await import("../settings/index.js");
const { createControlServer } = await import("../controlServer.js");

const token = "pn_armory_api_test";
settings.update({ overseerToken: token });

const response: ArmoryInventoryListView = {
  registry: {
    url: "https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json",
    official: true,
    source: "cached",
    fetchedAt: 123,
    catalogUpdatedAt: "2026-07-15T00:00:00.000Z",
    error: { code: "REGISTRY_UNAVAILABLE", message: "registry offline" },
  },
  packages: [],
  total: 0,
  nextCursor: null,
};

let lastQuery: ArmoryInventoryQuery | undefined;
const inventory: ArmoryInventoryReader = {
  async list(query) {
    lastQuery = query;
    return response;
  },
  async get(id) {
    return {
      registry: response.registry,
      catalog: null,
      package: {
        id,
        available: false,
        displayName: null,
        iconUrl: null,
        summary: null,
        publisher: null,
        documentationUrl: null,
        latestVersion: null,
        requirements: null,
        installed: null,
        updateAvailable: null,
      },
    };
  },
};

let armorySettings: ArmorySettings = {
  schemaVersion: 1,
  registryUrl: "https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json",
  agentInstallAllowlist: [],
};
let submittedValues: Record<string, string> | null = null;
let deleteCalled = false;
let lifecycleRequest: { kind: "enable" | "disable"; id: string } | null = null;
let installRequest: { id: string; version?: string } | null = null;
let updateRequest: { id: string; version?: string } | null = null;
let uninstallRequest: string | null = null;
const operation: ArmoryOperation = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  packageId: "aws",
  kind: "configure",
  status: "queued",
  phase: "queued",
  progress: 0,
  message: "Operation queued",
  errorCode: null,
  startedAt: null,
  finishedAt: null,
};
const armoryApi = {
  settings: {
    read: async () => structuredClone(armorySettings),
    update: async (mutate: (current: ArmorySettings) => ArmorySettings | Promise<ArmorySettings>) => {
      armorySettings = await mutate(structuredClone(armorySettings));
      return structuredClone(armorySettings);
    },
  },
  configuration: {
    schema: async () => ({
      fields: [
        { id: "region", label: "Region", type: "select", required: true, options: [{ value: "us", label: "US" }] },
        { id: "token", label: "Token", type: "secret", required: true },
      ],
      configured: { token: true },
      hostWrites: [],
    }),
    configure: async (_id: string, values: Record<string, string>) => {
      submittedValues = structuredClone(values);
      return operation;
    },
    deleteConfiguration: async () => {
      deleteCalled = true;
      return { ...operation, kind: "delete_configuration" as const };
    },
  },
  operations: { get: async (id: string) => id === operation.id ? operation : null },
  installer: {
    install: async (id: string, options?: { version?: string }) => {
      installRequest = { id, version: options?.version };
      return { ...operation, packageId: id, kind: "install" as const };
    },
    update: async (id: string, options?: { version?: string }) => {
      updateRequest = { id, version: options?.version };
      return { ...operation, packageId: id, kind: "update" as const };
    },
  },
  uninstaller: {
    uninstall: async (id: string) => {
      uninstallRequest = id;
      return { ...operation, packageId: id, kind: "uninstall" as const };
    },
  },
  lifecycle: {
    enable: async (id: string) => {
      lifecycleRequest = { kind: "enable", id };
      return { ...operation, packageId: id, kind: "enable" as const };
    },
    disable: async (id: string) => {
      lifecycleRequest = { kind: "disable", id };
      return { ...operation, packageId: id, kind: "disable" as const };
    },
  },
  mcp: {
    describe: async (id: string) => ({ capable: true, enabled: true, running: true, endpoint: `/mcp/armory/${id}`, tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }] }),
  },
};

const server = createControlServer({ armoryInventory: inventory, armoryApi }).listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;

test.after(() => server.close());

test("operator API exposes the Armory catalog behind the human auth profile", async () => {
  const result = await fetch(`${base}/api/v1/armory/catalog?q=aws&installed=true&limit=10`);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), response);
  assert.deepEqual(lastQuery, { q: "aws", installedOnly: true, limit: 10, cursor: undefined });
});

test("Armory refresh reloads marketplace inventory through operator and fleet APIs", async () => {
  lastQuery = undefined;
  const operator = await fetch(`${base}/api/v1/armory/refresh`, { method: "POST" });
  assert.equal(operator.status, 200);
  assert.deepEqual(await operator.json(), response);
  assert.deepEqual(lastQuery, { limit: 100, forceRefresh: true });

  lastQuery = undefined;
  const fleet = await fetch(`${base}/api/v1/armory/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });
  assert.equal(fleet.status, 200);
  assert.deepEqual(await fleet.json(), response);
  assert.deepEqual(lastQuery, { limit: 100, forceRefresh: true });
});

test("overseer API exposes Armory packages through bearer authentication", async () => {
  const unauthenticated = await fetch(`${base}/api/v1/armory/packages`, {
    headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(((await unauthenticated.json()) as { code: string }).code, "UNAUTHENTICATED");

  const result = await fetch(`${base}/api/v1/armory/packages`, {
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), response);
});

test("operator and overseer package detail routes share the same representation", async () => {
  const human = await fetch(`${base}/api/v1/armory/packages/aws`);
  const fleet = await fetch(`${base}/api/v1/armory/packages/aws`, {
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });
  assert.equal(human.status, 200);
  assert.equal(fleet.status, 200);
  assert.deepEqual(await human.json(), await fleet.json());
});

test("Armory query validation returns stable errors", async () => {
  const result = await fetch(`${base}/api/v1/armory/catalog?installed=maybe`);
  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), {
    error: "installed must be true, false, 1, or 0",
    code: "BAD_REQUEST",
  });
});

test("settings are readable and mutable through both operator and fleet profiles", async () => {
  const fleetHeaders = { Authorization: `Bearer ${token}`, "Peon-Protocol": "1", "Content-Type": "application/json" };
  const fleetRead = await fetch(`${base}/api/v1/armory/settings`, { headers: fleetHeaders });
  assert.equal(fleetRead.status, 200);
  assert.equal(((await fleetRead.json()) as { registryUrl: string }).registryUrl, armorySettings.registryUrl);

  const fleetPatch = await fetch(`${base}/api/v1/armory/settings`, {
    method: "PATCH",
    headers: fleetHeaders,
    body: JSON.stringify({ agentInstallAllowlist: ["aws"] }),
  });
  assert.equal(fleetPatch.status, 200);
  assert.deepEqual(((await fleetPatch.json()) as { agentInstallAllowlist: string[] }).agentInstallAllowlist, ["aws"]);
  assert.deepEqual(armorySettings.agentInstallAllowlist, ["aws"]);

  const humanPatch = await fetch(`${base}/api/v1/armory/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentInstallAllowlist: [] }),
  });
  assert.equal(humanPatch.status, 200);
  assert.deepEqual(((await humanPatch.json()) as { agentInstallAllowlist: string[] }).agentInstallAllowlist, []);
});

test("packages expose a standard configuration schema without configured values", async () => {
  const human = await fetch(`${base}/api/v1/armory/packages/aws/configuration`);
  const fleet = await fetch(`${base}/api/v1/armory/packages/aws/configuration`, {
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });
  assert.equal(human.status, 200);
  assert.equal(fleet.status, 200);
  const body = await human.json() as { configured: Record<string, boolean>; fields: unknown[] };
  assert.deepEqual(body.configured, { token: true });
  assert.equal(body.fields.length, 2);
  assert.equal(JSON.stringify(body).includes("secret-value"), false);
  assert.deepEqual(body, await fleet.json());
});

test("configuration values are accepted through operator and overseer profiles and never echoed", async () => {
  const values = { region: "us", token: "secret-value" };
  const fleet = await fetch(`${base}/api/v1/armory/packages/aws/configuration`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  assert.equal(fleet.status, 202);
  assert.equal((await fleet.text()).includes("secret-value"), false);
  assert.deepEqual(submittedValues, values);

  const fleetDeletion = await fetch(`${base}/api/v1/armory/packages/aws/configuration`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1", "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(fleetDeletion.status, 202);
  assert.equal(deleteCalled, true);

  const human = await fetch(`${base}/api/v1/armory/packages/aws/configuration`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  assert.equal(human.status, 202);
  const text = await human.text();
  assert.equal(text.includes("secret-value"), false);
  assert.deepEqual(submittedValues, values);

  const poll = await fetch(`${base}/api/v1/armory/operations/${operation.id}`);
  assert.equal(poll.status, 200);
  assert.equal(((await poll.json()) as { operation: ArmoryOperation }).operation.id, operation.id);

  const deletion = await fetch(`${base}/api/v1/armory/packages/aws/configuration`, { method: "DELETE" });
  assert.equal(deletion.status, 202);
  assert.equal(deleteCalled, true);
});

test("package installation resolves through both operator and fleet profiles", async () => {
  const fleet = await fetch(`${base}/api/v1/armory/packages/heroboard/install`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ version: "1.0.0" }),
  });
  assert.equal(fleet.status, 202);
  assert.deepEqual(installRequest, { id: "heroboard", version: "1.0.0" });
  assert.equal(((await fleet.json()) as { operation: ArmoryOperation }).operation.kind, "install");

  const human = await fetch(`${base}/api/v1/armory/packages/heroboard/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: "1.0.0" }),
  });
  assert.equal(human.status, 202);
  assert.deepEqual(installRequest, { id: "heroboard", version: "1.0.0" });
  const body = await human.json() as { operation: ArmoryOperation };
  assert.equal(body.operation.kind, "install");
  assert.equal(body.operation.packageId, "heroboard");
});

test("package updates resolve through both operator and fleet profiles", async () => {
  const fleet = await fetch(`${base}/api/v1/armory/packages/image-generator/update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ version: "0.2.0" }),
  });
  assert.equal(fleet.status, 202);
  assert.deepEqual(updateRequest, { id: "image-generator", version: "0.2.0" });
  assert.equal(((await fleet.json()) as { operation: ArmoryOperation }).operation.kind, "update");

  const human = await fetch(`${base}/api/v1/armory/packages/image-generator/update`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(human.status, 202);
  assert.deepEqual(updateRequest, { id: "image-generator", version: undefined });
});

test("ordinary uninstall resolves through both profiles and purge is explicitly rejected", async () => {
  const fleet = await fetch(`${base}/api/v1/armory/packages/demo`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1", "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(fleet.status, 202);
  assert.equal(uninstallRequest, "demo");
  assert.equal(((await fleet.json()) as { operation: ArmoryOperation }).operation.kind, "uninstall");

  const operator = await fetch(`${base}/api/v1/armory/packages/demo`, { method: "DELETE" });
  assert.equal(operator.status, 202);
  assert.equal(uninstallRequest, "demo");

  const purge = await fetch(`${base}/api/v1/armory/packages/demo`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purge: true }),
  });
  assert.equal(purge.status, 400);
  assert.equal(((await purge.json()) as { code: string }).code, "PURGE_NOT_SUPPORTED");
});

test("package MCP lifecycle operations are available through operator and fleet profiles", async () => {
  const fleet = await fetch(`${base}/api/v1/armory/packages/aws/enable`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });
  assert.equal(fleet.status, 202);
  assert.deepEqual(lifecycleRequest, { kind: "enable", id: "aws" });
  assert.equal(((await fleet.json()) as { operation: ArmoryOperation }).operation.kind, "enable");

  const enabled = await fetch(`${base}/api/v1/armory/packages/aws/enable`, { method: "POST" });
  assert.equal(enabled.status, 202);
  assert.deepEqual(lifecycleRequest, { kind: "enable", id: "aws" });

  const disabled = await fetch(`${base}/api/v1/armory/packages/aws/disable`, { method: "POST" });
  assert.equal(disabled.status, 202);
  assert.deepEqual(lifecycleRequest, { kind: "disable", id: "aws" });
});

test("package MCP detail returns the exact runtime tool descriptions", async () => {
  const operator = await fetch(`${base}/api/v1/armory/packages/aws/mcp`);
  const fleet = await fetch(`${base}/api/v1/armory/packages/aws/mcp`, {
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });
  assert.equal(operator.status, 200);
  assert.equal(fleet.status, 200);
  const body = await operator.json() as { endpoint: string; tools: Array<{ name: string; description: string }> };
  assert.equal(body.endpoint, "/mcp/armory/aws");
  assert.deepEqual(body.tools, [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }]);
  assert.deepEqual(body, await fleet.json());
});
