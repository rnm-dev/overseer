import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTokenLabel, parseAutomationToken, resolveExpiry } from "./automationTokens.js";
import { AUTOMATION_TOKEN_PREFIX } from "./automationTokenTypes.js";

test("an automation token is recognized only by its own prefixed shape", () => {
  const parsed = parseAutomationToken(`${AUTOMATION_TOKEN_PREFIX}abc.def`);
  assert.deepEqual(parsed, { id: "abc", secret: "def" });
});

test("a device token is never mistaken for an automation token", () => {
  // Device tokens are `<uuid>.<secret>` with no prefix. Accepting that shape
  // here would let an operator credential open the machine front door.
  assert.equal(parseAutomationToken("2f1c0f8e-0000-4000-8000-000000000000.secret"), null);
  assert.equal(parseAutomationToken(""), null);
  assert.equal(parseAutomationToken(`${AUTOMATION_TOKEN_PREFIX}abc`), null);
  assert.equal(parseAutomationToken(`${AUTOMATION_TOKEN_PREFIX}.def`), null);
  assert.equal(parseAutomationToken(`${AUTOMATION_TOKEN_PREFIX}abc.`), null);
});

test("labels are trimmed, bounded and optional", () => {
  assert.equal(normalizeTokenLabel("  CI  "), "CI");
  assert.equal(normalizeTokenLabel("   "), null);
  assert.equal(normalizeTokenLabel(undefined), null);
  assert.equal(normalizeTokenLabel(42), null);
  assert.equal(normalizeTokenLabel("x".repeat(500))?.length, 120);
});

test("no expiry is a choice, an out-of-range expiry is a mistake", () => {
  const now = 1_700_000_000_000;
  assert.equal(resolveExpiry(undefined, now), null);
  assert.equal(resolveExpiry(null, now), null);
  assert.equal(resolveExpiry(30, now), now + 30 * 86_400_000);
  // Clamping would silently hand back a token with a lifetime nobody asked
  // for, so the request is refused instead.
  assert.equal(resolveExpiry(0, now), "invalid");
  assert.equal(resolveExpiry(366, now), "invalid");
  assert.equal(resolveExpiry(1.5, now), "invalid");
  assert.equal(resolveExpiry("30", now), "invalid");
});
