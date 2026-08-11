import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../shared/api";
import {
  inquiryCollectionPath,
  inquiryInsertionIndex,
  inquiryRecoveryEnabled,
  inquiryResponsePath,
  ACTIVE_INQUIRY_RECOVERY_MS,
  PLUGIN_INQUIRY_CAPABILITY,
  parsePluginInquiries,
  readPluginInquiries,
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

test("authenticated concurrent inquiry readers share only within one operator scope", async () => {
  const resolvers: Array<(value: { inquiries: typeof pending[] }) => void> = [];
  let calls = 0;
  const request = async <T>() => {
    calls += 1;
    return new Promise<T>((resolve) => resolvers.push(resolve as (value: { inquiries: typeof pending[] }) => void));
  };
  const path = inquiryCollectionPath("/peon", "session-1");
  const first = readPluginInquiries(path, "operator-a", request);
  const strictModeReplay = readPluginInquiries(path, "operator-a", request);
  const otherOperator = readPluginInquiries(path, "operator-b", request);
  assert.equal(calls, 2);

  resolvers.shift()!({ inquiries: [pending] });
  resolvers.shift()!({ inquiries: [] });
  assert.deepEqual(await first, { inquiries: [pending] });
  assert.deepEqual(await strictModeReplay, { inquiries: [pending] });
  assert.deepEqual(await otherOperator, { inquiries: [] });
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

test("historical inquiries stay beside their creation time instead of following new messages", () => {
  const items = [{ createdAt: 100 }, { createdAt: 200 }, { createdAt: 400 }];
  assert.equal(inquiryInsertionIndex(items, new Date(250).toISOString()), 2);
  assert.equal(inquiryInsertionIndex(items, new Date(500).toISOString()), 3);
});

test("legacy inquiry recovery is bounded to active visible turns", () => {
  assert.equal(ACTIVE_INQUIRY_RECOVERY_MS, 30_000);
  assert.equal(Math.floor(413_000 / ACTIVE_INQUIRY_RECOVERY_MS), 13);
  assert.equal(inquiryRecoveryEnabled(true, "session-1", true, true), true);
  assert.equal(inquiryRecoveryEnabled(true, "session-1", false, true), false);
  assert.equal(inquiryRecoveryEnabled(true, "session-1", true, false), false);
  assert.equal(inquiryRecoveryEnabled(false, "session-1", true, true), false);
});
