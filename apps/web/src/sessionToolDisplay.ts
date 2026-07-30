export type ToolDisplayMode = "simple" | "technical";

export const TOOL_DISPLAY_MODE_STORAGE_KEY = "overseer.session-tool-display";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function loadToolDisplayMode(storage: ReadableStorage | undefined = browserStorage()): ToolDisplayMode {
  try {
    return storage?.getItem(TOOL_DISPLAY_MODE_STORAGE_KEY) === "simple" ? "simple" : "technical";
  } catch {
    return "technical";
  }
}

export function saveToolDisplayMode(mode: ToolDisplayMode, storage: WritableStorage | undefined = browserStorage()): void {
  try {
    storage?.setItem(TOOL_DISPLAY_MODE_STORAGE_KEY, mode);
  } catch {
    // Restricted/private browser storage is best-effort; the in-memory choice
    // still applies until this page is closed.
  }
}
