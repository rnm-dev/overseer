import assert from "node:assert/strict";
import test from "node:test";
import { peonsRouter } from "./routes/peons.js";

test("follow-up queue operations are exposed through the workspace Peon proxy", () => {
  const router = peonsRouter() as unknown as {
    stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>;
  };
  const has = (path: string, method: string) => router.stack.some(
    (layer) => layer.route?.path === path && layer.route.methods?.[method],
  );
  const queue = "/workspaces/:wsId/peons/:id/sessions/:sid/queue";
  assert.equal(has(queue, "get"), true);
  assert.equal(has(queue, "post"), true);
  assert.equal(has(`${queue}/:itemId/send`, "post"), true);
  assert.equal(has(`${queue}/:itemId`, "delete"), true);
});
