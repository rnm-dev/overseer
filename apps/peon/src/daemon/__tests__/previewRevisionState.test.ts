import assert from "node:assert/strict";
import test from "node:test";
import { PreviewRevisionState } from "../overseer/socket/previewRevisionState.js";

test("shares equivalent watches and releases the watcher with its final lease", () => {
  const state = new PreviewRevisionState();
  assert.deepEqual(state.add({ leaseId: "one", key: "session/a.html", expiresAt: 100 }), { shared: false });
  assert.deepEqual(state.add({ leaseId: "two", key: "session/a.html", expiresAt: 200 }), { shared: true });
  assert.deepEqual(state.remove("one"), { removed: true, watchReleased: false });
  assert.deepEqual(state.remove("two"), { removed: true, watchReleased: true });
  assert.deepEqual(state.snapshot(), []);
});

test("renewal and expiry retain live leases and report released watchers", () => {
  const state = new PreviewRevisionState();
  state.add({ leaseId: "one", key: "a", expiresAt: 10 });
  state.add({ leaseId: "two", key: "a", expiresAt: 20 });
  state.add({ leaseId: "three", key: "b", expiresAt: 10 });
  assert.equal(state.renew("one", 30), true);
  assert.deepEqual(state.expire(10), ["b"]);
  assert.deepEqual(state.snapshot().map(({ key, leases }) => [key, leases.map((lease) => lease.leaseId)]), [
    ["a", ["one", "two"]],
  ]);
});

test("only the newest completed revision can activate", () => {
  const state = new PreviewRevisionState();
  state.add({ leaseId: "one", key: "a", expiresAt: 100 });
  const stale = state.begin("a");
  const newest = state.begin("a");
  assert.equal(state.activate(stale), false);
  assert.equal(state.activate(newest), true);
  assert.equal(state.activate(newest), false);
  assert.equal(state.snapshot()[0]?.activatedRevision, 2);
});

test("enforces logical watcher and lease limits without partial admission", () => {
  const watches = new PreviewRevisionState(1, 3);
  watches.add({ leaseId: "one", key: "a", expiresAt: 10 });
  assert.throws(() => watches.add({ leaseId: "two", key: "b", expiresAt: 10 }), /WATCH_LIMIT/);
  assert.deepEqual(watches.snapshot().map(({ key }) => key), ["a"]);

  const leases = new PreviewRevisionState(2, 1);
  leases.add({ leaseId: "one", key: "a", expiresAt: 10 });
  assert.throws(() => leases.add({ leaseId: "two", key: "a", expiresAt: 10 }), /LEASE_LIMIT/);
  assert.equal(leases.snapshot()[0]?.leases.length, 1);
});

test("clear fences all outstanding completions", () => {
  const state = new PreviewRevisionState();
  state.add({ leaseId: "one", key: "a", expiresAt: 100 });
  const pending = state.begin("a");
  assert.deepEqual(state.clear(), ["a"]);
  assert.equal(state.activate(pending), false);
});
