import test from "node:test";
import assert from "node:assert/strict";
import { presenceLocationForPath, reconcileLocalPresence } from "../presence";

test("presence location follows workspace, Peon, and session routes", () => {
  assert.deepEqual(presenceLocationForPath("/"), { scope: "workspace" });
  assert.deepEqual(presenceLocationForPath("/workspaces/ws/members"), { scope: "workspace" });
  assert.deepEqual(presenceLocationForPath("/workspaces/ws/sessions"), { scope: "workspace" });
  assert.deepEqual(presenceLocationForPath("/workspaces/ws/sessions/p%2F1/s%2F1"), {
    scope: "session",
    peonId: "p/1",
    sessionId: "s/1",
  });
  assert.deepEqual(presenceLocationForPath("/peons/p-1"), { scope: "peon", peonId: "p-1" });
  assert.deepEqual(presenceLocationForPath("/peons/p-1/projects/demo"), { scope: "peon", peonId: "p-1" });
  assert.deepEqual(presenceLocationForPath("/peons/p-1/sessions/new"), { scope: "peon", peonId: "p-1" });
  assert.deepEqual(presenceLocationForPath("/peons/p-1/sessions/s%2F1"), {
    scope: "session",
    peonId: "p-1",
    sessionId: "s/1",
  });
});

test("local navigation replaces the socket snapshot's previous self location immediately", () => {
  const self = { userId: "self", email: "operator@example.test", githubLogin: "operator", avatarUrl: null };
  const teammate = { userId: "teammate", email: "teammate@example.test", githubLogin: "teammate", avatarUrl: null };

  assert.deepEqual(
    reconcileLocalPresence([self, teammate], self, false, true),
    [teammate],
    "the previous session must not retain this tab's stale self row",
  );
  assert.deepEqual(
    reconcileLocalPresence([teammate], self, true, true),
    [self, teammate],
    "the newly selected session shows self without waiting for the server round trip",
  );
});

test("acknowledged same-user presence from another tab remains visible", () => {
  const self = { userId: "other-tab", email: "operator@example.test", githubLogin: "operator", avatarUrl: null };
  assert.deepEqual(reconcileLocalPresence([self], self, false), [self]);
});
