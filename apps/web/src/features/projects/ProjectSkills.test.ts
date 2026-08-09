import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../shared/api";
import { projectSkillsErrorKind } from "./ProjectSkills";

test("project skill errors distinguish unsupported, missing, unauthorized, and unreachable Peons", () => {
  assert.equal(projectSkillsErrorKind(new ApiError(404, "NOT_FOUND", "missing endpoint")), "unsupported");
  assert.equal(projectSkillsErrorKind(new ApiError(404, "UNKNOWN_PROJECT", "unknown project")), "unknown");
  assert.equal(projectSkillsErrorKind(new ApiError(401, "UNAUTHENTICATED", "no")), "forbidden");
  assert.equal(projectSkillsErrorKind(new ApiError(403, "FORBIDDEN", "no")), "forbidden");
  assert.equal(projectSkillsErrorKind(new ApiError(502, "PEON_UNREACHABLE", "offline")), "error");
});
