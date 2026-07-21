import assert from "node:assert/strict";
import test from "node:test";
import { sheetDragProgress, shouldDismissSheet } from "../dialogMotion";

test("bottom sheet dismissal accepts a deliberate pull or a quick flick", () => {
  assert.equal(shouldDismissSheet(120, 0.1, 400), true);
  assert.equal(shouldDismissSheet(24, 0.9, 600), true);
  assert.equal(shouldDismissSheet(42, 0.3, 600), false);
});

test("drag progress is clamped and scales with the viewport", () => {
  assert.equal(sheetDragProgress(-20, 800), 0);
  assert.ok(Math.abs(sheetDragProgress(220, 800) - 0.5) < Number.EPSILON);
  assert.equal(sheetDragProgress(900, 800), 1);
});
