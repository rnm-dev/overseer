import assert from "node:assert/strict";
import test from "node:test";
import {
  createTranscriptVirtualWindow,
  updateTranscriptVirtualWindow,
} from "./transcriptVirtualization";

const rows = (...keys: string[]) => keys.map((key) => ({ key }));

test("prepending rows decreases Virtuoso firstItemIndex by the exact delta", () => {
  const initial = createTranscriptVirtualWindow("session-a", rows("3", "4", "footer"));
  const prepended = updateTranscriptVirtualWindow(initial, "session-a", rows("1", "2", "3", "4", "footer"));
  assert.equal(prepended.firstItemIndex, initial.firstItemIndex - 2);
});

test("append and in-place row updates do not move the virtual origin", () => {
  const initial = createTranscriptVirtualWindow("session-a", rows("1", "footer"));
  const appended = updateTranscriptVirtualWindow(initial, "session-a", rows("1", "2", "footer"));
  assert.equal(appended.firstItemIndex, initial.firstItemIndex);
});

test("the earliest surviving row anchors a page-boundary merge", () => {
  const initial = createTranscriptVirtualWindow("session-a", rows("merged-result", "next", "footer"));
  const prepended = updateTranscriptVirtualWindow(initial, "session-a", rows("older", "tool-call", "next", "footer"));
  assert.equal(prepended.firstItemIndex, initial.firstItemIndex - 1);
});

test("switching sessions resets the virtual origin", () => {
  const initial = createTranscriptVirtualWindow("session-a", rows("1", "footer"));
  const prepended = updateTranscriptVirtualWindow(initial, "session-a", rows("0", "1", "footer"));
  const switched = updateTranscriptVirtualWindow(prepended, "session-b", rows("x", "footer"));
  assert.equal(switched.firstItemIndex, createTranscriptVirtualWindow("session-b", []).firstItemIndex);
});
