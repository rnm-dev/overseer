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

  assert.equal(loadToolDisplayMode(storage), "technical");
  saveToolDisplayMode("simple", storage);
  assert.equal(values.get(TOOL_DISPLAY_MODE_STORAGE_KEY), "simple");
  assert.equal(loadToolDisplayMode(storage), "simple");
  saveToolDisplayMode("technical", storage);
  assert.equal(loadToolDisplayMode(storage), "technical");
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

  assert.equal(loadToolDisplayMode(storage), "technical");
  assert.doesNotThrow(() => saveToolDisplayMode("simple", storage));
});
