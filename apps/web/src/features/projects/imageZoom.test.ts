import assert from "node:assert/strict";
import test from "node:test";
import { canZoom, fitScale, nextZoom, zoomLabel } from "./imageZoom";

test("fitting shrinks a large image and leaves a small one alone", () => {
  assert.equal(fitScale({ width: 2000, height: 1000 }, { width: 1000, height: 1000 }), 0.5);
  assert.equal(fitScale({ width: 1000, height: 4000 }, { width: 1000, height: 1000 }), 0.25);
  // A 32px icon is shown at 32px, never blown up to fill the pane.
  assert.equal(fitScale({ width: 32, height: 32 }, { width: 1000, height: 1000 }), 1);
});

test("an unmeasured pane or image fits at 1 rather than dividing by zero", () => {
  assert.equal(fitScale({ width: 0, height: 0 }, { width: 800, height: 600 }), 1);
  assert.equal(fitScale({ width: 800, height: 600 }, { width: 0, height: -40 }), 1);
});

test("stepping moves relative to what is on screen, and stops at the ends", () => {
  // From a fitted 0.5 the first click up is the next real step, not 100%.
  assert.equal(nextZoom(0.5, 1), 0.75);
  assert.equal(nextZoom(0.37, 1), 0.5);
  assert.equal(nextZoom(0.37, -1), 0.25);
  assert.equal(nextZoom(8, 1), 8);
  assert.equal(nextZoom(0.1, -1), 0.1);
  assert.equal(canZoom(8, 1), false);
  assert.equal(canZoom(0.1, -1), false);
  assert.equal(canZoom(1, 1), true);
});

test("the label reads as a percentage, keeping a digit for very small ratios", () => {
  assert.equal(zoomLabel(1), "100%");
  assert.equal(zoomLabel(0.374), "37%");
  assert.equal(zoomLabel(0.043), "4.3%");
});
