import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../shared/api";
import { stopOutcome } from "./stopOutcome";

test("a refused cancel means the run had already ended", () => {
  assert.equal(stopOutcome(new ApiError(409, "SESSION_NOT_RUNNING", "session is not the active running session")), "already-stopped");
});

test("a missing route means the peon predates the stop endpoint", () => {
  assert.equal(stopOutcome(new ApiError(404, "NOT_FOUND", "not found")), "unsupported");
});

test("every other failure stays a generic error", () => {
  assert.equal(stopOutcome(new ApiError(502, "PEON_UNREACHABLE", "peon unreachable")), "failed");
  assert.equal(stopOutcome(new Error("network down")), "failed");
});
