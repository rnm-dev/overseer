import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderQuotaSnapshot } from "../providers/providerQuota.js";
import type { AgentAuthStatus } from "./registry.js";

// The opencode driver runs models through OpenRouter. The key lives where
// opencode itself keeps credentials (its auth store, written through its own
// `PUT /auth/openrouter`), or in OPENROUTER_API_KEY in Peon's environment,
// which opencode also reads. Peon never persists the key itself.

const OPENROUTER_API = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 10_000;

export function opencodeAuthFile(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "auth.json");
}

export function openrouterApiKey(): { key: string; source: "env" | "opencode" } | null {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  try {
    const store = JSON.parse(readFileSync(opencodeAuthFile(), "utf8")) as Record<string, { type?: unknown; key?: unknown }>;
    const entry = store.openrouter;
    if (entry?.type === "api" && typeof entry.key === "string" && entry.key.trim()) return { key: entry.key.trim(), source: "opencode" };
  } catch {
    // Missing or unreadable store: no stored key.
  }
  return null;
}

export class OpenrouterKeyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "OpenrouterKeyError";
  }
}

async function openrouterGet(pathname: string, key: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${OPENROUTER_API}${pathname}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new OpenrouterKeyError(response.status, response.status === 401 || response.status === 403
      ? `OpenRouter rejected the API key (HTTP ${response.status} unauthorized)`
      : `OpenRouter ${pathname} returned HTTP ${response.status}`);
  }
  const body = await response.json() as { data?: unknown };
  return body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : {};
}

// GET /key describes the key itself: its own spend limit and usage.
export function fetchOpenrouterKeyInfo(key: string): Promise<Record<string, unknown>> {
  return openrouterGet("/key", key);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function maskApiKey(key: string): string {
  return key.length <= 10 ? "…" : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

// Auth state is cheap to read and refreshed in the background: a key either
// is absent (unauthenticated), was rejected by OpenRouter or by a run
// (broken), or is present and not known to be bad (ok).
class OpenrouterAuthState {
  private rejected: { key: string; message: string } | null = null;
  private checkedAt = Date.now();

  status(available: boolean): AgentAuthStatus & { keySource: string | null; keyHint: string | null; error: string | null } {
    const current = openrouterApiKey();
    const broken = current && this.rejected?.key === current.key;
    return {
      authState: !current ? "unauthenticated" : broken ? "broken" : "ok",
      available,
      checkedAt: this.checkedAt,
      keySource: current?.source ?? null,
      keyHint: current ? maskApiKey(current.key) : null,
      error: broken ? this.rejected!.message : null,
    };
  }

  async refresh(): Promise<void> {
    const current = openrouterApiKey();
    this.checkedAt = Date.now();
    if (!current) return;
    try {
      await fetchOpenrouterKeyInfo(current.key);
      if (this.rejected?.key === current.key) this.rejected = null;
    } catch (error) {
      // Only a definite rejection marks the key broken; a network failure
      // leaves the last known state alone.
      if (error instanceof OpenrouterKeyError && (error.status === 401 || error.status === 403)) {
        this.rejected = { key: current.key, message: error.message };
      }
    }
  }

  observeSuccess(): void {
    const current = openrouterApiKey();
    if (current && this.rejected?.key === current.key) this.rejected = null;
  }

  observeFailure(message: string): void {
    if (!/\b(401|403)\b|unauthori[sz]ed|invalid api key|api key|no auth credentials|ProviderAuthError/i.test(message)) return;
    const current = openrouterApiKey();
    if (current) this.rejected = { key: current.key, message: message.slice(0, 300) };
    this.checkedAt = Date.now();
  }
}

export const openrouterAuth = new OpenrouterAuthState();

export async function getOpenrouterQuota(provider: string): Promise<ProviderQuotaSnapshot> {
  const current = openrouterApiKey();
  const base = { provider, source: "api" as const, updatedAt: Date.now(), windows: [] };
  if (!current) return { ...base, status: "unavailable", error: "No API key: sign in with an OpenRouter API key" };
  try {
    const key = await fetchOpenrouterKeyInfo(current.key);
    const limit = finite(key.limit);
    const used = finite(key.usage);
    const remaining = finite(key.limit_remaining);
    return {
      ...base,
      status: "ok",
      ...(typeof key.label === "string" && key.label ? { accountEmail: key.label } : {}),
      windows: limit && limit > 0 && used !== undefined
        ? [{ id: "key-limit", label: "API key limit", usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)), resetsAt: null }]
        : [],
      credits: {
        ...(used === undefined ? {} : { used }),
        ...(limit === undefined ? {} : { limit }),
        ...(remaining === undefined ? {} : { balance: remaining }),
        currency: "USD",
      },
    };
  } catch (error) {
    return { ...base, status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}
