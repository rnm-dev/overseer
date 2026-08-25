import assert from "node:assert/strict";
import test from "node:test";
import { inviteForLogin, loginPathForInvite, providerStartBody } from "./inviteFlow.js";

test("invite survives the join-to-login navigation without relying on storage", () => {
  assert.equal(loginPathForInvite("a/b+c"), "/login?invite=a%2Fb%2Bc");
  assert.equal(inviteForLogin("?invite=a%2Fb%2Bc", null), "a/b+c");
  assert.equal(inviteForLogin("", "stored-token"), "stored-token");
});

test("redirect sign-in starts with the invitation capability", () => {
  assert.deepEqual(providerStartBody(null, "invite-token"), { invite: "invite-token" });
  assert.deepEqual(providerStartBody("overseer://callback", "invite-token"), {
    callback: "overseer://callback",
    invite: "invite-token",
  });
});
