import assert from "node:assert/strict";
import test from "node:test";
import { applyProjectEvent, mergeProjects, visibleProjects } from "./projectList";

test("project reducers use stable IDs across renames and reject stale HTTP data", () => {
  const live = [{ peonId: "peon", projectId: "project", key: "renamed", syncedAt: 20, sessionCount: 2 }];
  assert.deepEqual(mergeProjects(live, [
    { peonId: "peon", projectId: "project", key: "old", syncedAt: 10 },
  ]), live);
  assert.deepEqual(applyProjectEvent(live, {
    peonId: "peon", projectId: "project", key: "renamed-again", syncedAt: 30,
  }), [{ peonId: "peon", projectId: "project", key: "renamed-again", syncedAt: 30, sessionCount: 2 }]);
});

test("project tombstones affect only the matching Peon and stable project ID", () => {
  const projects = [
    { peonId: "one", projectId: "same", key: "one", syncedAt: 10 },
    { peonId: "two", projectId: "same", key: "two", syncedAt: 10 },
  ];
  const deleted = applyProjectEvent(projects, {
    peonId: "one", projectId: "same", deleted: true, syncedAt: 11,
  });
  assert.deepEqual(visibleProjects(deleted), [projects[1]]);
  assert.deepEqual(visibleProjects(mergeProjects(deleted, [
    { peonId: "one", projectId: "same", key: "stale", syncedAt: 10 },
  ])), [projects[1]], "a late HTTP response must not resurrect a deleted project");
  assert.deepEqual(applyProjectEvent(projects, {
    peonId: "one", projectId: "same", deleted: true, syncedAt: 9,
  }), projects);
});
