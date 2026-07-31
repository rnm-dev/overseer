import assert from "node:assert/strict";
import test from "node:test";
import { applyProjectEvent, dedupeProjectsByKey, mergeProjects, visibleProjects, withLiveActiveSessionCounts } from "./projectList";

test("a nameless row from a dead project never displaces the registered project sharing its key", () => {
  const registered = { peonId: "peon", projectId: "live", key: "overseer", name: "Overseer", dir: "/p/overseer", syncedAt: 20 };
  const ghost = { peonId: "peon", projectId: "dead", key: "overseer", path: "/p/peon", sessionCount: 43 };
  assert.deepEqual(dedupeProjectsByKey([registered, ghost]), [registered]);
  assert.deepEqual(dedupeProjectsByKey([ghost, registered]), [registered], "order of arrival must not decide");
  assert.deepEqual(visibleProjects([ghost, registered]), [registered]);
  assert.deepEqual(dedupeProjectsByKey([ghost]), [ghost], "a key with no registered row still has to be reachable");
});

test("project reducers use stable IDs across renames and reject stale HTTP data", () => {
  const live = [{ peonId: "peon", projectId: "project", key: "renamed", syncedAt: 20, sessionCount: 2 }];
  assert.deepEqual(mergeProjects(live, [
    { peonId: "peon", projectId: "project", key: "old", syncedAt: 10 },
  ]), live);
  assert.deepEqual(applyProjectEvent(live, {
    peonId: "peon", projectId: "project", key: "renamed-again", syncedAt: 30,
  }), [{ peonId: "peon", projectId: "project", key: "renamed-again", syncedAt: 30, sessionCount: 2, deleted: false }]);
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

test("live running sessions drive project active counts without waiting for project rollups", () => {
  const projects = [
    { key: "overseer", activeCount: 0 },
    { key: "website", activeCount: 4 },
  ];
  assert.deepEqual(withLiveActiveSessionCounts(projects, [
    { projectKey: "overseer", status: "running" },
    { projectKey: "overseer", status: "running" },
    { projectKey: "overseer", status: "completed" },
    { projectKey: "website", status: "completed" },
  ]), [
    { key: "overseer", activeCount: 2, unreadCount: 0, lastActivityMs: null },
    { key: "website", activeCount: 0, unreadCount: 0, lastActivityMs: null },
  ]);
});

test("unread sessions roll up per project regardless of whether they are still running", () => {
  assert.deepEqual(withLiveActiveSessionCounts(
    [{ key: "overseer" }, { key: "website" }],
    [
      { projectKey: "overseer", status: "needs_human", attentionUnread: true },
      { projectKey: "overseer", status: "running", attentionUnread: true },
      { projectKey: "overseer", status: "completed", attentionUnread: false },
      { projectKey: "website", status: "completed" },
    ],
  ), [
    { key: "overseer", activeCount: 1, unreadCount: 2, lastActivityMs: null },
    { key: "website", activeCount: 0, unreadCount: 0, lastActivityMs: null },
  ]);
});

test("projects inherit the newest activity among their sessions, whatever the status", () => {
  assert.deepEqual(withLiveActiveSessionCounts(
    [{ key: "overseer" }, { key: "website", lastActivityMs: 5 }, { key: "quiet", lastActivityMs: 7 }],
    [
      { projectKey: "overseer", status: "running", lastActivityAt: 20 },
      { projectKey: "overseer", status: "completed", lastActivityAt: 40 },
      { projectKey: "website", status: "completed", lastActivityAt: 30 },
      { projectKey: null, status: "running", lastActivityAt: 90 },
    ],
  ), [
    { key: "overseer", activeCount: 1, unreadCount: 0, lastActivityMs: 40 },
    { key: "website", activeCount: 0, unreadCount: 0, lastActivityMs: 30 },
    { key: "quiet", activeCount: 0, unreadCount: 0, lastActivityMs: 7 },
  ]);
});
