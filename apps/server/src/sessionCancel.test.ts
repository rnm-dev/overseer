import assert from "node:assert/strict";
import test from "node:test";
import { cancelSessionRun } from "./modules/sessionCancel/index.js";

const ok = { status: 200, ok: true, json: { ok: true } };
const notRunning = { status: 409, ok: false, json: { error: "session is not the active running session", code: "SESSION_NOT_RUNNING" } };

test("an accepted cancel is relayed without pulling a snapshot", async () => {
  let snapshots = 0;
  let published = 0;
  const result = await cancelSessionRun({
    cancel: async () => ok,
    snapshot: async () => { snapshots += 1; return ok; },
    publish: async () => { published += 1; return true; },
  });

  assert.deepEqual(result, ok);
  assert.equal(snapshots, 0);
  assert.equal(published, 0);
});

test("a cancel refused as not running republishes the peon's authoritative record", async () => {
  const snapshot = { status: 200, ok: true, json: { id: "session", status: "completed" } };
  const published: unknown[] = [];
  const result = await cancelSessionRun({
    cancel: async () => notRunning,
    snapshot: async () => snapshot,
    publish: async (value) => { published.push(value); return true; },
  });

  // The Peon's answer still reaches the operator; only the stale index is healed.
  assert.deepEqual(result, notRunning);
  assert.deepEqual(published, [snapshot]);
});

test("other cancel failures are relayed untouched", async () => {
  const unreachable = { status: 502, ok: false, json: { error: "peon unreachable", code: "PEON_UNREACHABLE" } };
  let snapshots = 0;
  const result = await cancelSessionRun({
    cancel: async () => unreachable,
    snapshot: async () => { snapshots += 1; return ok; },
    publish: async () => true,
  });

  assert.deepEqual(result, unreachable);
  assert.equal(snapshots, 0);
});

test("a failed heal never changes the answer the peon gave", async () => {
  const result = await cancelSessionRun({
    cancel: async () => notRunning,
    snapshot: async () => { throw new Error("peon unreachable"); },
    publish: async () => true,
  });

  assert.deepEqual(result, notRunning);
});
