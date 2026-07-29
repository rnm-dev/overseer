import assert from "node:assert/strict";
import test from "node:test";
import {
  displayUsername,
  HOME_PEON_LINK_CLASS,
  HOME_PEON_LIST_CLASS,
  HOME_WORKSPACE_CARD_CLASS,
  HOME_WORKSPACE_HEADER_CLASS,
  HOME_WORKSPACE_TITLE_CLASS,
  peonHref,
  presenceUsersForPeon,
  userBoxLayoutClass,
  workspaceHref,
  workspaceListClass,
} from "./Dashboard";
import {
  HOME_USER_CARD_CLASS,
  HOME_USER_ITEM_CLASS,
  HOME_USER_ITEMS_CLASS,
  HOME_USER_LABEL_CLASS,
  HOME_USER_SELECT_CLASS,
  HOME_USER_SIGN_OUT_CLASS,
  HOME_USER_TITLE_CLASS,
  HOME_USER_VALUE_CLASS,
} from "../components/UserBox";

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

test("the in-flow user card occupies the same column width as a workspace card", () => {
  assert.match(userBoxLayoutClass(1), /max-w-2xl/);
  assert.match(userBoxLayoutClass(2), /sm:grid-cols-2/);
  assert.match(userBoxLayoutClass(2), /\bmt-4\b/);
  assert.doesNotMatch(HOME_USER_CARD_CLASS, /\b(?:fixed|sticky|w-64)\b/);
  assert.match(HOME_USER_CARD_CLASS, /\bw-full\b/);
});

test("the user card shares the workspace visual system", () => {
  assert.match(HOME_USER_CARD_CLASS, /\bsurface\b/);
  assert.doesNotMatch(HOME_USER_CARD_CLASS, /\bbg-transparent\b/);
  assert.match(HOME_USER_TITLE_CLASS, /text-lg/);
  assert.match(HOME_USER_TITLE_CLASS, /px-5/);
  assert.match(HOME_USER_TITLE_CLASS, /py-5/);
  assert.match(HOME_USER_ITEMS_CLASS, /space-y-3/);
  assert.match(HOME_USER_ITEM_CLASS, /\bon-surface\b/);
  assert.doesNotMatch(HOME_USER_ITEM_CLASS, /\bborder(?:-|$)/);
  assert.match(HOME_USER_LABEL_CLASS, /font-display/);
  assert.match(HOME_USER_LABEL_CLASS, /text-sm/);
  assert.match(HOME_USER_LABEL_CLASS, /font-semibold/);
  assert.match(HOME_USER_VALUE_CLASS, /font-mono/);
  assert.match(HOME_USER_VALUE_CLASS, /text-xs/);
  assert.ok(HOME_USER_SELECT_CLASS.includes(HOME_USER_VALUE_CLASS));
  assert.match(HOME_USER_SELECT_CLASS, /bg-transparent/);
  assert.match(HOME_USER_SIGN_OUT_CLASS, /hover:bg-blood/);
  assert.match(HOME_USER_SIGN_OUT_CLASS, /focus-visible:ring-blood/);
});

test("home workspaces use the canonical app surface with unfilled headers", () => {
  assert.match(HOME_WORKSPACE_CARD_CLASS, /\bsurface\b/);
  assert.doesNotMatch(HOME_WORKSPACE_CARD_CLASS, /\bbg-transparent\b/);
  assert.doesNotMatch(HOME_WORKSPACE_HEADER_CLASS, /\bbg-/);
});

test("home workspace names use a clean solid-color typographic treatment", () => {
  assert.match(HOME_WORKSPACE_TITLE_CLASS, /text-fel-bright/);
  assert.match(HOME_WORKSPACE_TITLE_CLASS, /text-lg/);
  assert.doesNotMatch(HOME_WORKSPACE_TITLE_CLASS, /gradient/);
  assert.doesNotMatch(HOME_WORKSPACE_TITLE_CLASS, /text-transparent/);
  assert.match(HOME_WORKSPACE_TITLE_CLASS, /drop-shadow/);
});

test("home Peons are spaced borderless boxes with a translucent background", () => {
  assert.match(HOME_PEON_LIST_CLASS, /\bspace-y-/);
  assert.match(HOME_PEON_LIST_CLASS, /\bpx-/);
  assert.match(HOME_PEON_LIST_CLASS, /\bpb-/);
  assert.match(HOME_PEON_LINK_CLASS, /\bon-surface\b/);
  assert.match(HOME_PEON_LINK_CLASS, /\bon-surface--interactive\b/);
  assert.doesNotMatch(HOME_PEON_LINK_CLASS, /\bborder(?:-|$)/);
});

test("home Peon rows receive unique scoped presence viewers", () => {
  const viewers = presenceUsersForPeon([
    { userId: "one", email: "ONE@example.com", githubLogin: "one", avatarUrl: null, scope: "peon", peonId: "p1", sessionId: null },
    { userId: "one-session", email: "one@example.com", githubLogin: "one", avatarUrl: null, scope: "session", peonId: "p1", sessionId: "s1" },
    { userId: "two", email: "two@example.com", githubLogin: "two", avatarUrl: null, scope: "peon", peonId: "p2", sessionId: null },
  ], "p1");

  assert.deepEqual(viewers.map((viewer) => viewer.userId), ["one"]);
});
