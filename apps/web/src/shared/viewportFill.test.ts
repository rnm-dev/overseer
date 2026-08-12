import assert from "node:assert/strict";
import test from "node:test";
import { pageBottomGap, viewportFillHeight } from "./viewportFill";

test("a pane claims the viewport below wherever it starts, never below its minimum", () => {
  assert.equal(viewportFillHeight(160, 28, 448), "max(448px, calc(100dvh - 188px))");
  // Sub-pixel layout must not leak fractional CSS lengths.
  assert.equal(viewportFillHeight(160.4, 27.6, 448), "max(448px, calc(100dvh - 188px))");
  // A pane measured above the viewport (mid-transition) subtracts nothing.
  assert.equal(viewportFillHeight(-40, 0, 320), "max(320px, calc(100dvh - 0px))");
});

test("the bottom gap comes from the first padded ancestor, and is zero when none pads", () => {
  const node = (paddingBottom: string, parent: HTMLElement | null = null) => ({
    parentElement: parent,
    style: { paddingBottom },
  }) as unknown as HTMLElement;
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = ((element: HTMLElement) => ({ paddingBottom: element.style.paddingBottom })) as typeof getComputedStyle;
  try {
    const padded = node("28px");
    assert.equal(pageBottomGap(node("0px", node("", padded))), 28);
    assert.equal(pageBottomGap(node("0px")), 0);
    // The walk stops rather than climbing to the document for a stray value.
    assert.equal(pageBottomGap(node("0px", node("0px", node("0px", padded))), 2), 0);
  } finally {
    globalThis.getComputedStyle = original;
  }
});
