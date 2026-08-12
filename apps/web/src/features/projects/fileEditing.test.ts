import assert from "node:assert/strict";
import test from "node:test";
import { canEditFile, editBaseline, hasUnsavedChanges, isSaveShortcut } from "./fileEditing";

test("text is editable, binary is not, and only where the tree may write", () => {
  assert.equal(canEditFile("markdown", true), true);
  assert.equal(canEditFile("text", true), true);
  assert.equal(canEditFile("markdown", false), false);
  assert.equal(canEditFile("text", false), false);
  assert.equal(canEditFile("image", true), false);
  assert.equal(canEditFile("pdf", true), false);
  assert.equal(canEditFile("unsupported", true), false);
  assert.equal(canEditFile(undefined, true), false);
});

test("a draft equal to the file on disk is not a change", () => {
  // No editor open at all.
  assert.equal(hasUnsavedChanges("# Title", null), false);
  // Opened and untouched.
  assert.equal(hasUnsavedChanges("# Title", "# Title"), false);
  assert.equal(hasUnsavedChanges("# Title", "# Title "), true);
  // An empty file opened and left empty; emptying a file is a change.
  assert.equal(hasUnsavedChanges(undefined, ""), false);
  assert.equal(hasUnsavedChanges("# Title", ""), true);
});

test("save is Ctrl/Cmd+S, on any layout, and not with Alt", () => {
  const key = (over: Partial<KeyboardEvent>) => ({ key: "s", metaKey: false, ctrlKey: false, altKey: false, ...over }) as KeyboardEvent;
  assert.equal(isSaveShortcut(key({ metaKey: true })), true);
  assert.equal(isSaveShortcut(key({ ctrlKey: true })), true);
  // A capital S (caps lock, or shift held) is still the same shortcut.
  assert.equal(isSaveShortcut(key({ ctrlKey: true, key: "S" })), true);
  assert.equal(isSaveShortcut(key({})), false);
  assert.equal(isSaveShortcut(key({ ctrlKey: true, key: "a" })), false);
  // Alt+Cmd+S belongs to the browser.
  assert.equal(isSaveShortcut(key({ metaKey: true, altKey: true })), false);
});

test("a draft is only ever seeded from the file it belongs to", () => {
  // The pane holds the previous file's text for a render or two after it is
  // pointed at a new one; `hasUnsavedChanges` is what the header trusts, so
  // feeding it the wrong original is what would arm Save against the wrong file.
  const previous = "# the file we left";
  assert.equal(hasUnsavedChanges(undefined, previous), true);
  assert.equal(hasUnsavedChanges(previous, previous), false);
});

test("a just-saved file is measured against what was written, not the stale read", () => {
  const written = { path: "a.md", text: "# saved" };
  // The reader has not caught up yet: without the written text standing in,
  // Save would re-arm itself the instant it finished.
  assert.equal(editBaseline(written, "# before", "a.md"), "# saved");
  assert.equal(hasUnsavedChanges(editBaseline(written, "# before", "a.md"), "# saved"), false);
  assert.equal(hasUnsavedChanges(editBaseline(null, "# before", "a.md"), "# saved"), true);
  // A write remembered for one file never speaks for another.
  assert.equal(editBaseline(written, "# other", "b.md"), "# other");
  assert.equal(editBaseline(null, "# other", "b.md"), "# other");
});
