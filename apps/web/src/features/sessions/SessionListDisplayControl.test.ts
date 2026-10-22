import assert from "node:assert/strict";
import test from "node:test";
import {
  loadSessionListDisplayMode,
  loadSessionListProjectLimit,
  normalizeSessionListProjectLimit,
  saveSessionListDisplayMode,
  saveSessionListProjectLimit,
} from "./SessionListDisplayControl";

test("session display preferences default to grouped and accept bounded integer limits", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  assert.equal(loadSessionListDisplayMode(), "grouped");
  assert.equal(loadSessionListProjectLimit(), 5);
  saveSessionListDisplayMode("flat");
  saveSessionListProjectLimit(10);
  assert.equal(loadSessionListDisplayMode(), "flat");
  assert.equal(loadSessionListProjectLimit(), 10);
  values.set("overseer:session-list:project-limit", "17");
  assert.equal(loadSessionListProjectLimit(), 17);
  values.set("overseer:session-list:project-limit", "100");
  assert.equal(loadSessionListProjectLimit(), 5);
  assert.equal(normalizeSessionListProjectLimit(0), 1);
  assert.equal(normalizeSessionListProjectLimit(7.6), 8);
  assert.equal(normalizeSessionListProjectLimit(120), 99);
});
