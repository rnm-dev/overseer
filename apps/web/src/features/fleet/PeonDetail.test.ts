import assert from "node:assert/strict";
import test from "node:test";
import { PEON_NAV_ITEMS, sessionListRequestPath } from "./PeonDetail";

test("AI Stats is part of the navigation for every workspace member", () => {
  assert.deepEqual(PEON_NAV_ITEMS.map(({ to, key }) => ({ to, key })), [
    { to: "sessions", key: "peon.tab.work" },
    { to: "stats", key: "peon.tab.stats" },
  ]);
});

test("grouped session lists request one bounded project snapshot while Recent remains paginated", () => {
  assert.equal(
    sessionListRequestPath("workspace", "peon/id", "grouped", 7, 50),
    "/workspaces/workspace/sessions?peonId=peon%2Fid&perProjectLimit=7",
  );
  assert.equal(
    sessionListRequestPath("workspace", "peon/id", "flat", 7, 50),
    "/workspaces/workspace/sessions?peonId=peon%2Fid&limit=50&offset=50",
  );
});
