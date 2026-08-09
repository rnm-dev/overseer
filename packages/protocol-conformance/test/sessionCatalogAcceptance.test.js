import assert from "node:assert/strict";
import test from "node:test";
import { loadFixture, SessionCatalogHarness, SessionCatalogHarnessError } from "../src/index.js";

const model = loadFixture("session-catalog-acceptance-v1.json");
const page = (requestId, sessions = [{ id: "s1", status: "running" }], epoch = "catalog-1", barrierSeq = 1) => ({
  type: "session_catalog_snapshot_page", requestId, epoch, revision: barrierSeq, barrierSeq, sessions, nextCursor: null, hasMore: false,
});
const event = (overrides = {}) => ({ epoch: "delivery-1", cursor: "2", messageId: "message-2", payload: {
  type: "session_catalog_event", catalogEpoch: "catalog-1", seq: 2, revision: 2, operation: "upsert",
  session: { id: "s1", status: "completed" }, ...overrides,
} });

test("session catalog acceptance catalog names every convergence boundary and objective SLO", () => {
  assert.equal(model.version, "session-catalog-convergence-acceptance-v1");
  assert.deepEqual(model.authority, { canonicalStore: "peon", readPath: "fleet-http", liveProjection: "session-catalog-v1" });
  assert.equal(new Set(model.invariants.map(({ id }) => id)).size, 11);
  assert.ok(model.invariants.every(({ status, coverage }) => status === "covered" && coverage.length));
  assert.deepEqual(model.slos.map(({ id }) => id), ["SCS-HEALTHY", "SCS-RECONNECT", "SCS-RESTART", "SCS-REBUILD", "SCS-CLIENT-RESUME"]);
  assert.ok(model.slos.every(({ start, stop, targetMs, percentile }) => start && stop && targetMs > 0 && percentile === 99));
  assert.ok(model.slos.filter(({ status }) => status === "measured").every(({ collector }) => collector?.startsWith("server:sessionCatalogObservability.")));
  const sensitive = /(prompt|preview|title|transcript|payload|credential|path|body|content)/i;
  assert.ok(model.diagnostics.allowedDimensions.every((name) => !sensitive.test(name)));
});

test("snapshot/live races, duplicate replay, ACK loss, and both-side restart converge once", () => {
  for (const side of ["peon", "overseer"]) {
    const harness = new SessionCatalogHarness();
    const request = harness.beginSnapshot();
    assert.equal(harness.receivePage(page(request.requestId)), true);
    const message = event();
    assert.equal(harness.commit(message, harness.transport.generation, { crashAfterCommit: true }), true);
    assert.equal(harness.state().acked, 0);
    assert.equal(harness.commit(message), true);
    harness.restart(side);
    assert.equal(harness.commit(message), true);
    assert.deepEqual(harness.projection.get("s1"), { id: "s1", status: "completed" });
    assert.equal(harness.state().effects, 1);
  }
});

test("gaps, epochs, stale generations, corrupt pages, bounds, and tombstones fail closed or recover", () => {
  const harness = new SessionCatalogHarness({ maxItems: 1 });
  const request = harness.beginSnapshot();
  assert.equal(harness.receivePage(page(request.requestId)), true);
  const generation = harness.transport.generation;
  harness.restart("overseer");
  assert.equal(harness.commit(event(), generation), false);
  assert.throws(() => harness.commit(event({ seq: 4, revision: 4 })), (error) => error.code === "CATALOG_GAP");
  const rebuilt = harness.beginSnapshot("rebuilt");
  assert.equal(harness.receivePage(page(rebuilt.requestId, [{ id: "s1", status: "completed" }], "catalog-1", 3)), true);
  assert.throws(() => harness.commit(event({ catalogEpoch: "catalog-2", seq: 4, revision: 4 })), (error) => error.code === "EPOCH_MISMATCH");

  const bounded = new SessionCatalogHarness({ maxItems: 1 });
  const boundedRequest = bounded.beginSnapshot();
  assert.throws(() => bounded.receivePage(page(boundedRequest.requestId, [{ id: "a" }, { id: "b" }])), (error) => error.code === "SNAPSHOT_TOO_LARGE");
  const corrupt = new SessionCatalogHarness();
  const corruptRequest = corrupt.beginSnapshot();
  assert.throws(() => corrupt.receivePage({ ...page(corruptRequest.requestId), revision: 2 }), SessionCatalogHarnessError);

  const deleted = new SessionCatalogHarness();
  const deleteRequest = deleted.beginSnapshot();
  deleted.receivePage(page(deleteRequest.requestId));
  deleted.commit(event({ operation: "delete", session: undefined, sessionId: "s1" }));
  assert.equal(deleted.projection.has("s1"), false);
});

test("crash before commit never acknowledges or mutates", () => {
  const harness = new SessionCatalogHarness();
  const request = harness.beginSnapshot();
  harness.receivePage(page(request.requestId));
  assert.equal(harness.commit(event(), harness.transport.generation, { crashBeforeCommit: true }), false);
  assert.deepEqual(harness.state(), { freshness: "fresh", epoch: "catalog-1", seq: 1, sessions: 1, inbox: 0, effects: 0, acked: 0 });
});

test("snapshot-covered delivery must match the committed projection", () => {
  const harness = new SessionCatalogHarness();
  const request = harness.beginSnapshot();
  harness.receivePage(page(request.requestId, [{ id: "s1", status: "completed" }], "catalog-1", 2));
  assert.equal(harness.commit(event()), true);
  const malformed = new SessionCatalogHarness();
  malformed.beginSnapshot("bad");
  assert.throws(() => malformed.receivePage({ ...page("bad"), sessions: null }), (error) => error.code === "CORRUPT_SNAPSHOT");
  const changed = event({ session: { id: "s1", status: "running" } });
  changed.messageId = "changed";
  assert.throws(() => harness.commit(changed), (error) => error.code === "REPLAY_MISMATCH");
});
