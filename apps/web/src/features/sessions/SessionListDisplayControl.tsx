import { readStoredValue, writeStoredValue } from "../../shared/storedValue";

export type SessionListDisplayMode = "grouped" | "flat";

export const SESSION_LIST_MODE_STORAGE_KEY = "overseer:session-list:display-mode";
export const SESSION_LIST_LIMIT_STORAGE_KEY = "overseer:session-list:project-limit";
export const SESSION_LIST_LIMIT_MIN = 1;
export const SESSION_LIST_LIMIT_MAX = 99;

export function normalizeSessionListProjectLimit(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.min(SESSION_LIST_LIMIT_MAX, Math.max(SESSION_LIST_LIMIT_MIN, Math.round(value)));
}

export function loadSessionListDisplayMode(): SessionListDisplayMode {
  return readStoredValue(SESSION_LIST_MODE_STORAGE_KEY) === "flat" ? "flat" : "grouped";
}

export function saveSessionListDisplayMode(mode: SessionListDisplayMode): void {
  writeStoredValue(SESSION_LIST_MODE_STORAGE_KEY, mode);
}

export function loadSessionListProjectLimit(): number {
  const value = Number(readStoredValue(SESSION_LIST_LIMIT_STORAGE_KEY));
  return Number.isInteger(value) && value >= SESSION_LIST_LIMIT_MIN && value <= SESSION_LIST_LIMIT_MAX ? value : 5;
}

export function saveSessionListProjectLimit(limit: number): void {
  writeStoredValue(SESSION_LIST_LIMIT_STORAGE_KEY, String(normalizeSessionListProjectLimit(limit)));
}
