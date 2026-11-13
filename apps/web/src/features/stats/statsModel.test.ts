import assert from "node:assert/strict";
import test from "node:test";
import { analyticsRows, catalogProvider, fmtBytes, providerName, statsProviders } from "./statsModel";

test("usage cards follow the Peon's driver catalog by service name", () => {
  const catalog = { providers: [
    { agent: "claude-code", serviceProvider: "claude-code", capabilities: { quota: true } },
    { agent: "codex-app-server", capabilities: { quota: true } },
    { agent: "opencode", serviceProvider: "opencode", capabilities: { quota: true, login: true, loginKind: "api-key" } },
    { agent: "no-quota", capabilities: { quota: false } },
  ] };
  assert.deepEqual(statsProviders(catalog), ["claude-code", "codex", "opencode"]);
  assert.deepEqual(statsProviders(null), ["claude-code", "codex"], "older Peons keep the two classic cards");
  assert.equal(catalogProvider(catalog, "codex")?.agent, "codex-app-server");
  assert.equal(catalogProvider(catalog, "opencode")?.capabilities.loginKind, "api-key");
  const t = ((key: string) => key === "peon.quota.provider.opencode" ? "OpenCode" : key) as Parameters<typeof providerName>[0];
  assert.equal(providerName(t, "opencode"), "OpenCode");
  assert.equal(providerName(t, "future-agent"), "future-agent");
});

test("analytics breakdown rows prioritize output token consumption", () => {
  const rows = analyticsRows([
    { user: "low", outputTokens: 10, promptCount: 20 },
    { user: "high", outputTokens: 40, promptCount: 1 },
    { user: "tie", outputTokens: 10, promptCount: 30 },
  ]);

  assert.deepEqual(rows.map((row) => row.user), ["high", "tie", "low"]);
});

test("state size is formatted as a compact binary byte amount", () => {
  assert.equal(fmtBytes(0), "0 B");
  assert.equal(fmtBytes(1536), "1.5 KiB");
  assert.equal(fmtBytes(12 * 1024 * 1024), "12 MiB");
  assert.equal(fmtBytes(-1), "—");
});
