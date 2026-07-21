import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPeonProjection, mergePeonInventory, parsePeonProjections } from "./workspacePeons";

test("Peon projections update online state immediately without disturbing other workspaces", () => {
  const original = {
    one: [{ peonId: "p1", name: "One", online: false }],
    two: [{ peonId: "p2", name: "Two", online: true }],
  };
  const updated = applyPeonProjection(original, "one", { peonId: "p1", online: true });
  assert.equal(updated.one[0].online, true);
  assert.equal(updated.one[0].name, "One");
  assert.equal(updated.two, original.two);
});

test("a live projection can populate a Peon before the polling fallback runs", () => {
  const updated = applyPeonProjection({}, "one", { peonId: "p1", name: "One", online: true });
  assert.deepEqual(updated.one, [{ peonId: "p1", name: "One", online: true }]);
});

test("socket snapshots accept only typed Peon presence entries", () => {
  assert.deepEqual(parsePeonProjections([
    { peonId: "p1", name: "One", online: true },
    { peonId: "p2", online: "yes" },
  ]), [{ peonId: "p1", name: "One", online: true }]);
});

test("HTTP inventory cannot change socket-owned online state", () => {
  assert.deepEqual(
    mergePeonInventory(
      [{ peonId: "p1", name: "Old", online: true }],
      [{ peonId: "p1", name: "Renamed", online: false }, { peonId: "p2", name: "New", online: true }],
    ),
    [{ peonId: "p1", name: "Renamed", online: true }, { peonId: "p2", name: "New", online: false }],
  );
});
