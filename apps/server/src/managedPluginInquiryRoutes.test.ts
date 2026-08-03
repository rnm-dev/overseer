import assert from "node:assert/strict";
import test from "node:test";
import { peonsRouter } from "./routes/peons.js";

test("managed plugin inquiries use only the workspace Peon Fleet HTTP surface", () => {
  const router = peonsRouter() as unknown as {
    stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>;
  };
  const has = (path: string, method: string) => router.stack.some(
    (layer) => layer.route?.path === path && layer.route.methods?.[method],
  );
  const collection = "/workspaces/:wsId/peons/:id/sessions/:sid/inquiries";
  assert.equal(has(collection, "get"), true);
  assert.equal(has(`${collection}/:inquiryId`, "get"), true);
  assert.equal(has(`${collection}/:inquiryId/respond`, "post"), true);
  assert.equal(has(`${collection}/:inquiryId/auth/:appId`, "get"), true);
  assert.equal(router.stack.some((layer) => String(layer.route?.path ?? "").includes("inquiries")
    && layer.route?.methods?.delete), false);
});
