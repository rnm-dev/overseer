import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { settings } from "../settings/index.js";
import { claudeCodeAuth } from "./claudeCodeAuth.js";
const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
const PROBE_TIMEOUT_MS = 12_000;
const CODEX_QUOTA_ARGS = ["-s", "read-only", "-a", "never", "app-server"];
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function finiteNumber(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
}
function epochMs(value) {
    const seconds = finiteNumber(value);
    if (seconds !== undefined)
        return seconds > 10_000_000_000 ? seconds : seconds * 1000;
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return null;
}
function percent(value) {
    const parsed = finiteNumber(value);
    return parsed === undefined ? undefined : Math.max(0, Math.min(100, parsed));
}
function errorMessage(err) {
    const message = err instanceof Error ? err.message : String(err);
    // Provider responses can include credentials in nested diagnostics. Keep the
    // API/UI error deliberately short and single-line.
    return message.replace(/[\r\n]+/g, " ").slice(0, 300);
}
function unavailable(provider, message) {
    return { provider, status: "unavailable", source: null, updatedAt: Date.now(), windows: [], error: message };
}
function codexWindowPeriod(value, fallbackId, fallbackLabel) {
    const window = object(value);
    const durationMins = finiteNumber(window?.windowDurationMins);
    // `primary` and `secondary` describe ordering, not a stable period. Codex
    // can return a weekly-only plan in `primary`, so identify known windows by
    // their advertised duration instead of assigning fixed labels by position.
    if (durationMins === 5 * 60)
        return { id: "session", label: "5-hour" };
    if (durationMins === 7 * 24 * 60)
        return { id: "weekly", label: "Weekly" };
    return { id: fallbackId, label: fallbackLabel };
}
function codexWindow(idPrefix, fallbackId, fallbackLabel, value, modelIds) {
    const window = object(value);
    const usedPercent = percent(window?.usedPercent);
    if (usedPercent === undefined)
        return null;
    const period = codexWindowPeriod(value, fallbackId, fallbackLabel);
    return {
        id: idPrefix ? `${idPrefix}:${period.id}` : period.id,
        label: idPrefix ? `${fallbackLabel} ${period.label.toLowerCase()}` : period.label,
        usedPercent,
        resetsAt: epochMs(window?.resetsAt),
        ...(modelIds?.length ? { modelIds } : {}),
    };
}
function codexModelIds(limitId, limitName) {
    const normalized = `${limitId} ${limitName}`.toLowerCase();
    if (normalized.includes("spark"))
        return ["gpt-5.3-codex-spark"];
    return undefined;
}
export async function fetchCodexQuota() {
    const command = settings.get().codexCommand || "codex";
    return await new Promise((resolve) => {
        const child = spawn(command, CODEX_QUOTA_ARGS, {
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
        });
        let nextId = 1;
        let stdout = "";
        let stderr = "";
        let settled = false;
        const pending = new Map();
        const finish = (snapshot) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            for (const waiter of pending.values())
                waiter.reject(new Error("Codex RPC closed"));
            pending.clear();
            if (!child.killed)
                child.kill();
            resolve(snapshot);
        };
        const request = (method, params = {}) => {
            const id = nextId++;
            child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
            return new Promise((requestResolve, reject) => pending.set(id, { resolve: requestResolve, reject }));
        };
        const timeout = setTimeout(() => {
            finish({ provider: "codex", status: "error", source: "cli-rpc", updatedAt: Date.now(), windows: [], error: "Codex usage probe timed out" });
        }, PROBE_TIMEOUT_MS);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            let newline = stdout.indexOf("\n");
            while (newline >= 0) {
                const line = stdout.slice(0, newline).trim();
                stdout = stdout.slice(newline + 1);
                if (line) {
                    try {
                        const message = JSON.parse(line);
                        const id = finiteNumber(message.id);
                        if (id !== undefined) {
                            const waiter = pending.get(id);
                            if (waiter) {
                                pending.delete(id);
                                const rpcError = object(message.error);
                                if (rpcError)
                                    waiter.reject(new Error(String(rpcError.message ?? "Codex RPC request failed")));
                                else
                                    waiter.resolve(object(message.result) ?? {});
                            }
                        }
                    }
                    catch {
                        // app-server may emit non-JSON diagnostics; only complete JSON lines matter.
                    }
                }
                newline = stdout.indexOf("\n");
            }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
        child.on("error", (err) => finish(unavailable("codex", `Codex CLI unavailable: ${errorMessage(err)}`)));
        child.on("exit", (code) => {
            if (!settled)
                finish(unavailable("codex", `Codex usage probe exited${code === null ? "" : ` with code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        });
        void (async () => {
            try {
                await request("initialize", { clientInfo: { name: "peon", version: "0.0.1" } });
                child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
                const [response, accountResponse] = await Promise.all([
                    request("account/rateLimits/read"),
                    request("account/read"),
                ]);
                const main = object(response.rateLimits);
                if (!main)
                    throw new Error("Codex returned no rate limits");
                const windows = [];
                const primary = codexWindow("", "session", "Session", main.primary);
                const secondary = codexWindow("", "weekly", "Weekly", main.secondary);
                if (primary)
                    windows.push(primary);
                if (secondary)
                    windows.push(secondary);
                const extra = object(response.rateLimitsByLimitId ?? response.rate_limits_by_limit_id);
                for (const [key, raw] of Object.entries(extra ?? {})) {
                    const limit = object(raw);
                    if (!limit)
                        continue;
                    const limitId = String(limit.limitId ?? limit.limit_id ?? key);
                    const limitName = String(limit.limitName ?? limit.limit_name ?? limitId);
                    if (limitId.toLowerCase() === "codex")
                        continue;
                    const modelIds = codexModelIds(limitId, limitName);
                    const extraPrimary = codexWindow(limitId, "session", limitName, limit.primary, modelIds);
                    const extraSecondary = codexWindow(limitId, "weekly", limitName, limit.secondary, modelIds);
                    if (extraPrimary)
                        windows.push(extraPrimary);
                    if (extraSecondary)
                        windows.push(extraSecondary);
                }
                const creditsRaw = object(main.credits);
                const balance = finiteNumber(creditsRaw?.balance);
                const individual = object(main.individualLimit ?? main.individual_limit);
                const limit = finiteNumber(individual?.limit);
                const used = finiteNumber(individual?.used);
                const credits = balance !== undefined || limit !== undefined || used !== undefined
                    ? { ...(balance !== undefined ? { balance } : {}), ...(limit !== undefined ? { limit } : {}), ...(used !== undefined ? { used } : {}) }
                    : undefined;
                const account = object(accountResponse.account);
                const accountEmail = account?.type === "chatgpt" && typeof account.email === "string"
                    ? account.email
                    : undefined;
                finish({
                    provider: "codex",
                    status: "ok",
                    source: "cli-rpc",
                    updatedAt: Date.now(),
                    ...(accountEmail ? { accountEmail } : {}),
                    windows,
                    ...(credits ? { credits } : {}),
                });
            }
            catch (err) {
                finish({ provider: "codex", status: "error", source: "cli-rpc", updatedAt: Date.now(), windows: [], error: errorMessage(err) });
            }
        })();
    });
}
function parseClaudeCredential(raw) {
    try {
        const root = JSON.parse(raw);
        const oauth = object(root.claudeAiOauth);
        const accessToken = typeof oauth?.accessToken === "string" ? oauth.accessToken.trim() : "";
        if (!accessToken)
            return null;
        const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes.filter((v) => typeof v === "string") : [];
        return { accessToken, scopes };
    }
    catch {
        return null;
    }
}
async function loadClaudeCredential() {
    const envToken = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.CODEXBAR_CLAUDE_OAUTH_TOKEN ?? "").trim();
    if (envToken)
        return { accessToken: envToken, scopes: ["user:profile"] };
    const roots = (process.env.CLAUDE_CONFIG_DIR ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    roots.push(path.join(os.homedir(), ".claude"));
    for (const root of [...new Set(roots)]) {
        const file = path.join(root, ".credentials.json");
        if (!existsSync(file))
            continue;
        try {
            const credential = parseClaudeCredential(readFileSync(file, "utf8"));
            if (credential)
                return credential;
        }
        catch {
            // Keep trying other configured roots/Keychain when a file is unreadable.
        }
    }
    if (process.platform === "darwin") {
        try {
            const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
                timeout: 5_000,
                maxBuffer: 1024 * 1024,
            });
            return parseClaudeCredential(stdout);
        }
        catch {
            // Missing/locked Keychain credentials are reported as provider unavailable.
        }
    }
    return null;
}
function claudeModelIds(name) {
    const normalized = name.toLowerCase();
    if (normalized.includes("opus"))
        return ["claude-opus-5"];
    if (normalized.includes("sonnet"))
        return ["claude-sonnet-5"];
    if (normalized.includes("fable"))
        return ["claude-fable-5"];
    if (normalized.includes("haiku"))
        return ["claude-haiku-4-5-20251001"];
    return undefined;
}
function claudeWindow(id, label, value, modelIds) {
    const window = object(value);
    const usedPercent = percent(window?.utilization ?? window?.percent);
    if (usedPercent === undefined)
        return null;
    return { id, label, usedPercent, resetsAt: epochMs(window?.resets_at), ...(modelIds?.length ? { modelIds } : {}) };
}
export async function fetchClaudeQuota() {
    const credential = await loadClaudeCredential();
    if (!credential)
        return unavailable("claude-code", "Claude OAuth credentials unavailable; run `claude auth login`");
    if (credential.scopes.length > 0 && !credential.scopes.includes("user:profile")) {
        return unavailable("claude-code", "Claude OAuth token lacks the user:profile scope; run `claude auth login`");
    }
    try {
        const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
            headers: {
                Authorization: `Bearer ${credential.accessToken}`,
                Accept: "application/json",
                "Content-Type": "application/json",
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": "claude-code/2.1.0",
            },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (response.status === 401 || response.status === 403)
            return unavailable("claude-code", "Claude OAuth session expired; run `claude auth login`");
        if (!response.ok)
            throw new Error(`Claude usage API returned HTTP ${response.status}`);
        const body = await response.json();
        const windows = [];
        for (const [id, label, key, modelIds] of [
            ["session", "5-hour", "five_hour", undefined],
            ["weekly", "Weekly", "seven_day", undefined],
            ["opus-weekly", "Opus weekly", "seven_day_opus", ["claude-opus-5"]],
            ["sonnet-weekly", "Sonnet weekly", "seven_day_sonnet", ["claude-sonnet-5"]],
            ["routines-weekly", "Routines weekly", "seven_day_routines", undefined],
        ]) {
            const window = claudeWindow(id, label, body[key], modelIds);
            if (window)
                windows.push(window);
        }
        if (Array.isArray(body.limits)) {
            for (const [index, raw] of body.limits.entries()) {
                const item = object(raw);
                const scope = object(item?.scope);
                const model = object(scope?.model);
                const displayName = typeof model?.display_name === "string" ? model.display_name : "Scoped";
                const modelIds = claudeModelIds(displayName);
                const window = claudeWindow(`scoped-${index}`, `${displayName} limit`, item, modelIds);
                // The limits array can repeat the shared five-hour/weekly windows. Only
                // retain entries that are genuinely model-scoped or otherwise distinct.
                const duplicateShared = window && !modelIds && windows.some((existing) => existing.usedPercent === window.usedPercent && existing.resetsAt === window.resetsAt);
                if (window && !duplicateShared)
                    windows.push(window);
            }
        }
        const extra = object(body.extra_usage);
        const limit = finiteNumber(extra?.monthly_limit);
        const used = finiteNumber(extra?.used_credits);
        const currency = typeof extra?.currency === "string" ? extra.currency : undefined;
        const credits = limit !== undefined || used !== undefined
            ? { ...(limit !== undefined ? { limit } : {}), ...(used !== undefined ? { used } : {}), ...(currency ? { currency } : {}) }
            : undefined;
        const accountEmail = claudeCodeAuth.getState().cliCheck.email ?? undefined;
        return {
            provider: "claude-code",
            status: "ok",
            source: "oauth",
            updatedAt: Date.now(),
            ...(accountEmail ? { accountEmail } : {}),
            windows,
            ...(credits ? { credits } : {}),
        };
    }
    catch (err) {
        return { provider: "claude-code", status: "error", source: "oauth", updatedAt: Date.now(), windows: [], error: errorMessage(err) };
    }
}
const cache = new Map();
const inFlight = new Map();
const quotaFetchers = {
    "claude-code": fetchClaudeQuota,
    codex: fetchCodexQuota,
};
export const QUOTA_PROVIDERS = Object.keys(quotaFetchers);
function fetchProvider(provider) {
    const selected = quotaFetchers[provider];
    return selected ? selected() : Promise.resolve(unavailable(provider, `No quota service registered for ${provider}`));
}
export const getClaudeQuota = (force = false) => getProviderQuota("claude-code", force);
export const getCodexQuota = (force = false) => getProviderQuota("codex", force);
async function getProviderQuota(provider, force = false) {
    const current = cache.get(provider);
    if (!force && current && Date.now() - current.updatedAt < CACHE_MS)
        return current;
    const running = inFlight.get(provider);
    if (running)
        return running;
    const request = fetchProvider(provider)
        .then((snapshot) => {
        cache.set(provider, snapshot);
        return snapshot;
    })
        .finally(() => { inFlight.delete(provider); });
    inFlight.set(provider, request);
    return request;
}
export const providerQuota = {
    async getProvider(provider, force = false) {
        return getProviderQuota(provider, force);
    },
    async get(force = false) {
        const providers = await Promise.all(QUOTA_PROVIDERS.map((provider) => getProviderQuota(provider, force)));
        return { updatedAt: Math.max(...providers.map((provider) => provider.updatedAt)), providers };
    },
};
