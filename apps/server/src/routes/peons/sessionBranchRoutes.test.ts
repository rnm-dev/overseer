import assert from "node:assert/strict";
import test from "node:test";
import { peonsRouter } from "../peons.js";

test("session branching is exposed through the authenticated workspace Peon proxy", () => {
  const router = peonsRouter() as unknown as {
    stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>;
  };
  assert.equal(router.stack.some((layer) =>
    layer.route?.path === "/workspaces/:wsId/peons/:id/sessions/:sid/branch"
    && layer.route.methods?.post), true);
});
