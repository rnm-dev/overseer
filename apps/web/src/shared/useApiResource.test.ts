import assert from "node:assert/strict";
import test from "node:test";
import { createRequestScope, resourceSettled, resourceStarted } from "./useApiResource";
import { createSingleFlight } from "./useSingleFlight";

test("request scope rejects superseded and cleared tokens", () => {
  const scope = createRequestScope();
  const old = scope.begin();
  const next = scope.begin();
  assert.equal(scope.current(old), false);
  assert.equal(scope.current(next), true);
  scope.clear();
  assert.equal(scope.current(next), false);
});

test("single flight synchronously rejects double submits and stale-scope responses", () => {
  const flight = createSingleFlight();
  const first = flight.begin();
  assert.equal(typeof first, "number");
  assert.equal(flight.begin(), null);
  assert.equal(flight.locked(), true);
  assert.equal(flight.current(first!), true);
  flight.reset();
  assert.equal(flight.current(first!), false);
  const next = flight.begin();
  assert.equal(flight.finish(first!), false);
  assert.equal(flight.current(next!), true);
  assert.equal(flight.finish(next!), true);
  assert.equal(flight.locked(), false);
});

test("resource transitions reset on path change and keep data across reloads", () => {
  const empty = { path: null, data: null, error: null, loading: false };
  const started = resourceStarted<number>(empty, "/a");
  assert.deepEqual(started, { path: "/a", data: null, error: null, loading: true });
  const loaded = resourceSettled(started, { data: 1 });
  assert.deepEqual(loaded, { path: "/a", data: 1, error: null, loading: false });
  assert.deepEqual(resourceStarted(loaded, "/a"), { ...loaded, loading: true });
  const failed = resourceSettled(resourceStarted(loaded, "/a"), { error: "x" });
  assert.deepEqual(failed, { path: "/a", data: 1, error: "x", loading: false });
  assert.deepEqual(resourceStarted(failed, "/b"), { path: "/b", data: null, error: null, loading: true });
  assert.deepEqual(resourceStarted(failed, null), empty);
});
