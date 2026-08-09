import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../shared/api";
import { followupWasRefused } from "./useSessionComposer";

test("only an explicit non-5xx follow-up refusal may restore the visible draft", () => {
  assert.equal(followupWasRefused(new ApiError(400, "BAD_REQUEST", "bad request")), true);
  assert.equal(followupWasRefused(new ApiError(409, "RESUME_IN_PROGRESS", "busy")), true);
  assert.equal(followupWasRefused(new ApiError(500, "INTERNAL", "failed")), false);
  assert.equal(followupWasRefused(new TypeError("Failed to fetch")), false);
});
