import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ArmoryProjectPackagesError,
  ArmoryProjectPackagesService,
  createArmoryStores,
  packageActivationPath,
  parseArmoryManifest,
  removeProjectPackageAssignmentsForUninstall,
  recoverInterruptedArmoryOperations,
  type ArmoryManifest,
  type ArmoryStores,
  type InstalledArmoryPackage,
} from "../armory/index.js";

const PROJECT_A = "87b68e30-a923-48b4-9a58-f561a2390083";
const PROJECT_B = "ebc767a8-3055-40e8-a511-a7a7387444d4";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-armory-project-packages-"));
  const stores = createArmoryStores({ config: path.join(root, "config"), data: path.join(root, "data"), state: path.join(root, "state") });
  const manifests = new Map<string, ArmoryManifest>();
  const service = new ArmoryProjectPackagesService({
    stores,
    projects: { list: () => [{ projectId: PROJECT_A }, { projectId: PROJECT_B }] },
    now: () => 500,
    manifestResolver: async (packageId) => {
      const installed = await stores.installed.get(packageId);
      const manifest = manifests.get(packageId);
      if (!installed || !manifest) throw new ArmoryProjectPackagesError(404, "PACKAGE_NOT_INSTALLED", `missing package ${packageId}`);
      return { installed, manifest };
    },
  });
  return { stores, manifests, service };
}

function installed(id: string, options: { enabled?: boolean; configurationStatus?: InstalledArmoryPackage["configurationStatus"] } = {}): InstalledArmoryPackage {
  return {
    id,
    version: "1.0.0",
    enabled: options.enabled ?? false,
    state: "ready",
    installedAt: 10,
    updatedAt: 20,
    sourceDigest: "a".repeat(64),
    configurationStatus: options.configurationStatus ?? "not_required",
    lastError: null,
    activeOperationId: null,
    capabilities: { mcp: true },
  };
}

function manifest(id: string, profile?: { type: string; requiredFields: string[] }): ArmoryManifest {
  return parseArmoryManifest({
    schemaVersion: 1,
    id,
    version: "1.0.0",
    minPeonVersion: "0.12.0",
    platforms: [{ os: "linux", arch: "x64" }],
    permissions: { networkHosts: [], hostPaths: [] },
    dependencies: [],
    ...(profile ? {
      profile,
      configuration: {
        fields: [
          { id: "serviceAccountJson", label: "Service account", type: "secret", required: true, validation: { maxLength: 4096 } },
          { id: "region", label: "Region", type: "select", required: false, options: [{ value: "us", label: "US" }] },
        ],
        handler: { executable: "node", args: ["dist/configure.js"] },
        managedPaths: [],
      },
    } : {}),
    mcp: { command: { executable: "node", args: ["dist/mcp.js"] }, toolPrefix: id.replaceAll("-", "_") },
  });
}

test("manifest profile declarations use the settled exact type and required-field shape", () => {
  const parsed = manifest("google-drive", { type: "google-service-account", requiredFields: ["serviceAccountJson"] });
  assert.deepEqual(parsed.profile, { type: "google-service-account", requiredFields: ["serviceAccountJson"] });
  assert.throws(() => parseArmoryManifest({ ...parsed, profile: { type: "Google", requiredFields: ["serviceAccountJson"] } }));
  assert.throws(() => parseArmoryManifest({ ...parsed, profile: { type: "google-service-account", requiredFields: ["missing"] } }));
  assert.throws(() => parseArmoryManifest({ ...parsed, profile: { type: "google-service-account", requiredFields: ["serviceAccountJson", "serviceAccountJson"] } }));
});

test("migration preserves compatible profiles and legacy availability for every existing project", async () => {
  const { stores, manifests, service } = fixture();
  for (const id of ["drive", "calendar", "filesystem"]) {
    await stores.installed.set(installed(id, {
      enabled: id !== "calendar",
      configurationStatus: id === "filesystem" ? "not_required" : "verified",
    }));
  }
  await mkdir(stores.paths.activeDir, { recursive: true });
  const driveInstalled = (await stores.installed.get("drive"))!;
  await writeFile(packageActivationPath(stores.paths, "drive"), `${JSON.stringify({
    schemaVersion: 1,
    id: "drive",
    version: "1.0.0",
    previousVersion: null,
    activatedAt: 20,
    sourceDigest: driveInstalled.sourceDigest,
    operationId: "123e4567-e89b-42d3-a456-426614174000",
    installed: driveInstalled,
  })}\n`, { mode: 0o600 });
  manifests.set("drive", manifest("drive", { type: "google-service-account", requiredFields: ["serviceAccountJson"] }));
  manifests.set("calendar", manifest("calendar", { type: "google-service-account", requiredFields: ["serviceAccountJson"] }));
  manifests.set("filesystem", manifest("filesystem"));
  await stores.credentials.set("drive", { serviceAccountJson: "same-secret" }, 100);
  await stores.credentials.set("calendar", { serviceAccountJson: "same-secret" }, 100);

  await service.initializeMigration();
  const migrated = await stores.projectPackages.read();
  const profiles = Object.values(migrated.profiles);
  assert.equal(profiles.length, 2);
  assert.notEqual(migrated.legacyProfileByPackage.drive, migrated.legacyProfileByPackage.calendar);
  assert.deepEqual(profiles.map((profile) => profile.values.serviceAccountJson), ["same-secret", "same-secret"]);
  assert.deepEqual(migrated.assignments, [
    { projectId: PROJECT_A, packageId: "drive", profileId: migrated.legacyProfileByPackage.drive },
    { projectId: PROJECT_B, packageId: "drive", profileId: migrated.legacyProfileByPackage.drive },
    { projectId: PROJECT_A, packageId: "filesystem", profileId: null },
    { projectId: PROJECT_B, packageId: "filesystem", profileId: null },
  ]);
  assert.deepEqual((await stores.credentials.snapshot()).packages, {});
  assert.equal(Object.hasOwn(await stores.installed.get("drive") as object, "enabled"), false);
  assert.equal(Object.hasOwn(await stores.installed.get("drive") as object, "configurationStatus"), false);
  const activation = JSON.parse(await readFile(packageActivationPath(stores.paths, "drive"), "utf8")) as { installed: Record<string, unknown> };
  assert.equal("enabled" in activation.installed, false);
  assert.equal("configurationStatus" in activation.installed, false);

  const profileIds = Object.keys(migrated.profiles).sort();
  await service.initializeMigration();
  assert.deepEqual(Object.keys((await stores.projectPackages.read()).profiles).sort(), profileIds);
  assert.equal(JSON.stringify(await service.listProfiles()).includes("same-secret"), false);
  assert.equal((await stat(stores.paths.projectPackagesFile)).mode & 0o777, 0o600);

  const legacySchema = await service.legacyConfigurationSchema("drive");
  assert.deepEqual(legacySchema.configured, { serviceAccountJson: true });
  const compatibilityConfigure = await service.configureLegacyPackageProfile("drive", { serviceAccountJson: "replacement-secret" });
  assert.equal((await service.operations.wait(compatibilityConfigure.id)).status, "success");
  assert.deepEqual((await stores.projectPackages.read()).profiles[migrated.legacyProfileByPackage.drive]?.values, { serviceAccountJson: "replacement-secret" });
  assert.deepEqual((await stores.credentials.snapshot()).packages, {});
  assert.equal(JSON.stringify(await service.legacyConfigurationSchema("drive")).includes("replacement-secret"), false);
});

test("migration retains and refuses legacy configuration when a package has no profile contract", async () => {
  const { stores, manifests, service } = fixture();
  await stores.installed.set(installed("legacy", { configurationStatus: "verified" }));
  manifests.set("legacy", manifest("legacy"));
  await stores.credentials.set("legacy", { serviceAccountJson: "must-survive" }, 100);
  await assert.rejects(() => service.initializeMigration(), /cannot be represented/);
  assert.equal((await stores.projectPackages.read()).migrationCompletedAt, null);
  assert.deepEqual(Object.keys((await stores.credentials.snapshot()).packages), ["legacy"]);
  assert.equal((await stores.installed.get("legacy"))?.enabled, false);
});

test("a completed empty migration repairs later legacy credentials instead of clearing them", async () => {
  const { stores, manifests, service } = fixture();
  await stores.installed.set(installed("drive", { configurationStatus: "verified" }));
  manifests.set("drive", manifest("drive", { type: "google-service-account", requiredFields: ["serviceAccountJson"] }));
  await stores.projectPackages.write({ schemaVersion: 1, migrationCompletedAt: 400, profiles: {}, assignments: [], legacyProfileByPackage: {} });
  await stores.credentials.set("drive", { serviceAccountJson: "must-survive" }, 450);

  await service.initializeMigration();
  const repaired = await stores.projectPackages.read();
  const profileId = repaired.legacyProfileByPackage.drive;
  assert.equal(repaired.migrationCompletedAt, 400);
  assert.deepEqual(repaired.profiles[profileId]?.values, { serviceAccountJson: "must-survive" });
  assert.deepEqual(repaired.assignments, [
    { projectId: PROJECT_A, packageId: "drive", profileId },
    { projectId: PROJECT_B, packageId: "drive", profileId },
  ]);
  assert.deepEqual((await stores.credentials.snapshot()).packages, {});

  await service.initializeMigration();
  assert.deepEqual(await stores.projectPackages.read(), repaired);
});

test("configuration fields stay readable for a package that has no migrated legacy profile", async () => {
  const { stores, manifests, service } = fixture();
  await stores.installed.set(installed("drive"));
  manifests.set("drive", manifest("drive", { type: "google-service-account", requiredFields: ["serviceAccountJson"] }));
  await service.initializeMigration();

  const schema = await service.legacyConfigurationSchema("drive");
  assert.equal(schema.fields.some((field) => field.id === "serviceAccountJson"), true);
  assert.deepEqual(schema.configured, {});
  await assert.rejects(() => service.configureLegacyPackageProfile("drive", { serviceAccountJson: "x" }), /legacy profile/);
});

test("profile lifecycle is redacted and assignments enforce type, fields, verification, and references", async () => {
  const { stores, manifests, service } = fixture();
  await stores.installed.set(installed("drive"));
  await stores.installed.set(installed("filesystem"));
  manifests.set("drive", manifest("drive", { type: "google-service-account", requiredFields: ["serviceAccountJson"] }));
  manifests.set("filesystem", manifest("filesystem"));
  await service.initializeMigration();

  const profile = await service.createProfile("google-service-account", "Production Google");
  const configured = await service.configureProfile(profile.profileId, { serviceAccountJson: "write-only-sentinel" });
  assert.equal((await service.operations.wait(configured.id)).status, "success");
  const safeConfigured = await service.getProfile(profile.profileId);
  assert.deepEqual(safeConfigured.configuredFields, { serviceAccountJson: true });
  assert.equal(safeConfigured.status, "unverified");
  assert.equal(JSON.stringify(safeConfigured).includes("write-only-sentinel"), false);

  await assert.rejects(service.setAssignment(PROJECT_A, "drive", profile.profileId), (error: unknown) => error instanceof ArmoryProjectPackagesError && error.code === "PROFILE_NOT_VERIFIED");
  const verification = await service.verifyProfile(profile.profileId);
  assert.equal((await service.operations.wait(verification.id)).status, "success");
  assert.equal((await service.getProfile(profile.profileId)).status, "verified");
  assert.deepEqual(await service.setAssignment(PROJECT_A, "drive", profile.profileId), { projectId: PROJECT_A, packageId: "drive", profileId: profile.profileId });
  assert.deepEqual(await service.setAssignment(PROJECT_A, "filesystem", null), { projectId: PROJECT_A, packageId: "filesystem", profileId: null });
  await removeProjectPackageAssignmentsForUninstall(stores, "filesystem");
  assert.deepEqual((await service.listAssignments(PROJECT_A)).assignments.map((assignment) => assignment.packageId), ["drive"]);

  const wrong = await service.createProfile("aws-credentials", "Wrong type");
  await assert.rejects(service.setAssignment(PROJECT_B, "drive", wrong.profileId), (error: unknown) => error instanceof ArmoryProjectPackagesError && error.code === "PROFILE_TYPE_MISMATCH");
  await assert.rejects(service.setAssignment(PROJECT_B, "filesystem", profile.profileId), (error: unknown) => error instanceof ArmoryProjectPackagesError && error.code === "PROFILE_TYPE_MISMATCH");
  await assert.rejects(service.setAssignment(PROJECT_B, "drive", null), (error: unknown) => error instanceof ArmoryProjectPackagesError && error.code === "PROFILE_NOT_FOUND");
  await assert.rejects(service.deleteProfile(profile.profileId), (error: unknown) => error instanceof ArmoryProjectPackagesError && error.code === "PROFILE_IN_USE");

  await service.removeAssignment(PROJECT_A, "drive");
  assert.equal((await service.deleteProfile(profile.profileId)).profileId, profile.profileId);
});

test("profile verification and assignment both refuse missing required fields", async () => {
  const { stores, manifests, service } = fixture();
  await stores.installed.set(installed("drive"));
  manifests.set("drive", manifest("drive", { type: "google-service-account", requiredFields: ["serviceAccountJson"] }));
  await service.initializeMigration();
  const profile = await service.createProfile("google-service-account", "Incomplete");
  const configured = await service.configureProfile(profile.profileId, { region: "us" });
  await service.operations.wait(configured.id);
  const verified = await service.verifyProfile(profile.profileId);
  const verification = await service.operations.wait(verified.id);
  assert.equal(verification.status, "failure");
  assert.equal(verification.errorCode, "PROFILE_FIELDS_MISSING");
  await assert.rejects(service.setAssignment(PROJECT_A, "drive", profile.profileId), (error: unknown) => error instanceof ArmoryProjectPackagesError && error.code === "PROFILE_FIELDS_MISSING");
});

test("restart recovery terminates interrupted durable profile operations safely", async () => {
  const { stores } = fixture();
  const operationId = "123e4567-e89b-42d3-a456-426614174001";
  await stores.operations.save({
    id: operationId,
    packageId: "profile-123e4567e89b42d3a456426614174000",
    kind: "profile_verify",
    status: "running",
    phase: "verifying",
    progress: 50,
    message: "Verifying profile",
    errorCode: null,
    startedAt: 10,
    finishedAt: null,
  });
  assert.equal(await recoverInterruptedArmoryOperations(stores, 100), 1);
  const recovered = await stores.operations.get(operationId);
  assert.equal(recovered?.status, "failure");
  assert.equal(recovered?.errorCode, "INTERRUPTED_OPERATION");
  assert.match(recovered?.message ?? "", /profile/i);
});
