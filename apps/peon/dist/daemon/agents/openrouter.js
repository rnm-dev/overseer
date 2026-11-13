import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// The opencode driver runs models through OpenRouter. The key lives where
// opencode itself keeps credentials (its auth store, written through its own
// `PUT /auth/openrouter`), or in OPENROUTER_API_KEY in Peon's environment,
// which opencode also reads. Peon never persists the key itself.
const OPENROUTER_API = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 10_000;
export function opencodeAuthFile() {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    return path.join(dataHome, "opencode", "auth.json");
}
export function openrouterApiKey() {
    const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
    if (fromEnv)
        return { key: fromEnv, source: "env" };
    try {
        const store = JSON.parse(readFileSync(opencodeAuthFile(), "utf8"));
        const entry = store.openrouter;
        if (entry?.type === "api" && typeof entry.key === "string" && entry.key.trim())
            return { key: entry.key.trim(), source: "opencode" };
    }
    catch {
        // Missing or unreadable store: no stored key.
    }
    return null;
}
export class OpenrouterKeyError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "OpenrouterKeyError";
    }
}
async function openrouterGet(pathname, key) {
    const response = await fetch(`${OPENROUTER_API}${pathname}`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new OpenrouterKeyError(response.status, response.status === 401 || response.status === 403
            ? `OpenRouter rejected the API key (HTTP ${response.status} unauthorized)`
            : `OpenRouter ${pathname} returned HTTP ${response.status}`);
    }
    const body = await response.json();
    return body.data && typeof body.data === "object" ? body.data : {};
}
// GET /key describes the key itself: its own spend limit and usage.
export function fetchOpenrouterKeyInfo(key) {
    return openrouterGet("/key", key);
}
function finite(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function maskApiKey(key) {
    return key.length <= 10 ? "…" : `${key.slice(0, 6)}…${key.slice(-4)}`;
}
// Auth state is cheap to read and refreshed in the background: a key either
// is absent (unauthenticated), was rejected by OpenRouter or by a run
// (broken), or is present and not known to be bad (ok).
class OpenrouterAuthState {
    rejected = null;
    checkedAt = Date.now();
    status(available) {
        const current = openrouterApiKey();
        const broken = current && this.rejected?.key === current.key;
        return {
            authState: !current ? "unauthenticated" : broken ? "broken" : "ok",
            available,
            checkedAt: this.checkedAt,
            keySource: current?.source ?? null,
            keyHint: current ? maskApiKey(current.key) : null,
            error: broken ? this.rejected.message : null,
        };
    }
    async refresh() {
        const current = openrouterApiKey();
        this.checkedAt = Date.now();
        if (!current)
            return;
        try {
            await fetchOpenrouterKeyInfo(current.key);
            if (this.rejected?.key === current.key)
                this.rejected = null;
        }
        catch (error) {
            // Only a definite rejection marks the key broken; a network failure
            // leaves the last known state alone.
            if (error instanceof OpenrouterKeyError && (error.status === 401 || error.status === 403)) {
                this.rejected = { key: current.key, message: error.message };
            }
        }
    }
    observeSuccess() {
        const current = openrouterApiKey();
        if (current && this.rejected?.key === current.key)
            this.rejected = null;
    }
    observeFailure(message) {
        if (!/\b(401|403)\b|unauthori[sz]ed|invalid api key|api key|no auth credentials|ProviderAuthError/i.test(message))
            return;
        const current = openrouterApiKey();
        if (current)
            this.rejected = { key: current.key, message: message.slice(0, 300) };
        this.checkedAt = Date.now();
    }
}
export const openrouterAuth = new OpenrouterAuthState();
export async function getOpenrouterQuota(provider) {
    const current = openrouterApiKey();
    const base = { provider, source: "api", updatedAt: Date.now(), windows: [] };
    if (!current)
        return { ...base, status: "unavailable", error: "No API key: sign in with an OpenRouter API key" };
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
    }
    catch (error) {
        return { ...base, status: "error", error: error instanceof Error ? error.message : String(error) };
    }
}
