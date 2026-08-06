import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ArmoryInventoryReader } from "../armory/inventory.js";

const root = mkdtempSync(path.join(os.tmpdir(), "peon-armory-project-packages-api-"));
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_DATA_HOME = path.join(root, "data");

const {
  ArmoryProjectPackagesService,
  createArmoryStores,
  parseArmoryManifest,
} = await import("../armory/index.js");
const { settings } = await import("../settings/index.js");
const { createControlServer } = await import("../controlServer.js");

const token = "pn_armory_project_packages_api";
const projectId = "87b68e30-a923-48b4-9a58-f561a2390083";
settings.update({ overseerToken: token });

const stores = createArmoryStores();
await stores.installed.set({
  id: "drive",
  version: "1.0.0",
  enabled: false,
  state: "ready",
  installedAt: 1,
  updatedAt: 1,
  sourceDigest: "a".repeat(64),
  configurationStatus: "missing",
  lastError: null,
  activeOperationId: null,
  capabilities: { mcp: true },
});
const driveManifest = parseArmoryManifest({
  schemaVersion: 1,
  id: "drive",
  version: "1.0.0",
  minPeonVersion: "0.12.0",
  platforms: [{ os: "linux", arch: "x64" }],
  permissions: { networkHosts: [], hostPaths: [] },
  dependencies: [],
  profile: { type: "google-service-account", requiredFields: ["serviceAccountJson"] },
  configuration: {
    fields: [{ id: "serviceAccountJson", label: "Service account", type: "secret", required: true }],
    handler: { executable: "node", args: ["dist/configure.js"] },
    managedPaths: [],
  },
  mcp: { command: { executable: "node", args: ["dist/mcp.js"] }, toolPrefix: "drive" },
});
const projectPackages = new ArmoryProjectPackagesService({
  stores,
  projects: { list: () => [{ projectId }] },
  manifestResolver: async () => ({ installed: (await stores.installed.get("drive"))!, manifest: driveManifest }),
});

const inventory: ArmoryInventoryReader = {
  async list() {
    return {
      registry: { url: "https://example.test/armory.json", official: false, source: "cached", fetchedAt: 1, catalogUpdatedAt: null, error: null },
      packages: [], total: 0, nextCursor: null,
    };
  },
  async get(id) {
    const installed = await stores.installed.get(id);
    return {
      registry: { url: "https://example.test/armory.json", official: false, source: "cached", fetchedAt: 1, catalogUpdatedAt: null, error: null },
      package: { id, available: false, displayName: null, iconUrl: null, summary: null, publisher: null, documentationUrl: null, latestVersion: null, requirements: null, capabilities: { mcp: true }, installed, updateAvailable: null },
      catalog: null,
    };
  },
};

let legacyActivationCalled = false;
const server = createControlServer({
  armoryInventory: inventory,
  armoryApi: {
    operations: stores.operations,
    projectPackages,
    projectPackagesCapability: true,
    lifecycle: {
      enable: async () => { legacyActivationCalled = true; throw new Error("must not run"); },
      disable: async () => { legacyActivationCalled = true; throw new Error("must not run"); },
    },
  },
}).listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}/api/v1/armory`;
const fleetHeaders = {
  Authorization: `Bearer ${token}`,
  "Peon-Protocol": "1",
  "Peon-Actor": "viktor.ten@me.com",
  "Peon-Request-Id": "f09663fc-fc80-4314-a7e6-70b14dd29473",
  "Content-Type": "application/json",
};

test.after(() => server.close());

test("Fleet profile and assignment APIs preserve correlation and never echo write-only values", async () => {
  const unauthenticated = await fetch(`${base}/profiles`, { headers: { Authorization: "Bearer wrong" } });
  assert.equal(unauthenticated.status, 401);

  const createdResponse = await fetch(`${base}/profiles`, {
    method: "POST",
    headers: fleetHeaders,
    body: JSON.stringify({ type: "google-service-account", name: "Production Google" }),
  });
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get("Peon-Request-Id"), fleetHeaders["Peon-Request-Id"]);
  const created = await createdResponse.json() as { profileId: string };
  const renamedResponse = await fetch(`${base}/profiles/${created.profileId}`, {
    method: "PATCH",
    headers: fleetHeaders,
    body: JSON.stringify({ name: "Shared Google" }),
  });
  assert.equal(renamedResponse.status, 200);
  assert.equal(((await renamedResponse.json()) as { name: string }).name, "Shared Google");

  const configuredResponse = await fetch(`${base}/profiles/${created.profileId}/configuration`, {
    method: "PUT",
    headers: fleetHeaders,
    body: JSON.stringify({ values: { serviceAccountJson: "write-only-api-sentinel" } }),
  });
  assert.equal(configuredResponse.status, 202);
  const configuredText = await configuredResponse.text();
  const configured = JSON.parse(configuredText) as { operationId: string; kind: string };
  assert.equal(configured.kind, "profile_configure");
  assert.equal(configuredText.includes("write-only-api-sentinel"), false);
  assert.equal((await projectPackages.operations.wait(configured.operationId)).status, "success");

  const verifiedResponse = await fetch(`${base}/profiles/${created.profileId}/verify`, { method: "POST", headers: fleetHeaders });
  assert.equal(verifiedResponse.status, 202);
  const verified = await verifiedResponse.json() as { operationId: string };
  assert.equal((await projectPackages.operations.wait(verified.operationId)).status, "success");

  const assignmentResponse = await fetch(`${base}/projects/${projectId}/assignments/drive`, {
    method: "PUT",
    headers: fleetHeaders,
    body: JSON.stringify({ profileId: created.profileId }),
  });
  assert.equal(assignmentResponse.status, 200);
  assert.deepEqual(await assignmentResponse.json(), { projectId, packageId: "drive", profileId: created.profileId });
  const assignmentsResponse = await fetch(`${base}/projects/${projectId}/assignments`, { headers: fleetHeaders });
  assert.deepEqual(await assignmentsResponse.json(), { assignments: [{ projectId, packageId: "drive", profileId: created.profileId }] });

  const profilesResponse = await fetch(`${base}/profiles`, { headers: fleetHeaders });
  assert.equal(profilesResponse.status, 200);
  const profilesText = await profilesResponse.text();
  assert.equal(profilesText.includes("write-only-api-sentinel"), false);
  assert.equal(profilesText.includes('"serviceAccountJson":true'), true);

  const refusedDelete = await fetch(`${base}/profiles/${created.profileId}`, { method: "DELETE", headers: fleetHeaders });
  assert.equal(refusedDelete.status, 409);
  assert.equal(((await refusedDelete.json()) as { code: string }).code, "PROFILE_IN_USE");
  const removedAssignment = await fetch(`${base}/projects/${projectId}/assignments/drive`, { method: "DELETE", headers: fleetHeaders });
  assert.equal(removedAssignment.status, 200);
  const deletedProfile = await fetch(`${base}/profiles/${created.profileId}`, { method: "DELETE", headers: fleetHeaders });
  assert.equal(deletedProfile.status, 200);
});

test("capable Fleet API retires legacy activation without side effects", async () => {
  for (const action of ["enable", "disable"]) {
    const response = await fetch(`${base}/packages/drive/${action}`, { method: "POST", headers: fleetHeaders });
    assert.equal(response.status, 410);
    assert.equal(((await response.json()) as { code: string }).code, "ARMORY_ACTIVATION_RETIRED");
  }
  assert.equal(legacyActivationCalled, false);
});

test("capable package reads expose the profile requirement and no activation or package credentials state", async () => {
  const response = await fetch(`${base}/packages/drive`, { headers: fleetHeaders });
  assert.equal(response.status, 200);
  const body = await response.json() as { package: { installed: Record<string, unknown> } };
  assert.deepEqual(body.package.installed, {
    packageId: "drive",
    version: "1.0.0",
    state: "ready",
    profileRequirement: { type: "google-service-account", requiredFields: ["serviceAccountJson"] },
  });
  assert.equal("enabled" in body.package.installed, false);
  assert.equal("configurationStatus" in body.package.installed, false);
});
