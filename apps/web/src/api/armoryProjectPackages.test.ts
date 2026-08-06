import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ApiError } from "../api";
import { ArmoryLifecyclePanel } from "../pages/peon/ArmoryLifecyclePanel";
import { ArmoryProfilesPanel } from "../pages/peon/ArmoryProfilesPanel";
import { ProjectPackageAssignmentCard, UNASSIGNMENT_CONTEXT_COPY } from "../pages/peon/ProjectArmoryPackages";
import {
  ARMORY_PROJECT_PACKAGES_CAPABILITY,
  ArmoryRequestGate,
  armoryProfileReadiness,
  clearSettledArmoryProfileValues,
  configureArmoryProfile,
  createArmoryProfile,
  deleteArmoryProfile,
  getArmoryProfileOperation,
  getArmoryProfiles,
  getArmoryProjectAssignments,
  matchingArmoryProfiles,
  missingArmoryProfileFields,
  profileOperationActive,
  removeArmoryProjectAssignment,
  renameArmoryProfile,
  setArmoryProjectAssignment,
  supportsArmoryProjectPackages,
  validateArmoryProfileConfiguration,
  verifyArmoryProfile,
  type ArmoryConfiguration,
  type ArmoryPackageSummary,
  type ArmoryProfile,
  type ArmoryProfileRequirement,
} from "../pages/peon/armoryApi";

const profileId = "57ba5e9e-3ed2-4a92-919f-9f60ee69a450";
const projectId = "87b68e30-a923-48b4-9a58-f561a2390083";
const operationId = "f09663fc-fc80-4314-a7e6-70b14dd29473";
const requirement: ArmoryProfileRequirement = { type: "google-service-account", requiredFields: ["serviceAccountJson"] };
const verified: ArmoryProfile = { profileId, type: requirement.type, name: "Shared Google", status: "verified", configuredFields: { serviceAccountJson: true } };
const unverified: ArmoryProfile = { ...verified, profileId: "57ba5e9e-3ed2-4a92-919f-9f60ee69a451", name: "Staging Google", status: "unverified" };
const missing: ArmoryProfile = { ...verified, profileId: "57ba5e9e-3ed2-4a92-919f-9f60ee69a452", name: "Empty Google", status: "missing", configuredFields: {} };
const mismatch: ArmoryProfile = { ...verified, profileId: "57ba5e9e-3ed2-4a92-919f-9f60ee69a453", name: "GitHub", type: "github-token" };
const schema: ArmoryConfiguration = {
  packageId: "google-drive",
  fields: [{ id: "serviceAccountJson", label: "Service account JSON", help: "Write-only JSON credential.", type: "secret", required: true }],
  configured: { serviceAccountJson: true },
  hostWrites: [],
};
const packageItem: ArmoryPackageSummary = {
  id: "google-drive",
  available: true,
  displayName: "Google Drive",
  summary: "Drive tools",
  publisher: "rnm-dev",
  documentationUrl: null,
  latestVersion: "1.0.0",
  requirements: { credentials: true, hostWrites: false },
  capabilities: { mcp: true },
  installed: { packageId: "google-drive", version: "1.0.0", state: "ready", profileRequirement: requirement },
  updateAvailable: false,
};

test("typed profile and assignment clients use only the capability routes and keep values out of URLs/results", async () => {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  const request = async <T>(path: string, options?: RequestInit): Promise<T> => {
    calls.push({ path, options });
    if (path.endsWith("/configuration")) return { operationId, kind: "profile_configure", status: "queued", code: null } as T;
    if (path.endsWith("/verify")) return { operationId, kind: "profile_verify", status: "queued", code: null } as T;
    if (path.endsWith(`/operations/${operationId}`)) return { operation: { operationId, kind: "profile_verify", status: "succeeded", code: null } } as T;
    if (path.endsWith("/profiles") && !options?.method) return { profiles: [verified] } as T;
    if (path.includes("/assignments") && !options?.method) return { assignments: [] } as T;
    if (path.includes("/assignments")) return { projectId, packageId: "google-drive", profileId: null } as T;
    return verified as T;
  };
  const secret = "profile-secret-never-render";
  await getArmoryProfiles("/p", request);
  await createArmoryProfile("/p", requirement.type, "Shared Google", request);
  await renameArmoryProfile("/p", profileId, "Renamed", request);
  await deleteArmoryProfile("/p", profileId, request);
  const configured = await configureArmoryProfile("/p", profileId, { serviceAccountJson: secret }, request);
  await verifyArmoryProfile("/p", profileId, request);
  await getArmoryProfileOperation("/p", operationId, request);
  await getArmoryProjectAssignments("/p", projectId, request);
  await setArmoryProjectAssignment("/p", projectId, "google-drive", profileId, request);
  await setArmoryProjectAssignment("/p", projectId, "filesystem-tools", null, request);
  await removeArmoryProjectAssignment("/p", projectId, "google-drive", request);

  assert.deepEqual(calls.map(({ path, options }) => [path, options?.method]), [
    ["/p/armory/profiles", undefined], ["/p/armory/profiles", "POST"],
    [`/p/armory/profiles/${profileId}`, "PATCH"], [`/p/armory/profiles/${profileId}`, "DELETE"],
    [`/p/armory/profiles/${profileId}/configuration`, "PUT"], [`/p/armory/profiles/${profileId}/verify`, "POST"],
    [`/p/armory/operations/${operationId}`, undefined], [`/p/armory/projects/${projectId}/assignments`, undefined],
    [`/p/armory/projects/${projectId}/assignments/google-drive`, "PUT"], [`/p/armory/projects/${projectId}/assignments/filesystem-tools`, "PUT"],
    [`/p/armory/projects/${projectId}/assignments/google-drive`, "DELETE"],
  ]);
  assert.deepEqual(JSON.parse(String(calls[8].options?.body)), { profileId });
  assert.deepEqual(JSON.parse(String(calls[9].options?.body)), { profileId: null });
  assert.ok(calls.every(({ path }) => !path.includes(secret)));
  assert.doesNotMatch(JSON.stringify(configured), new RegExp(secret));
});

test("profile configuration failures are fixed/redacted and all settled form values are discarded", async () => {
  const secret = "must-not-survive";
  const request = async <T>(): Promise<T> => { throw new ApiError(400, secret, `Rejected ${secret}`); };
  await assert.rejects(() => configureArmoryProfile("/p", profileId, { serviceAccountJson: secret }, request), (error: ApiError) =>
    error.code === "PROFILE_CONFIGURATION_REJECTED" && error.message === "Peon rejected the profile configuration request." && !JSON.stringify(error).includes(secret));
  assert.deepEqual(clearSettledArmoryProfileValues(), {});
});

test("profile compatibility is exact and readiness reports missing, unverified, invalid, and mismatched states", () => {
  assert.deepEqual(matchingArmoryProfiles([verified, unverified, missing, mismatch], requirement).map((profile) => profile.name), ["Shared Google", "Staging Google", "Empty Google"]);
  assert.deepEqual(missingArmoryProfileFields(missing, requirement), ["serviceAccountJson"]);
  assert.equal(armoryProfileReadiness(verified, requirement), "ready");
  assert.equal(armoryProfileReadiness(unverified, requirement), "unverified");
  assert.equal(armoryProfileReadiness(missing, requirement), "missing_fields");
  assert.equal(armoryProfileReadiness({ ...verified, status: "invalid" }, requirement), "invalid");
  assert.equal(armoryProfileReadiness(mismatch, requirement), "type_mismatch");
  assert.deepEqual(validateArmoryProfileConfiguration(schema, verified, {}), {});
  assert.equal(validateArmoryProfileConfiguration(schema, missing, {}).serviceAccountJson, "Service account JSON is required.");
});

test("capability gating is exact and request generations reject stale profile/assignment responses", () => {
  assert.equal(supportsArmoryProjectPackages([ARMORY_PROJECT_PACKAGES_CAPABILITY]), true);
  assert.equal(supportsArmoryProjectPackages(["armory-project-packages-v2"]), false);
  assert.equal(supportsArmoryProjectPackages([]), false);
  const gate = new ArmoryRequestGate();
  const oldProject = gate.begin();
  const newProject = gate.begin();
  assert.equal(gate.current(oldProject), false);
  assert.equal(gate.current(newProject), true);
  gate.clear();
  assert.equal(gate.current(newProject), false);
});

test("capable package lifecycle preserves install/update/uninstall without rendering activation controls", () => {
  const markup = renderToStaticMarkup(createElement(ArmoryLifecyclePanel, {
    base: "/p", packageId: packageItem.id, installed: packageItem.installed, projectPackages: true,
    latestVersion: "1.0.0", updateAvailable: false, onRefresh: async () => {},
  }));
  assert.match(markup, /Installed Peon-wide/);
  assert.match(markup, /Profile requirement/);
  assert.match(markup, /google-service-account/);
  assert.match(markup, />Uninstall</);
  assert.doesNotMatch(markup, /Enable package|Disable package|Runtime|Configuration is ready|active on the Peon/);
});

test("shared profile UI exposes type/status/actions and accessible write-only fields without rendering values", () => {
  const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ArmoryProfilesPanel, {
    base: "/p", requirement, schema, profiles: [verified, unverified, missing, mismatch], loading: false, error: null, onRefresh: async () => {},
  })));
  assert.match(markup, /Shared profiles/);
  assert.match(markup, /google-service-account/);
  assert.match(markup, /different exact type/);
  assert.match(markup, /Shared Google/);
  assert.match(markup, /Staging Google/);
  assert.match(markup, /Empty Google/);
  assert.doesNotMatch(markup, />GitHub</);
  assert.match(markup, /Configured profile has not been verified/);
  assert.match(markup, /Missing required fields: serviceAccountJson/);
  assert.match(markup, /type="password"/);
  assert.match(markup, /readOnly=""/);
  assert.match(markup, /data-1p-ignore="true"/);
  assert.match(markup, /aria-label="required"/);
  assert.match(markup, /Save write-only configuration/);
  assert.doesNotMatch(markup, /profile-secret-never-render|placeholder="stored|value="profile/);
});

test("assignment UI reuses only compatible ready profiles and presents invalid assignment states", () => {
  const assignment = { projectId, packageId: packageItem.id, profileId: mismatch.profileId };
  const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProjectPackageAssignmentCard, {
    item: packageItem, assignment, profiles: [verified, unverified, missing, mismatch], busy: false,
    settingsLink: "/peons/p/settings/armory/google-drive", onAssign: async () => {}, onRemove: async () => {},
  })));
  assert.match(markup, /Assigned · unavailable/);
  assert.match(markup, /Assigned profile type does not match google-service-account/);
  assert.match(markup, /Shared Google — verified/);
  assert.match(markup, /Staging Google — unverified/);
  assert.match(markup, /Empty Google — missing fields/);
  assert.doesNotMatch(markup, />GitHub —/);
  assert.match(markup, /<option[^>]*disabled=""[^>]*>Staging Google — unverified/);
  assert.match(markup, /<span class="sr-only">Profile for Google Drive/);
  assert.match(markup, /Remove assignment/);
});

test("credential-free packages assign null without a fake profile and unassignment copy scopes changes to future turns", () => {
  const credentialFree = { ...packageItem, id: "filesystem-tools", displayName: "Filesystem", installed: { ...packageItem.installed!, packageId: "filesystem-tools", profileRequirement: null } };
  const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProjectPackageAssignmentCard, {
    item: credentialFree, assignment: null, profiles: [], busy: false,
    settingsLink: "/peons/p/settings/armory/filesystem-tools", onAssign: async () => {}, onRemove: async () => {},
  })));
  assert.match(markup, /Credential-free package/);
  assert.match(markup, /Assign to project/);
  assert.doesNotMatch(markup, /<select|fake profile|default profile/i);
  assert.match(UNASSIGNMENT_CONTEXT_COPY, /future turns/);
  assert.match(UNASSIGNMENT_CONTEXT_COPY, /reduce context and token use/);
  assert.match(UNASSIGNMENT_CONTEXT_COPY, /active turn does not change/i);
});

test("profile operation states distinguish active, success, and stable terminal failure", () => {
  assert.equal(profileOperationActive({ operationId, kind: "profile_configure", status: "queued", code: null }), true);
  assert.equal(profileOperationActive({ operationId, kind: "profile_verify", status: "running", code: null }), true);
  assert.equal(profileOperationActive({ operationId, kind: "profile_verify", status: "succeeded", code: null }), false);
  assert.equal(profileOperationActive({ operationId, kind: "profile_verify", status: "failed", code: "PROFILE_NOT_VERIFIED" }), false);
});
