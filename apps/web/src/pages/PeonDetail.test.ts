import assert from "node:assert/strict";
import test from "node:test";
import { PEON_NAV_ITEMS } from "./PeonDetail";

test("AI Stats is part of the navigation for every workspace member", () => {
  assert.deepEqual(PEON_NAV_ITEMS.map(({ to, key }) => ({ to, key })), [
    { to: "sessions", key: "peon.tab.work" },
    { to: "stats", key: "peon.tab.stats" },
  ]);
});
