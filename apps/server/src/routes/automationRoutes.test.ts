import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { automationRouter } from "./automation.js";
import { peonsRouter } from "./peons.js";

function routes(router: unknown): Array<{ path: string; methods: Record<string, boolean> }> {
  const stack = (router as { stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }> }).stack;
  return stack.flatMap((layer) => layer.route?.path ? [{ path: layer.route.path, methods: layer.route.methods ?? {} }] : []);
}

test("the automation surface exposes exactly the machine control routes", () => {
  const exposed = routes(automationRouter()).map((route) => `${Object.keys(route.methods).sort().join("|")} ${route.path}`).sort();
  assert.deepEqual(exposed, [
    "get /openapi.json",
    "get /sessions",
    "get /sessions/:sid",
    "get /sessions/:sid/transcript",
    "get /whoami",
    "post /sessions",
    "post /sessions/:sid/followup",
    "post /uploads",
  ]);
});

test("the OpenAPI schema is readable without a token", () => {
  // A client generator should not need a credential to learn the shape of the
  // surface it is generating against.
  const layers = (automationRouter() as unknown as { stack: Array<{ route?: { path?: string } }> }).stack;
  const schema = layers.findIndex((layer) => layer.route?.path === "/openapi.json");
  const guard = layers.findIndex((layer) => !layer.route);
  assert.ok(schema >= 0, "the schema route is registered");
  assert.ok(schema < guard, "the schema route sits ahead of the token guard");
});

test("a leaked automation token cannot mint or list tokens", async () => {
  // Minting lives on the operator surface only. If it ever appears here, a
  // stolen token can grow itself a longer-lived sibling and outlive its
  // revocation.
  const source = await readFile(new URL("./automation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /issueAutomationToken|revokeAutomationToken|listAutomationTokens/);
  assert.equal(routes(automationRouter()).some((route) => route.path.includes("token")), false);
});

test("the automation surface never reads a cookie or a device token", async () => {
  const source = await readFile(new URL("./automation.ts", import.meta.url), "utf8");
  // No ambient browser credential may reach these writes — that is what makes
  // the absent CSRF origin check safe.
  assert.doesNotMatch(source, /webSessionToken|verifyDeviceToken|req\.cookies|operatorAuth/);
});

test("token management is operator-authenticated and project-scoped", () => {
  const exposed = routes(peonsRouter());
  const path = "/workspaces/:wsId/peons/:id/projects/:key/automation-tokens";
  const has = (route: string, method: string) => exposed.some((entry) => entry.path === route && entry.methods[method]);
  assert.equal(has(path, "get"), true);
  assert.equal(has(path, "post"), true);
  assert.equal(has(`${path}/:tokenId`, "delete"), true);
});

test("automation is mounted with its own credential, ahead of the operator guard", async () => {
  const source = await readFile(new URL("../app/server.ts", import.meta.url), "utf8");
  const mount = source.indexOf('api.use("/automation/v1", automationRouter());');
  const guard = source.indexOf("api.use(operatorAuth);");
  assert.ok(mount > 0, "automation router is mounted");
  assert.ok(mount < guard, "automation carries its own credential instead of inheriting the operator guard");
});
