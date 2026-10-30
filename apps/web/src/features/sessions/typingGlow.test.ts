import assert from "node:assert/strict";
import test from "node:test";
import { diffText, glowSegments, shiftGlowRanges } from "./typingGlow";

test("diffText finds a typed character, a deletion and a replacement", () => {
  assert.deepEqual(diffText("helo", "hello"), { start: 3, removed: 0, inserted: 1 });
  assert.deepEqual(diffText("hello", "helo"), { start: 3, removed: 1, inserted: 0 });
  assert.deepEqual(diffText("cat", "cut"), { start: 1, removed: 1, inserted: 1 });
  assert.deepEqual(diffText("", "a"), { start: 0, removed: 0, inserted: 1 });
});

test("glows follow edits before them and vanish when their text is deleted", () => {
  const ranges = [{ id: 1, start: 4, length: 1 }];
  assert.deepEqual(shiftGlowRanges(ranges, { start: 0, removed: 0, inserted: 2 }), [{ id: 1, start: 6, length: 1 }]);
  assert.deepEqual(shiftGlowRanges(ranges, { start: 5, removed: 0, inserted: 1 }), ranges);
  assert.deepEqual(shiftGlowRanges(ranges, { start: 4, removed: 1, inserted: 0 }), []);
});

test("glowSegments splits text around glowing ranges", () => {
  assert.deepEqual(glowSegments("hello", [{ id: 7, start: 4, length: 1 }]), [
    { text: "hell" },
    { text: "o", glowId: 7 },
  ]);
  // A stale range past the end of the text is ignored rather than rendered.
  assert.deepEqual(glowSegments("hi", [{ id: 1, start: 5, length: 1 }]), [{ text: "hi" }]);
});
