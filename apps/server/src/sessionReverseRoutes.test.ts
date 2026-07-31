import assert from "node:assert/strict";
import test from "node:test";
import { peonsRouter } from "./routes/peons.js";
import { sessionReverseHttpResponse } from "./routes/peons/sessions.js";
import type { ReverseCommandHttpResult, ReverseCommandOperation } from "./modules/reverseCommands/index.js";

const session = { id: "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5", status: "running" };
const applied = (result: Record<string, unknown>, reused = false): ReverseCommandHttpResult => ({
  status: 200,
  body: { status: "applied", code: "OK", result },
  reused,
});

test("every released session operation has its public workspace route", () => {
  const router = peonsRouter() as unknown as {
    stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>;
  };
  const has = (path: string, method: string) => router.stack.some(
    (layer) => layer.route?.path === path && layer.route.methods?.[method],
  );
  const base = "/workspaces/:wsId/peons/:id/sessions";
  const sessionBase = `${base}/:sid`;
  assert.equal(has(base, "post"), true);
  assert.equal(has(sessionBase, "get"), true);
  assert.equal(has(sessionBase, "patch"), true);
  assert.equal(has(sessionBase, "delete"), true);
  assert.equal(has(`${sessionBase}/followup`, "post"), true);
  assert.equal(has(`${sessionBase}/cancel`, "post"), true);
  assert.equal(has(`${sessionBase}/queue`, "get"), true);
  assert.equal(has(`${sessionBase}/queue`, "post"), true);
  assert.equal(has(`${sessionBase}/queue/:itemId`, "patch"), true);
  assert.equal(has(`${sessionBase}/queue/:itemId`, "delete"), true);
  assert.equal(has(`${sessionBase}/queue/:itemId/send`, "post"), true);
});

test("reverse terminal results preserve legacy session HTTP response shapes", () => {
  const cases: Array<[ReverseCommandOperation, ReverseCommandHttpResult, number, unknown]> = [
    ["session.metadata.patch", applied(session), 200, session],
    ["session.delete", applied({ sessionId: session.id, deleted: true }), 200, { ok: true }],
  ];
  for (const [operation, result, status, body] of cases) {
    assert.deepEqual(sessionReverseHttpResponse(operation, result), { status, body }, operation);
  }
});

test("pending results retain status reconciliation and delete preserves its legacy conflict code", () => {
  const pending: ReverseCommandHttpResult = {
    status: 202,
    body: {
      code: "COMMAND_PENDING",
      commandId: "528f4f0c-9f30-8a61-af1a-66d2582bdb4a",
      statusUrl: "/api/workspaces/w/peons/p/commands/c",
    },
  };
  assert.deepEqual(sessionReverseHttpResponse("session.metadata.patch", pending), {
    status: 202,
    body: pending.body,
  });
  assert.deepEqual(sessionReverseHttpResponse("session.delete", {
    status: 409,
    body: { status: "conflict", code: "SESSION_RUNNING", result: null },
  }), {
    status: 409,
    body: { status: "conflict", code: "SESSION_NOT_RUNNING", result: null },
  });
});
