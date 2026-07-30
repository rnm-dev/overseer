import test from "node:test";
import assert from "node:assert/strict";
import {
  transcriptProjectionNeedsDemand,
  transcriptQuery,
} from "./routes/peons/sessions.js";

test("transcript pagination is forwarded only to capable Peons", () => {
  assert.equal(transcriptQuery({ limit: "200", cursor: "opaque+/=" }, false), "");
  assert.equal(transcriptQuery({ limit: "200", cursor: "opaque+/=" }, true), "?limit=200&cursor=opaque%2B%2F%3D");
  assert.equal(transcriptQuery({ limit: "-1", cursor: ["a", "b"] }, true), "");
});

test("ready retained transcript pages skip temporary reverse demand", () => {
  assert.equal(transcriptProjectionNeedsDemand({
    epoch: "epoch-1",
    status: "ready",
    generation: "generation-1",
  }, "generation-1"), false);
});

test("missing or unusable transcript projections still acquire reverse demand", () => {
  assert.equal(transcriptProjectionNeedsDemand(null, "generation-1"), true);
  assert.equal(transcriptProjectionNeedsDemand({
    epoch: null, status: "syncing", generation: "generation-1",
  }, "generation-1"), true);
  for (const status of ["syncing", "stale", "offline", "gap", "evicted"] as const) {
    assert.equal(transcriptProjectionNeedsDemand({
      epoch: "epoch-1", status, generation: "generation-1",
    }, "generation-1"), true);
  }
  assert.equal(transcriptProjectionNeedsDemand({
    epoch: "epoch-1", status: "ready", generation: "generation-old",
  }, "generation-1"), true);
  assert.equal(transcriptProjectionNeedsDemand({
    epoch: "epoch-1", status: "gap", generation: null,
  }, null), false);
});
