import assert from "node:assert/strict";
import test from "node:test";
import type { PeonCallResult } from "../../infrastructure/peonHttp/index.js";
import { branchSession } from "./sessionBranch.js";

test("branchSession forwards idempotency and records and indexes the accepted branch", async () => {
  const accepted: PeonCallResult = { status: 201, ok: true, json: { session: { id: "new/session" } } };
  const calls: unknown[][] = [];
  const recorded: unknown[] = [];
  const indexed: unknown[][] = [];

  const result = await branchSession({
    conn: { baseUrl: "http://peon", token: "secret" },
    workspaceId: "ws",
    userId: "user",
    peonId: "peon",
    sessionId: "source/id",
    actor: "operator@example.com",
    requestId: "branch-request",
    body: { lastTurnId: "turn" },
    recordRequest: async (input) => { recorded.push(input); },
  }, {
    call: async (...args) => { calls.push(args); return accepted; },
    index: async (...args) => { indexed.push(args); return true; },
  });

  assert.equal(result, accepted);
  assert.deepEqual(calls, [[
    { baseUrl: "http://peon", token: "secret" },
    "POST",
    "/sessions/source%2Fid/branch",
    { actor: "operator@example.com", body: { lastTurnId: "turn" }, requestId: "branch-request" },
  ]]);
  assert.deepEqual(recorded, [{
    workspaceId: "ws",
    userId: "user",
    peonId: "peon",
    sessionId: "new/session",
    occurrenceKey: "branch:branch-request",
  }]);
  assert.deepEqual(indexed, [[accepted, "ws", "peon"]]);
});

test("branchSession preserves a Peon refusal without request bookkeeping", async () => {
  const refused: PeonCallResult = { status: 409, ok: false, json: { code: "BRANCH_FAILED" } };
  let recorded = false;
  const indexed: unknown[][] = [];
  const result = await branchSession({
    conn: { baseUrl: "http://peon", token: "secret" }, workspaceId: "ws", userId: "user",
    peonId: "peon", sessionId: "source", actor: "actor", requestId: "request", body: {},
    recordRequest: async () => { recorded = true; },
  }, {
    call: async () => refused,
    index: async (...args) => { indexed.push(args); return false; },
  });
  assert.equal(result, refused);
  assert.equal(recorded, false);
  assert.deepEqual(indexed, [[refused, "ws", "peon"]]);
});
