import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { peonsRouter } from "../peons.js";
import {
  normalizeArmoryResult,
  safeAssignmentResult,
  safeConfigurationResult,
  safeProfileOperationResult,
  safeProfileResult,
} from "./armory.js";

test("Armory exposes discovery, configuration, and lifecycle mutation routes", () => {
  const router = peonsRouter() as unknown as { stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }> };
  const root = "/workspaces/:wsId/peons/:id/armory";
  const routes = router.stack.flatMap((layer) => layer.route ? [layer.route] : []).filter((route) => route.path?.startsWith(root));
  const has = (path: string, method: string) => routes.some((route) => route.path === path && route.methods?.[method]);
  assert.equal(has(`${root}/packages`, "get"), true);
  assert.equal(has(`${root}/refresh`, "post"), true);
  assert.equal(has(`${root}/packages/:packageId`, "get"), true);
  assert.equal(has(`${root}/packages/:packageId/install`, "post"), true);
  assert.equal(has(`${root}/packages/:packageId/update`, "post"), true);
  assert.equal(has(`${root}/packages/:packageId`, "delete"), true);
  assert.equal(has(`${root}/packages/:packageId/configuration`, "get"), true);
  assert.equal(has(`${root}/packages/:packageId/configuration`, "put"), true);
  assert.equal(has(`${root}/packages/:packageId/configuration`, "delete"), true);
  assert.equal(has(`${root}/packages/:packageId/configuration/verify`, "post"), true);
  assert.equal(has(`${root}/packages/:packageId/mcp`, "get"), true);
  assert.equal(has(`${root}/profiles`, "get"), true);
  assert.equal(has(`${root}/profiles`, "post"), true);
  assert.equal(has(`${root}/profiles/:profileId`, "patch"), true);
  assert.equal(has(`${root}/profiles/:profileId`, "delete"), true);
  assert.equal(has(`${root}/profiles/:profileId/configuration`, "put"), true);
  assert.equal(has(`${root}/profiles/:profileId/verify`, "post"), true);
  assert.equal(has(`${root}/projects/:projectId/assignments`, "get"), true);
  assert.equal(has(`${root}/projects/:projectId/assignments/:packageId`, "put"), true);
  assert.equal(has(`${root}/projects/:projectId/assignments/:packageId`, "delete"), true);
  // These paths remain mounted only for mixed fleets. Capable Peons receive a
  // local, side-effect-free ARMORY_ACTIVATION_RETIRED response.
  assert.equal(has(`${root}/packages/:packageId/enable`, "post"), true);
  assert.equal(has(`${root}/packages/:packageId/disable`, "post"), true);
  assert.equal(has(`${root}/settings`, "get"), true);
  assert.equal(has(`${root}/operations/:operationId`, "get"), true);
  for (const route of routes) {
    for (const method of Object.keys(route.methods ?? {})) assert.ok(["get", "post", "put", "patch", "delete"].includes(method));
  }
});

test("Armory production routes have one direct Fleet HTTP authority", () => {
  const source = readFileSync(new URL("./armory.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /reverseCommand|runReverseCommandTransport|armoryCall/);
  assert.match(source, /import \{ callPeon, connOfRecord \}/);
  assert.equal((source.match(/\bcallPeon\(/g) ?? []).length, 23);
  for (const operation of [
    "inventory", "settings", "package", "configuration", "mcp", "operation",
    "refresh", "install", "update", "enable", "disable", "configure", "verify",
    "configuration.delete", "uninstall",
  ]) {
    assert.doesNotMatch(source, new RegExp(`["'\`]armory\\\\.${operation.replace(".", "\\\\.")}["'\`]`));
  }
});

test("Armory configuration relays suppress submitted values in errors and operation diagnostics", () => {
  const secret = "hb_live_must_not_escape";
  assert.deepEqual(safeConfigurationResult({ status: 400, json: { code: secret, error: `Invalid ${secret}` } }, true), {
    status: 400,
    json: { code: "CONFIGURATION_REJECTED", error: "Peon rejected the configuration." },
  });
  const operation = safeConfigurationResult({
    status: 200,
    json: { operation: { id: "op", kind: "configure", status: "failure", phase: secret, message: secret, errorCode: secret } },
  });
  assert.doesNotMatch(JSON.stringify(operation), new RegExp(secret));
  assert.deepEqual((operation.json as { operation: { phase: string; message: string; errorCode: null } }).operation, {
    id: "op", kind: "configure", status: "failure", phase: "configuration", message: "", errorCode: null,
  });
});

test("typed Armory relays reconstruct bounded safe resources and operations", () => {
  const profileId = "57ba5e9e-3ed2-4a92-919f-9f60ee69a450";
  const projectId = "87b68e30-a923-48b4-9a58-f561a2390083";
  const operationId = "f09663fc-fc80-4314-a7e6-70b14dd29473";
  const secret = "profile_value_must_not_escape";
  assert.deepEqual(safeProfileResult({
    status: 200,
    json: { profileId, type: "google-service-account", name: "Shared", status: "verified", configuredFields: { serviceAccountJson: true }, values: { serviceAccountJson: secret } },
  }).json, {
    profileId, type: "google-service-account", name: "Shared", status: "verified", configuredFields: { serviceAccountJson: true }, identity: null,
  });
  assert.deepEqual(safeAssignmentResult({
    status: 200,
    json: { projectId, packageId: "google-drive", profileId, unexpected: secret },
  }).json, { projectId, packageId: "google-drive", profileId });
  assert.deepEqual(safeProfileOperationResult({
    status: 202,
    json: { operationId, kind: "profile_configure", status: "queued", code: null, diagnostics: secret },
  }).json, { operationId, kind: "profile_configure", status: "queued", code: null });
  assert.deepEqual(safeProfileResult({
    status: 200,
    json: { profiles: Array.from({ length: 101 }, () => ({ profileId, type: "type", name: "Name", status: "missing", configuredFields: {} })) },
  }, true), {
    status: 502,
    json: { error: "Peon returned an unsafe Armory response.", code: "UNSAFE_ARMORY_RESULT" },
  });
  assert.deepEqual(safeProfileResult({ status: 409, json: { error: secret, code: "PROFILE_IN_USE", diagnostics: secret } }), {
    status: 409,
    json: { error: "Peon rejected the Armory request.", code: "PROFILE_IN_USE" },
    requestId: undefined,
  });
  assert.doesNotMatch(JSON.stringify(safeProfileResult({
    status: 502,
    json: { error: secret, code: "PEON_UNREACHABLE" },
  })), new RegExp(secret));
});

test("a profile identity is relayed whole, bounded, and refused when malformed", () => {
  const profileId = "57ba5e9e-3ed2-4a92-919f-9f60ee69a450";
  const profile = (identity: unknown) => ({
    status: 200,
    json: { profileId, type: "google-service-account", name: "Shared", status: "verified", configuredFields: { serviceAccountJson: true }, identity },
  });
  const email = "drive-sync@example-project.iam.gserviceaccount.com";
  assert.deepEqual((safeProfileResult(profile({ label: "Service account email", value: email })).json as { identity: unknown }).identity,
    { label: "Service account email", value: email });
  // A Peon that predates the identity contract simply has none.
  assert.equal((safeProfileResult(profile(undefined)).json as { identity: unknown }).identity, null);
  assert.equal((safeProfileResult(profile(null)).json as { identity: unknown }).identity, null);
  const unsafe = { status: 502, json: { error: "Peon returned an unsafe Armory response.", code: "UNSAFE_ARMORY_RESULT" } };
  assert.deepEqual(safeProfileResult(profile({ label: "Service account email" })), unsafe);
  assert.deepEqual(safeProfileResult(profile({ label: "", value: email })), unsafe);
  assert.deepEqual(safeProfileResult(profile({ label: "Service account email", value: "x".repeat(321) })), unsafe);
  assert.deepEqual(safeProfileResult(profile("drive-sync@example-project.iam.gserviceaccount.com")), unsafe);
  assert.deepEqual((safeProfileResult(profile({ label: "Service account email", value: email, extra: "leak" })).json as { identity: unknown }).identity,
    { label: "Service account email", value: email });
});

test("profile operation polling strips diagnostics and rejects unsafe custom codes", () => {
  const operationId = "f09663fc-fc80-4314-a7e6-70b14dd29473";
  const secret = "PROFILE_SECRET_SENTINEL";
  assert.deepEqual(safeConfigurationResult({
    status: 200,
    json: { operation: { operationId, kind: "profile_verify", status: "failed", code: "PROFILE_NOT_VERIFIED", diagnostics: secret } },
  }), {
    status: 200,
    json: { operation: { operationId, kind: "profile_verify", status: "failed", code: "PROFILE_NOT_VERIFIED" } },
  });
  const rejected = safeProfileOperationResult({
    status: 400,
    json: { error: secret, code: secret },
  }, true);
  assert.doesNotMatch(JSON.stringify(rejected), new RegExp(secret));
  assert.deepEqual(rejected.json, {
    error: "Peon rejected the profile configuration request.",
    code: "ARMORY_REQUEST_FAILED",
  });
});

test("Armory operations expose the public progress field without non-finite values", () => {
  assert.deepEqual(normalizeArmoryResult({
    operation: { id: "op", kind: "update", status: "running", phase: "health_check", percent: 94 },
  }), {
    operation: { id: "op", kind: "update", status: "running", phase: "health_check", progress: 94 },
  });
  assert.deepEqual(normalizeArmoryResult({
    operation: { id: "op", kind: "update", status: "failure", phase: "failed", percent: Number.NaN },
  }), {
    operation: { id: "op", kind: "update", status: "failure", phase: "failed", progress: null },
  });
});
