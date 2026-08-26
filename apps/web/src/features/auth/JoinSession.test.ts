import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../shared/api";
import { JoinSessionState, canonicalSessionPath, invitationState, joinSessionStateCopy, sharedState } from "./JoinSession";

test("join flow lands on the existing canonical session route", () => {
  assert.equal(
    canonicalSessionPath({ workspaceId: "workspace/one", peonId: "peon 1", sessionId: "session/9" }),
    "/workspaces/workspace%2Fone/sessions/peon%201/session%2F9",
  );
});

test("join flow maps invitation and participant terminal states to clean accessible copy", () => {
  assert.equal(invitationState(new ApiError(410, "INVITATION_REVOKED", "revoked")), "revoked");
  assert.equal(invitationState(new ApiError(410, "INVITATION_EXPIRED", "expired")), "expired");
  assert.equal(sharedState(new ApiError(429, "PARTICIPANT_LIMIT_EXHAUSTED", "exhausted")), "exhausted");
  assert.equal(sharedState(new ApiError(403, "PARTICIPANT_REVOKED", "revoked")), "revoked");

  const revoked = renderToStaticMarkup(React.createElement(JoinSessionState, { state: "revoked" }));
  assert.match(revoked, /Invitation revoked/u);
  assert.match(revoked, /Existing participants are unaffected/u);
  assert.match(revoked, /Return home/u);
  assert.deepEqual(joinSessionStateCopy("expired"), [
    "Invitation expired",
    "This invitation is no longer accepting new participants.",
  ]);
});
