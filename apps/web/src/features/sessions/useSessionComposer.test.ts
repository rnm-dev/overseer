import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../shared/api";
import {
  composerGhostVisible,
  freshSubmittedSelection,
  FollowupRequestIdentity,
  followupWasRefused,
  shouldRestoreFollowupDraft,
  type ComposerGhost,
} from "./useSessionComposer";
import { selectionAfterAcceptance } from "./drafts";

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

test("an accepted earlier request cannot clear another session's retry identity", () => {
  let sequence = 0;
  const ids = new FollowupRequestIdentity(() => `request-${++sequence}`);
  const firstSession = ids.forPayload("queue:A/model-a/high");
  const secondSession = ids.forPayload("queue:B/model-b/low");

  ids.clear(firstSession);
  assert.equal(ids.forPayload("queue:B/model-b/low"), secondSession);
  assert.notEqual(ids.forPayload("queue:A/model-a/high"), firstSession);
});

test("a retry retains its first body selection when the catalog later rejects it", () => {
  let sequence = 0;
  const ids = new FollowupRequestIdentity(() => `request-${++sequence}`);
  const identity = "queue:A/same-message/model-a/high";
  const withHigh = {
    agent: "codex",
    label: "Codex",
    models: [{ id: "model-a", label: "Model A", reasoningEfforts: [{ id: "high", label: "High" }] }],
    reasoningEfforts: [],
  };
  const withoutHigh = { ...withHigh, models: [{ id: "model-a", label: "Model A", reasoningEfforts: [] }] };
  const chosen = { model: "model-a", reasoningEffort: "high" };

  const first = ids.selectionFor(identity, freshSubmittedSelection(withHigh, "model-a", chosen));
  const retry = ids.selectionFor(identity, freshSubmittedSelection(withoutHigh, "model-a", chosen));
  assert.deepEqual(first, { id: "request-1", selection: chosen });
  assert.deepEqual(retry, first, "the retry repeats the accepted-or-ambiguous wire body exactly");
});

test("a fresh known-invalid effort is omitted, while a missing catalog preserves it", () => {
  const provider = {
    agent: "codex",
    label: "Codex",
    models: [{ id: "model-a", label: "Model A", reasoningEfforts: [] }],
    reasoningEfforts: [{ id: "high", label: "High" }],
  };
  const chosen = { model: "model-a", reasoningEffort: "high" };
  assert.deepEqual(freshSubmittedSelection(provider, "model-a", chosen), { model: "model-a", reasoningEffort: "" });
  assert.deepEqual(freshSubmittedSelection(null, "model-a", chosen), chosen);
});

test("acceptance consumes the original draft selection, not its normalized wire effort", () => {
  const draft = { model: "model-a", reasoningEffort: "high" };
  const provider = {
    agent: "codex",
    label: "Codex",
    models: [{ id: "model-a", label: "Model A", reasoningEfforts: [] }],
    reasoningEfforts: [],
  };
  const wire = freshSubmittedSelection(provider, "model-a", draft);
  assert.deepEqual(wire, { model: "model-a", reasoningEffort: "" });
  const composerDraft = { agent: "", ...draft };
  assert.deepEqual(selectionAfterAcceptance(composerDraft, composerDraft), { agent: "", model: "", reasoningEffort: "" });
});

test("route switches leave unresolved retry snapshots addressable by their scoped identity", () => {
  let sequence = 0;
  const ids = new FollowupRequestIdentity(() => `request-${++sequence}`);
  const a = ids.selectionFor("queue:session-a", { model: "model-a", reasoningEffort: "high" });
  ids.selectionFor("queue:session-b", { model: "model-b", reasoningEffort: "low" });

  assert.deepEqual(ids.selectionFor("queue:session-a", { model: "model-a", reasoningEffort: "" }), a);
});

test("accepted selection snapshots leave an in-flight newer picker edit alone", () => {
  const accepted = { agent: "", model: "model-a", reasoningEffort: "high" };
  assert.deepEqual(
    selectionAfterAcceptance({ agent: "", model: "model-b", reasoningEffort: "high" }, accepted),
    { agent: "", model: "model-b", reasoningEffort: "high" },
  );
  assert.deepEqual(
    selectionAfterAcceptance(accepted, accepted),
    { agent: "", model: "", reasoningEffort: "" },
  );
});
