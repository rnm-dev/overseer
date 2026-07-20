import assert from "node:assert/strict";
import test from "node:test";
import { displayUsername, peonHref, presenceUsersForPeon, workspaceHref, workspaceListClass } from "./Dashboard";

test("dashboard displays the current GitHub username", () => {
  assert.equal(displayUsername({ email: "serik@example.com", githubLogin: "serik-dev" }), "serik-dev");
});

test("dashboard falls back to the email username when GitHub login is unavailable", () => {
  assert.equal(displayUsername({ email: "serik@example.com", githubLogin: null }), "serik");
  assert.equal(displayUsername(null), "");
});

test("home workspace cards open the workspace dashboard", () => {
  assert.equal(workspaceHref("workspace/id"), "/workspaces/workspace%2Fid");
});

test("home Peon rows open the Peon directly", () => {
  assert.equal(peonHref("peon/id"), "/peons/peon%2Fid");
});

test("a single workspace is centered instead of occupying a two-column grid", () => {
  assert.match(workspaceListClass(1), /mx-auto/);
  assert.doesNotMatch(workspaceListClass(1), /grid-cols-2/);
  assert.match(workspaceListClass(2), /grid-cols-2/);
});

test("home Peon rows receive unique scoped presence viewers", () => {
  const viewers = presenceUsersForPeon([
    { userId: "one", email: "ONE@example.com", githubLogin: "one", avatarUrl: null, scope: "peon", peonId: "p1", sessionId: null },
    { userId: "one-session", email: "one@example.com", githubLogin: "one", avatarUrl: null, scope: "session", peonId: "p1", sessionId: "s1" },
    { userId: "two", email: "two@example.com", githubLogin: "two", avatarUrl: null, scope: "peon", peonId: "p2", sessionId: null },
  ], "p1");

  assert.deepEqual(viewers.map((viewer) => viewer.userId), ["one"]);
});
