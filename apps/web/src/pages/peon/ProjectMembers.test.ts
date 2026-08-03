import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_MEMBER_LIST_CLASS } from "./ProjectMembers";

test("project member rows use the subdued theme-aware separator", () => {
  assert.match(PROJECT_MEMBER_LIST_CLASS, /divide-edge\/60/);
  assert.doesNotMatch(PROJECT_MEMBER_LIST_CLASS, /divide-iron/);
});
