import test from "node:test";
import assert from "node:assert/strict";
import {
  TAIL_FALLBACK_SILENCE_MS,
  replaceTranscriptRequest,
  snapshotEndsRun,
  transcriptReconcileMode,
} from "./transcriptReconciliation";

const base = {
  now: 100_000,
  running: true,
  historyReady: true,
  tailUnhealthy: false,
  lastTailActivityAt: 100_000,
  lastReconcileAt: null,
};

test("the healthy-tail status watchdog is bounded to one read per thirty seconds", () => {
  assert.equal(TAIL_FALLBACK_SILENCE_MS, 30_000);
});

test("healthy live tails suppress full transcript polling", () => {
  assert.equal(transcriptReconcileMode(base), "none");
  assert.equal(transcriptReconcileMode({
    ...base,
    now: base.now + TAIL_FALLBACK_SILENCE_MS - 1,
  }), "none");
});

test("a silent live tail checks status without pulling a transcript", () => {
  assert.equal(transcriptReconcileMode({
    ...base,
    now: base.now + TAIL_FALLBACK_SILENCE_MS,
  }), "status");
  assert.equal(transcriptReconcileMode({
    ...base,
    now: base.now + TAIL_FALLBACK_SILENCE_MS + 1,
    lastReconcileAt: base.now + TAIL_FALLBACK_SILENCE_MS,
  }), "none");
});

test("terminal tail failures reconcile immediately but remain rate limited", () => {
  assert.equal(transcriptReconcileMode({ ...base, tailUnhealthy: true }), "transcript");
  assert.equal(transcriptReconcileMode({
    ...base,
    tailUnhealthy: true,
    lastReconcileAt: base.now - 1,
  }), "none");
  assert.equal(transcriptReconcileMode({
    ...base,
    tailUnhealthy: true,
    lastReconcileAt: base.now - TAIL_FALLBACK_SILENCE_MS,
  }), "transcript");
});

test("fallbacks never run before history is ready or after the run finishes", () => {
  assert.equal(transcriptReconcileMode({ ...base, tailUnhealthy: true, historyReady: false }), "none");
  assert.equal(transcriptReconcileMode({ ...base, tailUnhealthy: true, running: false }), "none");
});

test("a replacement transcript request aborts the stale request", () => {
  const stale = new AbortController();
  const replacement = replaceTranscriptRequest(stale);
  assert.equal(stale.signal.aborted, true);
  assert.equal(replacement.signal.aborted, false);
  assert.notEqual(replacement, stale);
});

test("an authoritative page ending in a result ends the run the tail could not", () => {
  // The tail frame carrying this result is deduplicated against history the
  // moment the page is merged, so the page has to end the run itself.
  assert.equal(snapshotEndsRun(true, [
    { type: "user_message", text: "go" },
    { type: "assistant", text: "done" },
    { type: "result", is_error: false },
  ]), true);
});

test("an authoritative page still in a turn keeps the run alive", () => {
  assert.equal(snapshotEndsRun(true, [
    { type: "result", is_error: false },
    { type: "user_message", text: "again" },
    { type: "assistant", text: "working" },
  ]), false);
  assert.equal(snapshotEndsRun(true, []), false);
});

test("a finished page never revives run bookkeeping for an idle session", () => {
  assert.equal(snapshotEndsRun(false, [{ type: "result", is_error: false }]), false);
});
