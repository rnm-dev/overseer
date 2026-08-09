import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../shared/api";
import {
  composerGhostVisible,
  FollowupRequestIdentity,
  followupWasRefused,
  shouldRestoreFollowupDraft,
  type ComposerGhost,
} from "./useSessionComposer";

test("only an explicit non-5xx follow-up refusal may restore the visible draft", () => {
  assert.equal(followupWasRefused(new ApiError(400, "BAD_REQUEST", "bad request")), true);
  assert.equal(followupWasRefused(new ApiError(409, "RESUME_IN_PROGRESS", "busy")), true);
  assert.equal(followupWasRefused(new ApiError(500, "INTERNAL", "failed")), false);
  assert.equal(followupWasRefused(new TypeError("Failed to fetch")), false);
});

test("pre-follow-up failures restore the draft while ambiguous sends do not", () => {
  const networkFailure = new TypeError("Failed to fetch");
  assert.equal(shouldRestoreFollowupDraft(false, networkFailure), true);
  assert.equal(shouldRestoreFollowupDraft(true, networkFailure), false);
  assert.equal(
    shouldRestoreFollowupDraft(true, new ApiError(422, "INVALID", "refused")),
    true,
  );
});

test("ghost convergence is count-based, bounded, and independent of HTTP completion", () => {
  const now = Date.now();
  const ghost: ComposerGhost = {
    text: "web operator",
    attachments: [],
    createdAt: now,
    baselineUserMessages: 4,
  };

  assert.equal(composerGhostVisible(ghost, 4), true, "delayed publication keeps the placeholder");
  assert.equal(composerGhostVisible(ghost, 5), false, "any authoritative user row retires it");
  assert.equal(
    composerGhostVisible({ ...ghost, createdAt: now - 60_001 }, 4),
    false,
    "a missing publication cannot leave an unbounded placeholder",
  );
});

test("concurrent operators may retire a ghost early without manufacturing or matching a row", () => {
  const baseline = 7;
  const webGhost: ComposerGhost = {
    text: "from web",
    attachments: [],
    createdAt: Date.now(),
    baselineUserMessages: baseline,
  };

  assert.equal(composerGhostVisible(webGhost, baseline), true);
  assert.equal(
    composerGhostVisible(webGhost, baseline + 1),
    false,
    "Flutter's authoritative row may retire the web ghost before web's row arrives",
  );
  assert.equal(composerGhostVisible(webGhost, baseline + 2), false);
});

test("retry identity survives ambiguous outcomes and changes after refusal or payload change", () => {
  let sequence = 0;
  const ids = new FollowupRequestIdentity(() => `request-${++sequence}`);

  const first = ids.forPayload("same-payload");
  assert.equal(ids.forPayload("same-payload"), first, "lost 2xx/5xx retries are idempotent");
  assert.notEqual(ids.forPayload("changed-payload"), first);

  const refused = ids.forPayload("refused-payload");
  ids.clear();
  assert.notEqual(ids.forPayload("refused-payload"), refused, "a stated 4xx gets a fresh identity");
});
