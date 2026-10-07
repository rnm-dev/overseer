import assert from "node:assert/strict";
import test from "node:test";
import { loginCodeAccepted, loginPending, normalizeAttempt, pollDelay, signedOut } from "./providerLogin";

test("recognises Claude and Codex sign-in errors without treating availability as auth", () => {
  for (const message of ["Not logged in · Please run /login", "authentication_failed", "OAuth token has expired", "401 Unauthorized", "Invalid API key", "Claude OAuth credentials unavailable; run `claude auth login`", "Claude OAuth session expired; run `claude auth login`"]) assert.equal(signedOut(message), true, message);
  for (const message of ["spawn claude ENOENT", "rate limit exceeded", "HTTP 503", "port 4010 unavailable", "network timeout"]) assert.equal(signedOut(message), false, message);
});
test("attempt recovery validates links and keeps terminal state distinct", () => {
  const attempt = normalizeAttempt({ attempt: { id: "one", status: "awaiting_code", authorizationUrl: "javascript:alert(1)", pollAfterMs: -1 } });
  assert.equal(attempt?.authorizationUrl, null);
  assert.equal(loginPending(attempt), true);
  assert.equal(pollDelay(attempt), 1500);
  assert.equal(loginPending(normalizeAttempt({ id: "two", status: "succeeded" })), false);
  assert.equal(normalizeAttempt({ attempt: null }), null);
  assert.equal(normalizeAttempt({ id: "one", status: "unexpected" }), null);
});
test("codes cannot contain terminal commands or control sequences", () => {
  assert.equal(loginCodeAccepted("code#state"), true);
  for (const code of ["", "a\nb", "a\x1bb", "a;b", "a".repeat(4097)]) assert.equal(loginCodeAccepted(code), false);
});

test("Claude assistant error metadata survives flattening without marking ordinary messages", async () => {
  const { flattenEvents } = await import("../sessions/parsing");
  const t = ((key: string) => key) as Parameters<typeof flattenEvents>[1];
  const events = [{ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Please run /login" }] } }];
  const [failure] = flattenEvents(events, t);
  assert.equal(failure.kind === "text" && failure.providerError, "authentication_failed");
  const [normal] = flattenEvents([{ ...events[0], error: undefined }], t);
  assert.equal(normal.kind === "text" && normal.providerError, undefined);
});
