import assert from "node:assert/strict";
import test from "node:test";
import { countLines, gutterWidthCh, lineNumberText } from "./lineNumbers";

test("a file ending in a newline has no empty last line to number", () => {
  assert.equal(countLines("a\nb\nc\n"), 3);
  assert.equal(countLines("a\nb\nc"), 3);
  // An empty file is still one line: that is where the cursor sits.
  assert.equal(countLines(""), 1);
  assert.equal(countLines("\n"), 1);
  // A blank line in the middle counts, and so does a trailing blank line the
  // operator deliberately left by pressing enter twice.
  assert.equal(countLines("a\n\nb"), 3);
  assert.equal(countLines("a\n\n"), 2);
});

test("the gutter is one text node, one number per line", () => {
  assert.equal(lineNumberText("a\nb\nc"), "1\n2\n3");
  assert.equal(lineNumberText(""), "1");
});

test("the gutter is wide enough for the longest number it will show", () => {
  assert.equal(gutterWidthCh(""), 2);
  assert.equal(gutterWidthCh("a\n".repeat(9)), 2);
  assert.equal(gutterWidthCh("a\n".repeat(120)), 3);
  assert.equal(gutterWidthCh("a\n".repeat(1500)), 4);
});
