import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb } from "../../infrastructure/db/index.js";
import { runIdempotentFollowup, validCommandId } from "./followupIdempotency.js";

test("accepts UUID and legacy opaque follow-up command IDs", () => {
  assert.equal(validCommandId("018f0000-0000-7000-8000-000000000001"), true);
  assert.equal(validCommandId("legacy-client:session-1:42"), true);
  assert.equal(validCommandId(""), false);
  assert.equal(validCommandId("   "), false);
  assert.equal(validCommandId("legacy\nkey"), false);
  assert.equal(validCommandId("x".repeat(256)), false);
  assert.equal(validCommandId(["legacy-key"]), false);
});

test("simultaneous follow-ups share one durable successful response and reject changed payloads", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  let calls = 0;
  const execute = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { status: 202, ok: true, json: { accepted: true, turnId: "turn-1" } };
  };
  const args = ["peon-1", "session-1", "018f0000-0000-7000-8000-000000000001", { prompt: "Fix tests" }] as const;
  const [first, duplicate] = await Promise.all([
    runIdempotentFollowup(...args, execute),
    runIdempotentFollowup(...args, execute),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(duplicate, first);

  const afterRestartStyleRetry = await runIdempotentFollowup(...args, execute);
  assert.deepEqual(afterRestartStyleRetry, first);
  assert.equal(calls, 1);

  const conflict = await runIdempotentFollowup(args[0], args[1], args[2], { prompt: "Different" }, execute);
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.json, { error: "request ID was already used with a different payload", code: "IDEMPOTENCY_CONFLICT" });
});

test("different commands for one session execute in arrival order without overlap", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  const events: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const execute = (name: string, delay: number) => async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    events.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    events.push(`${name}:end`);
    active -= 1;
    return { status: 202, ok: true, json: { accepted: name } };
  };

  const first = runIdempotentFollowup("peon-1", "session-1", "command-1", { prompt: "first" }, execute("first", 30));
  const second = runIdempotentFollowup("peon-1", "session-1", "command-2", { prompt: "second" }, execute("second", 1));
  await Promise.all([first, second]);

  assert.equal(maximumActive, 1);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});
