import assert from "node:assert/strict";
import test from "node:test";
import { peonsRouter } from "./routes/peons.js";

test("legacy integration routes are absent while current project and status routes remain", () => {
  const router = peonsRouter() as unknown as {
    stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>;
  };
  const has = (path: string, method: string) => router.stack.some(
    (layer) => layer.route?.path === path && layer.route.methods?.[method],
  );
  const root = "/workspaces/:wsId/peons/:id";

  assert.equal(has(`${root}/status`, "patch"), true);
  assert.equal(has(`${root}/integrations`, "get"), false);
  assert.equal(has(`${root}/integrations`, "post"), false);
  assert.equal(has(`${root}/integrations/:key`, "patch"), false);
  assert.equal(has(`${root}/integrations/:key`, "delete"), false);
  assert.equal(has(`${root}/integrations/:key/projects`, "get"), false);
  assert.equal(has(`${root}/projects/:key/integration`, "put"), false);
  assert.equal(has(`${root}/projects/:key/integration`, "delete"), false);
  assert.equal(has(`${root}/projects/:key/settings`, "get"), true);
  assert.equal(has(`${root}/projects/:key/settings`, "patch"), true);
  assert.equal(has(`${root}/projects/:key/skills`, "get"), true);
  assert.equal(has(`${root}/projects/:key`, "patch"), false);
  assert.equal(has(`${root}/projects/import`, "post"), false);
});
