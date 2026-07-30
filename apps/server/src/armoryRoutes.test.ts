import assert from "node:assert/strict";
import test from "node:test";
import { peonsRouter } from "./routes/peons.js";
import { normalizeArmoryResult, safeConfigurationResult } from "./routes/peons/armory.js";

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
  assert.equal(has(`${root}/packages/:packageId/mcp`, "get"), true);
  assert.equal(has(`${root}/packages/:packageId/enable`, "post"), true);
  assert.equal(has(`${root}/packages/:packageId/disable`, "post"), true);
  assert.equal(has(`${root}/settings`, "get"), true);
  assert.equal(has(`${root}/operations/:operationId`, "get"), true);
  for (const route of routes) {
    for (const method of Object.keys(route.methods ?? {})) assert.ok(["get", "post", "put", "delete"].includes(method));
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

test("Armory reverse operations expose the public progress field without non-finite values", () => {
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
