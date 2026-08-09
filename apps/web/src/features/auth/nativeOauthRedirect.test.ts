import assert from "node:assert/strict";
import test from "node:test";
import { serverApprovedNativeRedirect } from "./nativeOauthRedirect";

test("preserves the server-approved dev mobile OAuth callback", () => {
  const redirect = "overseer-dev://oauth/github?state=state-1&code=app-code-1";
  assert.equal(serverApprovedNativeRedirect(redirect), redirect);
});

test("preserves the server-approved production mobile OAuth callback", () => {
  const redirect = "overseer://oauth/github?state=state-1&code=app-code-1";
  assert.equal(serverApprovedNativeRedirect(redirect), redirect);
});
