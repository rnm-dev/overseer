import { readStoredValue, writeStoredValue, type ReadableStorage, type WritableStorage } from "./storedValue";

export type ToolDisplayMode = "simple" | "technical";

export const TOOL_DISPLAY_MODE_STORAGE_KEY = "overseer.session-tool-display";

export function loadToolDisplayMode(storage?: ReadableStorage): ToolDisplayMode {
  return readStoredValue(TOOL_DISPLAY_MODE_STORAGE_KEY, storage) === "simple" ? "simple" : "technical";
}

export function saveToolDisplayMode(mode: ToolDisplayMode, storage?: WritableStorage): void {
  writeStoredValue(TOOL_DISPLAY_MODE_STORAGE_KEY, mode, storage);
}
