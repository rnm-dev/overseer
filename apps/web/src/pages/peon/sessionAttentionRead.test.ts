import assert from "node:assert/strict";
import test from "node:test";
import { documentPresence, shouldMarkAttentionRead } from "./sessionAttentionRead";

test("a session counts as seen only while its tab is visible and focused", () => {
  assert.equal(shouldMarkAttentionRead("visible", true), true);
  assert.equal(shouldMarkAttentionRead("visible", false), false);
  assert.equal(shouldMarkAttentionRead("hidden", true), false);
  assert.equal(shouldMarkAttentionRead("hidden", false), false);
});

test("presence reads the document and defaults to seen when there is none", () => {
  assert.equal(documentPresence({ visibilityState: "visible", hasFocus: () => true } as Document), true);
  assert.equal(documentPresence({ visibilityState: "hidden", hasFocus: () => true } as Document), false);
  assert.equal(documentPresence({ visibilityState: "visible", hasFocus: () => false } as Document), false);
  assert.equal(documentPresence(undefined), true);
});
