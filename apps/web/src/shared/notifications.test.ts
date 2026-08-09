import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./api";
import { errorToastContent, isDuplicateErrorToast } from "./notifications";

test("error toast preserves actionable API diagnostics", () => {
  const content = errorToastContent(
    new ApiError(404, "SESSION_NOT_FOUND", "not found", "req-42"),
    { title: "Message could not be sent", fallback: "Something went wrong." },
  );

  assert.deepEqual(content, {
    title: "Message could not be sent",
    message: "not found",
    detail: undefined,
    code: "SESSION_NOT_FOUND",
    status: 404,
    requestId: "req-42",
  });
});

test("localized action guidance keeps a different raw server message as detail", () => {
  const content = errorToastContent(
    new ApiError(409, "RESUME_IN_PROGRESS", "another command still owns the session"),
    {
      title: "Message could not be sent",
      fallback: "Something went wrong.",
      message: "Session is busy — resend in a moment.",
    },
  );

  assert.equal(content.message, "Session is busy — resend in a moment.");
  assert.equal(content.detail, "another command still owns the session");
  assert.equal(content.code, "RESUME_IN_PROGRESS");
  assert.equal(content.status, 409);
});

test("unknown failures use the safe fallback", () => {
  const content = errorToastContent(null, { title: "Action failed", fallback: "Something went wrong." });
  assert.equal(content.message, "Something went wrong.");
  assert.equal(content.status, undefined);
  assert.equal(content.code, undefined);
});

test("repeated reconciliation failures are deduplicated despite different request IDs", () => {
  const first = errorToastContent(
    new ApiError(503, "PEON_OFFLINE", "connection unavailable", "req-1"),
    { title: "Queued messages could not be loaded", fallback: "Something went wrong." },
  );
  const second = errorToastContent(
    new ApiError(503, "PEON_OFFLINE", "connection unavailable", "req-2"),
    { title: "Queued messages could not be loaded", fallback: "Something went wrong." },
  );

  assert.equal(isDuplicateErrorToast(first, second), true);
});
