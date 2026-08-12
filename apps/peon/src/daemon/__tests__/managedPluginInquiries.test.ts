import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CodexAppServerRuntime } from "../agents/runtimes/codexAppServerRuntime.js";
import { ManagedPluginInquiryService } from "../plugins/managedPluginInquiries.js";
import type { SessionRecord } from "../sessions/sessionTypes.js";

class FakeRuntime extends EventEmitter {
  generation = 7;
  calls: Array<{ method: string; params: unknown }> = [];
  getHealth() { return { status: "healthy", generation: this.generation }; }
  async request(method: string, params: unknown) {
    this.calls.push({ method, params });
    if (method === "plugin/list") return { marketplaces: [{ name: "openai-curated-remote", path: null, plugins: [{
      id: "posthog@openai-curated-remote", remotePluginId: "plugin_asdk_app_posthog", name: "posthog", installed: false, enabled: false,
      authPolicy: "ON_INSTALL", installPolicy: "AVAILABLE", source: { type: "remote" },
      interface: { displayName: "PostHog", shortDescription: "Product analytics", developerName: "PostHog", category: "Analytics", capabilities: ["events"] },
    }] }] };
    if (method === "plugin/read") return { plugin: { description: "Product analytics", summary: {
      id: "posthog@openai-curated-remote", name: "posthog", installed: false, enabled: false,
      authPolicy: "ON_INSTALL", installPolicy: "AVAILABLE", source: { type: "remote" },
    } } };
    if (method === "plugin/install") return { authPolicy: "ON_INSTALL", appsNeedingAuth: [{ id: "posthog", name: "PostHog", installUrl: "https://secret.example/token" }] };
    if (method === "app/installed") return { apps: [{ id: "posthog", enabled: true, callable: true }] };
    throw new Error(`unexpected ${method}`);
  }
}

function runningSession(): SessionRecord {
  return { id: "session-1", status: "running", backendSessionId: "thread-1", backendTurnId: "turn-1" } as SessionRecord;
}

async function observedInquiry(service: ManagedPluginInquiryService) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const inquiry = service.list("session-1")[0];
    if (inquiry) return inquiry;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("inquiry was not created");
}

test("PostHog inquiry reads native metadata, installs once, and redacts native auth URLs", async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "peon-inquiry-")), "inquiries.json");
  const sessions = [runningSession()];
  const runtime = new FakeRuntime();
  const service = new ManagedPluginInquiryService(file, () => sessions, () => 1_000);
  service.bindRuntime(runtime as unknown as CodexAppServerRuntime);
  const nativeResponse = service.handleDynamicToolCall({
    tool: "request_plugin_install", arguments: { plugin_id: "posthog@openai-curated-remote", suggest_reason: "analytics" },
    callId: "native-secret-id", threadId: "thread-1", turnId: "turn-1",
  }, 7);
  const pending = await observedInquiry(service);
  assert.equal(pending.plugin.displayName, "PostHog");
  assert.deepEqual(runtime.calls.find((call) => call.method === "plugin/list")?.params, { forceRefetch: false });
  assert.deepEqual(runtime.calls.find((call) => call.method === "plugin/read")?.params, {
    pluginName: "plugin_asdk_app_posthog", marketplacePath: null, remoteMarketplaceName: "openai-curated-remote",
  });
  assert.equal(JSON.stringify(pending).includes("native-secret-id"), false);

  const installed = await service.respond("session-1", pending.inquiryId, "operator@example.com", "install");
  assert.equal(installed.status, "auth_required");
  assert.deepEqual(installed.appsNeedingAuth, [{ id: "posthog", name: "PostHog", category: null, description: null }]);
  assert.equal(JSON.stringify(installed).includes("secret.example"), false);
  assert.equal((await nativeResponse as { success: boolean }).success, true);

  const duplicate = await service.respond("session-1", pending.inquiryId, "operator@example.com", "install");
  assert.equal(duplicate.status, "installed");
  assert.equal(runtime.calls.filter((call) => call.method === "plugin/install").length, 1);
  assert.equal((runtime.calls.find((call) => call.method === "plugin/install")?.params as { pluginName: string }).pluginName, "plugin_asdk_app_posthog");
});

test("connector auth state is not restored across a daemon generation", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peon-inquiry-auth-"));
  const file = path.join(dir, "inquiries.json");
  const runtime = new FakeRuntime();
  runtime.request = async (method: string, params: unknown) => {
    if (method === "app/installed") return { apps: [{ id: "posthog", enabled: true, callable: false }] };
    return FakeRuntime.prototype.request.call(runtime, method, params);
  };
  const service = new ManagedPluginInquiryService(file, () => [runningSession()]);
  service.bindRuntime(runtime as unknown as CodexAppServerRuntime);
  void service.handleDynamicToolCall({ tool: "request_plugin_install", arguments: { plugin_id: "posthog@openai-curated-remote" }, threadId: "thread-1", turnId: "turn-1" }, 7);
  const pending = await observedInquiry(service);
  await service.respond("session-1", pending.inquiryId, "operator@example.com", "install");
  const restored = new ManagedPluginInquiryService(file, () => [runningSession()]);
  restored.bindRuntime(runtime as unknown as CodexAppServerRuntime);
  assert.equal(restored.get("session-1", pending.inquiryId).status, "failed");
  assert.equal(restored.get("session-1", pending.inquiryId).terminalCode, "INQUIRY_RUNTIME_LOST");
});

test("expiry, actor mismatch, turn completion, restart and stale generations fail closed", async () => {
  let now = 2_000;
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "peon-inquiry-fences-")), "inquiries.json");
  const sessions = [runningSession()];
  const runtime = new FakeRuntime();
  const service = new ManagedPluginInquiryService(file, () => sessions, () => now);
  service.bindRuntime(runtime as unknown as CodexAppServerRuntime);
  void service.handleDynamicToolCall({ tool: "request_plugin_install", arguments: { plugin_id: "posthog@openai-curated-remote" }, threadId: "thread-1", turnId: "turn-1" }, 7);
  const pending = await observedInquiry(service);
  await service.respond("session-1", pending.inquiryId, "first@example.com", "cancel");
  await assert.rejects(() => service.respond("session-1", pending.inquiryId, "second@example.com", "install"), /another operator/);

  const service2 = new ManagedPluginInquiryService(path.join(path.dirname(file), "second.json"), () => sessions, () => now);
  service2.bindRuntime(runtime as unknown as CodexAppServerRuntime);
  void service2.handleDynamicToolCall({ tool: "request_plugin_install", arguments: { plugin_id: "posthog@openai-curated-remote" }, threadId: "thread-1", turnId: "turn-1" }, 7);
  const expiring = await observedInquiry(service2);
  now = Date.parse(expiring.expiresAt) + 1;
  assert.equal(service2.get("session-1", expiring.inquiryId).terminalCode, "INQUIRY_EXPIRED");

  const restored = new ManagedPluginInquiryService(path.join(path.dirname(file), "second.json"), () => sessions, () => now);
  assert.equal(restored.get("session-1", expiring.inquiryId).status, "expired");
});

test("duplicate native callbacks share one inquiry and lifecycle polling closes a stopped turn", async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "peon-inquiry-duplicates-")), "inquiries.json");
  const sessions = [runningSession()];
  const runtime = new FakeRuntime();
  const service = new ManagedPluginInquiryService(file, () => sessions);
  service.bindRuntime(runtime as unknown as CodexAppServerRuntime);
  const request = { tool: "request_plugin_install", arguments: { plugin_id: "posthog@openai-curated-remote" }, threadId: "thread-1", turnId: "turn-1" };
  const first = service.handleDynamicToolCall(request, 7);
  const pending = await observedInquiry(service);
  const second = service.handleDynamicToolCall(request, 7);
  await service.respond("session-1", pending.inquiryId, "operator@example.com", "cancel");
  assert.equal((await first as { success: boolean }).success, false);
  assert.equal((await second as { success: boolean }).success, false);
  assert.equal(service.list("session-1").length, 1);

  const otherFile = path.join(path.dirname(file), "stopped.json");
  const stoppedService = new ManagedPluginInquiryService(otherFile, () => sessions);
  stoppedService.bindRuntime(runtime as unknown as CodexAppServerRuntime);
  const stoppedResponse = stoppedService.handleDynamicToolCall(request, 7);
  const stopped = await observedInquiry(stoppedService);
  sessions[0]!.status = "completed";
  assert.equal(stoppedService.get("session-1", stopped.inquiryId).terminalCode, "INQUIRY_TURN_ENDED");
  assert.equal((await stoppedResponse as { success: boolean }).success, false);
});

test("only explicitly managed plugin ids reach native catalog metadata", async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "peon-inquiry-allowlist-")), "inquiries.json");
  const runtime = new FakeRuntime();
  const service = new ManagedPluginInquiryService(file, () => [runningSession()]);
  service.bindRuntime(runtime as unknown as CodexAppServerRuntime);
  const result = await service.handleDynamicToolCall({
    tool: "request_plugin_install", arguments: { plugin_id: "unreviewed@remote" }, threadId: "thread-1", turnId: "turn-1",
  }, 7) as { success: boolean };
  assert.equal(result.success, false);
  assert.equal(runtime.calls.length, 0);
});

test("a replaced runtime generation cannot execute an accepted install", async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "peon-inquiry-generation-")), "inquiries.json");
  const runtime = new FakeRuntime();
  const service = new ManagedPluginInquiryService(file, () => [runningSession()]);
  service.bindRuntime(runtime as unknown as CodexAppServerRuntime);
  void service.handleDynamicToolCall({
    tool: "request_plugin_install", arguments: { plugin_id: "posthog@openai-curated-remote" }, threadId: "thread-1", turnId: "turn-1",
  }, 7);
  const pending = await observedInquiry(service);
  runtime.generation = 8;
  const result = await service.respond("session-1", pending.inquiryId, "operator@example.com", "install");
  assert.equal(result.terminalCode, "INQUIRY_STALE_GENERATION");
  assert.equal(runtime.calls.some((call) => call.method === "plugin/install"), false);
});
