import assert from "node:assert/strict";
import test from "node:test";
import { clampSplit } from "./splitPane";

const BOUNDS = { min: 200, max: 560, minTrailing: 320 };

test("a split stays inside its bounds and rounds to whole pixels", () => {
  assert.equal(clampSplit(304.4, 1200, BOUNDS), 304);
  assert.equal(clampSplit(40, 1200, BOUNDS), 200);
  assert.equal(clampSplit(9000, 1200, BOUNDS), 560);
});

test("the trailing pane keeps its room before the leading pane grows", () => {
  // 700px container: the viewer's 320px leaves the tree 380px, not 560px.
  assert.equal(clampSplit(9000, 700, BOUNDS), 380);
  // Narrower than min + trailing: the minimum wins and the viewer gives way,
  // rather than the tree collapsing to nothing.
  assert.equal(clampSplit(9000, 400, BOUNDS), 200);
  assert.equal(clampSplit(40, 400, BOUNDS), 200);
});

test("an unmeasured container does not clamp the stored width", () => {
  assert.equal(clampSplit(430, Infinity, BOUNDS), 430);
});
