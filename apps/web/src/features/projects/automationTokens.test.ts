import assert from "node:assert/strict";
import test from "node:test";
import {
  canRevoke,
  createAutomationToken,
  isExpired,
  listAutomationTokens,
  orderedTokens,
  revokeAutomationToken,
  type AutomationToken,
} from "./automationTokens";

function token(overrides: Partial<AutomationToken> = {}): AutomationToken {
  return {
    id: "t1",
    label: "CI",
    peonId: "peon-1",
    projectKey: "alpha",
    projectId: "proj-a",
    ownerUserId: "user-1",
    ownerEmail: "owner@example.com",
    createdAt: 1_000,
    lastUsedAt: null,
    expiresAt: null,
    mine: true,
    ...overrides,
  };
}

test("tokens that are still in use sort above ones that only exist", () => {
  const ordered = orderedTokens([
    token({ id: "old", createdAt: 10 }),
    token({ id: "used", createdAt: 5, lastUsedAt: 900 }),
    token({ id: "new", createdAt: 100 }),
  ]);
  assert.deepEqual(ordered.map((entry) => entry.id), ["used", "new", "old"]);
});

test("a token with no expiry never reads as expired", () => {
  assert.equal(isExpired(token({ expiresAt: null }), 9_999), false);
  assert.equal(isExpired(token({ expiresAt: 10_000 }), 9_999), false);
  assert.equal(isExpired(token({ expiresAt: 9_999 }), 9_999), true);
});

test("the revoke button is offered only where the server would honour it", () => {
  assert.equal(canRevoke(token({ mine: true }), false), true);
  assert.equal(canRevoke(token({ mine: false }), false), false);
  assert.equal(canRevoke(token({ mine: false }), true), true);
});

test("no expiry is sent as an absent field, not as a zero", () => {
  let captured: RequestInit | undefined;
  const request = (async (_path: string, options?: RequestInit) => {
    captured = options;
    return { token: "ovsr_at_a.b", created: token() };
  }) as <T>(path: string, options?: RequestInit) => Promise<T>;
  void createAutomationToken("/base", "alpha", { label: "CI", expiresInDays: null }, request);
  assert.deepEqual(JSON.parse(String(captured?.body)), { label: "CI" });
  void createAutomationToken("/base", "alpha", { label: null, expiresInDays: 30 }, request);
  assert.deepEqual(JSON.parse(String(captured?.body)), { label: null, expiresInDays: 30 });
});

test("token requests stay under the project the settings page is showing", () => {
  const seen: string[] = [];
  const request = (async (path: string) => {
    seen.push(path);
    return { tokens: [], canManageAll: false };
  }) as <T>(path: string, options?: RequestInit) => Promise<T>;
  void listAutomationTokens("/base", "a b", request);
  void revokeAutomationToken("/base", "a b", "t 1", request);
  assert.deepEqual(seen, ["/base/projects/a%20b/automation-tokens", "/base/projects/a%20b/automation-tokens/t%201"]);
});
