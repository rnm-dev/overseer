import assert from "node:assert/strict";
import { test } from "node:test";
import type { PeonGroup } from "../workspace";
import { selectPeon, selectWorkspacePeons } from "./usePeonPresence";

const groups: PeonGroup[] = [
  {
    workspace: { id: "one", name: "One", slug: "one", role: "owner", createdAt: 1 },
    peons: [{ peonId: "p1", name: "First", online: true }],
  },
  {
    workspace: { id: "two", name: "Two", slug: "two", role: "member", createdAt: 2 },
    peons: [{ peonId: "p2", name: "Second", online: false }],
  },
];

test("selectPeon scopes duplicate-safe presence lookup to a workspace", () => {
  assert.equal(selectPeon(groups, "p2", "one"), null);
  assert.deepEqual(selectPeon(groups, "p2", "two"), groups[1].peons[0]);
});

test("selectPeon can locate a Peon when the workspace is not known yet", () => {
  assert.deepEqual(selectPeon(groups, "p1"), groups[0].peons[0]);
  assert.equal(selectPeon(groups, undefined), null);
});

test("selectWorkspacePeons returns the shared live projection or an empty list", () => {
  assert.equal(selectWorkspacePeons(groups, "one"), groups[0].peons);
  assert.deepEqual(selectWorkspacePeons(groups, "missing"), []);
});
