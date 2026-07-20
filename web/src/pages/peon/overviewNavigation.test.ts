import assert from "node:assert/strict";
import test from "node:test";
import {
  peonOverviewNewSessionPath,
  peonOverviewProjectsPath,
  peonOverviewSessionsPath,
} from "./overviewNavigation";

test("Peon overview links target sibling session and project routes", () => {
  assert.equal(peonOverviewSessionsPath("peon/a", "session/one"), "/peons/peon%2Fa/sessions/session%2Fone");
  assert.equal(peonOverviewNewSessionPath("peon/a"), "/peons/peon%2Fa/sessions/new");
  assert.equal(peonOverviewProjectsPath("peon/a"), "/peons/peon%2Fa/projects");
  assert.equal(peonOverviewProjectsPath("peon/a", "local/project"), "/peons/peon%2Fa/projects/local%2Fproject");
});
