import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOL_DISPLAY_MODE_STORAGE_KEY,
  loadToolDisplayMode,
  saveToolDisplayMode,
} from "./sessionToolDisplay";

test("tool display stays technical until simple mode is explicitly selected", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

  assert.equal(loadToolDisplayMode(), "technical");
  saveToolDisplayMode("simple");
  assert.equal(values.get(TOOL_DISPLAY_MODE_STORAGE_KEY), "simple");
  assert.equal(loadToolDisplayMode(), "simple");
  saveToolDisplayMode("technical");
  assert.equal(loadToolDisplayMode(), "technical");
});

test("tool display preference fails safely when browser storage is unavailable", () => {
  const storage = {
    getItem(): string | null {
      throw new Error("denied");
    },
    setItem(): void {
      throw new Error("denied");
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

  assert.equal(loadToolDisplayMode(), "technical");
  assert.doesNotThrow(() => saveToolDisplayMode("simple"));
});
