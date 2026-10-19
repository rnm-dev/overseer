import { readStoredValue, writeStoredValue } from "../../shared/storedValue";

export type ToolDisplayMode = "simple" | "technical";

export const TOOL_DISPLAY_MODE_STORAGE_KEY = "overseer.session-tool-display";

export function loadToolDisplayMode(): ToolDisplayMode {
  return readStoredValue(TOOL_DISPLAY_MODE_STORAGE_KEY) === "simple" ? "simple" : "technical";
}

export function saveToolDisplayMode(mode: ToolDisplayMode): void {
  writeStoredValue(TOOL_DISPLAY_MODE_STORAGE_KEY, mode);
}
