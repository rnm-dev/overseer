import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../../api";
import {
  inquiryAuthPath,
  inquiryCollectionPath,
  inquiryResponsePath,
  PLUGIN_INQUIRY_CAPABILITY,
  parsePluginInquiries,
  respondToPluginInquiry,
  stableInquiryError,
  visiblePluginInquiry,
} from "./pluginInquiries";

const pending = {
  version: "inquiry-v1",
  inquiryId: "inq-public-1",
  kind: "managed_plugin_install",
  status: "pending",
  plugin: { id: "posthog", name: "posthog", displayName: "PostHog", description: null, developerName: "PostHog", category: "Analytics", capabilities: [], authPolicy: "ON_INSTALL", installPolicy: "AVAILABLE", installed: false },
  sessionId: "session-1",
  createdAt: "2029-12-31T23:50:00.000Z",
  expiresAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2029-12-31T23:50:00.000Z",
  respondedBy: null,
  terminalCode: null,
  authPolicy: null,
  appsNeedingAuth: [],
} as const;

test("plugin inquiry API paths encode session and public inquiry ids", () => {
  assert.equal(PLUGIN_INQUIRY_CAPABILITY, "managed-plugin-inquiry-v1");
  const base = "/workspaces/ws/peons/peon";
  assert.equal(inquiryCollectionPath(base, "session/one"), `${base}/sessions/session%2Fone/inquiries`);
  assert.equal(inquiryResponsePath(base, "session/one", "inquiry/two"), `${base}/sessions/session%2Fone/inquiries/inquiry%2Ftwo/respond`);
  assert.equal(inquiryAuthPath(base, "session/one", "inquiry/two", "app/three"), `/api${base}/sessions/session%2Fone/inquiries/inquiry%2Ftwo/auth/app%2Fthree`);
});

test("plugin response sends the backend action contract with an opaque idempotency header", async () => {
  let call: { path: string; options?: RequestInit } | undefined;
  await respondToPluginInquiry("/workspaces/ws/peons/p", "s", "i", "install", "client-id", async <T>(path: string, options?: RequestInit) => {
    call = { path, options };
    return pending as T;
  });
  assert.equal(call?.path, "/workspaces/ws/peons/p/sessions/s/inquiries/i/respond");
  assert.equal(call?.options?.method, "POST");
  assert.equal(new Headers(call?.options?.headers).get("Peon-Request-Id"), "client-id");
  assert.deepEqual(JSON.parse(String(call?.options?.body)), { action: "install" });
});

test("inquiry parser accepts only the public standardized plugin shape", () => {
  assert.deepEqual(parsePluginInquiries({ inquiries: [pending] }, Date.parse("2029-01-01")), [pending]);
  assert.equal(visiblePluginInquiry({ ...pending, nativeRequestId: "must-not-matter" }, Date.parse("2029-01-01"))?.inquiryId, "inq-public-1");
  assert.equal(visiblePluginInquiry({ ...pending, version: "native-plugin-request" }, Date.parse("2029-01-01")), null);
  assert.equal(visiblePluginInquiry({ ...pending, plugin: { id: "posthog", name: "PostHog" } }, Date.parse("2029-01-01")), null);
  assert.throws(() => parsePluginInquiries({ inquiries: [{ ...pending, version: "native-plugin-request" }] }, Date.parse("2029-01-01")), /Invalid inquiry envelope/);
});

test("an elapsed pending inquiry fails closed locally", () => {
  assert.equal(visiblePluginInquiry(pending, Date.parse("2031-01-01"))?.status, "expired");
});

test("stable server errors recover into non-actionable UI states", () => {
  assert.equal(stableInquiryError(new ApiError(409, "INQUIRY_EXPIRED", "expired", "native-hidden")), "expired");
  assert.equal(stableInquiryError(new ApiError(409, "INQUIRY_STALE_GENERATION", "stale")), "stale");
  assert.equal(stableInquiryError(new ApiError(403, "INQUIRY_ACTOR_MISMATCH", "answered")), "refused");
  assert.equal(stableInquiryError(new ApiError(403, "FORBIDDEN", "no")), "refused");
  assert.equal(stableInquiryError(new Error("network")), "failed");
});

test("runtime loss and stale generation render as stale, not generic failure", () => {
  for (const terminalCode of ["INQUIRY_RUNTIME_LOST", "INQUIRY_STALE_GENERATION", "INQUIRY_TURN_ENDED"]) {
    assert.equal(visiblePluginInquiry({ ...pending, status: "failed", terminalCode }, Date.parse("2029-01-01"))?.status, "stale");
  }
});
