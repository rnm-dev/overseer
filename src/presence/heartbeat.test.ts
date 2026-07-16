import test from "node:test";
import assert from "node:assert/strict";
import { heartbeatPresence, listHeartbeatPresence, listVisiblePresence, removePresence } from "../presence.js";

test("HTTP presence heartbeat moves a connection atomically and clears it", () => {
  const base = {
    connectionId: "heartbeat-test-connection",
    workspaceId: "heartbeat-test-workspace",
    userId: "heartbeat-test-user",
    email: "heartbeat@example.test",
    githubLogin: "heartbeat",
    avatarUrl: null,
    projectKey: null,
    projectId: null,
  };
  heartbeatPresence({ ...base, scope: "peon", peonId: "p1", sessionId: null });
  assert.deepEqual(listHeartbeatPresence(base.workspaceId).map((entry) => [entry.scope, entry.peonId, entry.sessionId]), [["peon", "p1", null]]);

  heartbeatPresence({ ...base, scope: "session", peonId: "p1", sessionId: "s2" });
  assert.deepEqual(listHeartbeatPresence(base.workspaceId).map((entry) => [entry.scope, entry.peonId, entry.sessionId]), [["session", "p1", "s2"]]);

  removePresence(base.workspaceId, base.userId, base.connectionId);
  assert.deepEqual(listHeartbeatPresence(base.workspaceId), []);
});

test("HTTP heartbeat response returns every visible route and filters inaccessible projects", async () => {
  const workspaceId = "heartbeat-visible-workspace";
  const identity = {
    workspaceId,
    userId: "viewer",
    email: "viewer@example.test",
    githubLogin: "viewer",
    avatarUrl: null,
  };
  heartbeatPresence({ ...identity, connectionId: "desktop", scope: "session", peonId: "p1", sessionId: "s1", projectKey: "visible", projectId: "project-visible" });
  heartbeatPresence({ ...identity, connectionId: "phone", scope: "session", peonId: "p1", sessionId: "s2", projectKey: "visible", projectId: "project-visible" });
  heartbeatPresence({ ...identity, connectionId: "hidden", scope: "session", peonId: "p1", sessionId: "s3", projectKey: "hidden", projectId: "project-hidden" });

  const presence = await listVisiblePresence(workspaceId, () => true, (_peonId, _projectKey, projectId) => projectId === "project-visible");
  assert.deepEqual(presence.map((entry) => entry.sessionId).sort(), ["s1", "s2"]);

  for (const connectionId of ["desktop", "phone", "hidden"]) removePresence(workspaceId, identity.userId, connectionId);
});
