import assert from "node:assert/strict";
import test from "node:test";
import { keepsShownContent } from "./FileView";

test("re-reading the file on screen keeps it, rather than flashing a spinner", () => {
  const shown = { path: "docs/a.md", loading: false, kind: "markdown" as const, text: "# a" };
  assert.equal(keepsShownContent(shown, "docs/a.md"), true);
  // An image is held by its object URL, a refusal by its note — both count.
  assert.equal(keepsShownContent({ path: "a.png", loading: false, objectUrl: "blob:x" }, "a.png"), true);
  assert.equal(keepsShownContent({ path: "a.zip", loading: false, note: "unsupported" }, "a.zip"), true);
});

test("a different file, or one never rendered, loads openly", () => {
  const shown = { path: "docs/a.md", loading: false, text: "# a" };
  assert.equal(keepsShownContent(shown, "docs/b.md"), false);
  assert.equal(keepsShownContent({ path: "docs/a.md", loading: true }, "docs/a.md"), false);
  assert.equal(keepsShownContent({ path: "docs/a.md", loading: false }, "docs/a.md"), false);
});
