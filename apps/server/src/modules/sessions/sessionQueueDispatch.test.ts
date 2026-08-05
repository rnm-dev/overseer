import assert from "node:assert/strict";
import test from "node:test";
import type { PeonCallResult } from "../../infrastructure/peonHttp/index.js";
import { dispatchQueuedSessionItem } from "./sessionQueueDispatch.js";

test("dispatchQueuedSessionItem preserves the selected compatibility endpoint", async () => {
  for (const operation of ["steer", "send"] as const) {
    const accepted: PeonCallResult = { status: 200, ok: true, json: { id: "session" } };
    const calls: unknown[][] = [];
    const indexed: unknown[][] = [];
    const result = await dispatchQueuedSessionItem({
      conn: { baseUrl: "http://peon", token: "secret" }, workspaceId: "ws", peonId: "peon",
      sessionId: "session/id", itemId: "item/id", actor: "actor", operation,
    }, {
      call: async (...args) => { calls.push(args); return accepted; },
      index: async (...args) => { indexed.push(args); return true; },
    });
    assert.equal(result, accepted);
    assert.deepEqual(calls, [[
      { baseUrl: "http://peon", token: "secret" },
      "POST",
      `/sessions/session%2Fid/queue/item%2Fid/${operation}`,
      { actor: "actor" },
    ]]);
    assert.deepEqual(indexed, [[accepted, "ws", "peon"]]);
  }
});

test("dispatchQueuedSessionItem repairs an accepted response without a session record", async () => {
  const accepted: PeonCallResult = { status: 202, ok: true, json: { ok: true } };
  const snapshot: PeonCallResult = { status: 200, ok: true, json: { id: "session" } };
  const calls: unknown[][] = [];
  const indexed: unknown[][] = [];
  const result = await dispatchQueuedSessionItem({
    conn: { baseUrl: "http://peon", token: "secret" }, workspaceId: "ws", peonId: "peon",
    sessionId: "session", itemId: "item", actor: "actor", operation: "steer",
  }, {
    call: async (...args) => {
      calls.push(args);
      const [, method] = args;
      return method === "POST" ? accepted : snapshot;
    },
    index: async (...args) => { indexed.push(args); return args[0] === snapshot; },
  });
  assert.equal(result, accepted);
  assert.deepEqual(calls, [
    [
      { baseUrl: "http://peon", token: "secret" },
      "POST",
      "/sessions/session/queue/item/steer",
      { actor: "actor" },
    ],
    [
      { baseUrl: "http://peon", token: "secret" },
      "GET",
      "/sessions/session",
      { actor: "actor" },
    ],
  ]);
  assert.deepEqual(indexed, [
    [accepted, "ws", "peon"],
    [snapshot, "ws", "peon"],
  ]);
});

test("dispatchQueuedSessionItem does not repair a refused mutation", async () => {
  const refused: PeonCallResult = { status: 409, ok: false, json: { code: "NOT_RUNNING" } };
  let indexCalls = 0;
  const result = await dispatchQueuedSessionItem({
    conn: { baseUrl: "http://peon", token: "secret" }, workspaceId: "ws", peonId: "peon",
    sessionId: "session", itemId: "item", actor: "actor", operation: "send",
  }, {
    call: async () => refused,
    index: async () => { indexCalls += 1; return false; },
  });
  assert.equal(result, refused);
  assert.equal(indexCalls, 0);
});
