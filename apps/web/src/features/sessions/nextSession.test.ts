import assert from "node:assert/strict";
import test from "node:test";
import { nextSessionAfterDeletion } from "./nextSession";

test("selects the session immediately below the deleted session", () => {
  assert.equal(nextSessionAfterDeletion(["newest", "current", "older"], "current"), "older");
});

test("selects the preceding session when deleting the last session", () => {
  assert.equal(nextSessionAfterDeletion(["newest", "oldest"], "oldest"), "newest");
});

test("returns null when the deleted session was the only session", () => {
  assert.equal(nextSessionAfterDeletion(["only"], "only"), null);
});

test("selects the first known session when the current session is absent from a refreshed list", () => {
  assert.equal(nextSessionAfterDeletion(["newest", "older"], "missing"), "newest");
});
