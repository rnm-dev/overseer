import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import semver from "semver";
import { z } from "zod";
import { AtomicJsonStore } from "./armory/index.js";
import { settings } from "./settings/index.js";
import { stateDir } from "./xdgPaths.js";
import { isGitCheckout } from "../shared/repo.js";
import { backgroundSupervisor } from "../shared/backgroundSupervisor.js";
import { getAgentDriver, listAgentDrivers } from "./agents/index.js";
export function cliUpdateProviders() {
    return listAgentDrivers().filter((driver) => driver.services.cliUpdate).map((driver) => driver.id);
}
const operationSchema = z.object({
    id: z.string(),
    status: z.enum(["running", "succeeded", "failed", "interrupted"]),
    startedAt: z.number(),
    finishedAt: z.number().nullable(),
    pid: z.number().int().positive().nullable(),
    fromVersion: z.string().nullable(),
    toVersion: z.string().nullable(),
    error: z.string().nullable(),
    logPath: z.string(),
});
const providerStateSchema = z.object({
    currentVersion: z.string().nullable(),
    latestVersion: z.string().nullable(),
    updateAvailable: z.boolean().nullable(),
    checkedAt: z.number().nullable(),
    checkError: z.string().nullable(),
    operation: operationSchema.nullable(),
});
const stateSchema = z.object({
    schemaVersion: z.literal(1),
    providers: z.record(z.string(), providerStateSchema),
});
function emptyProvider() {
    return { currentVersion: null, latestVersion: null, updateAvailable: null, checkedAt: null, checkError: null, operation: null };
}
function defaults() {
    return { schemaVersion: 1, providers: Object.fromEntries(cliUpdateProviders().map((provider) => [provider, emptyProvider()])) };
}
const execFileAsync = promisify(execFile);
const CHECK_TTL_MS = 15 * 60_000;
export function parseCliVersion(output) {
    const match = output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/);
    return match && semver.valid(match[1]) ? match[1] : null;
}
async function run(command, args, timeout = 30_000) {
    const result = await execFileAsync(command, args, { timeout, maxBuffer: 1024 * 1024, env: process.env });
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}
export class CliUpdateError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export class CliUpdateManager {
    statePath;
    store;
    command;
    versionRunner;
    latestRunner;
    spawnWorker;
    now;
    startTail = Promise.resolve();
    constructor(options = {}) {
        this.statePath = options.statePath ?? path.join(stateDir(), "cli-updates.json");
        this.store = new AtomicJsonStore({ filePath: this.statePath, schema: stateSchema, defaults });
        this.command = options.command ?? ((provider) => {
            const driver = getAgentDriver(provider);
            if (!driver?.services.cliUpdate)
                throw new Error(`agent driver ${provider} does not support CLI updates`);
            return driver.command(settings.get());
        });
        this.versionRunner = options.versionRunner ?? ((command) => run(command, ["--version"]));
        this.latestRunner = options.latestRunner ?? (async (provider) => {
            const packageName = getAgentDriver(provider)?.services.cliUpdate?.packageName;
            if (!packageName)
                throw new Error(`agent driver ${provider} has no update package`);
            return parseCliVersion(await run("npm", ["view", packageName, "version", "--json"])) ?? "";
        });
        this.spawnWorker = options.spawnWorker ?? ((args, logPath) => {
            const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
            const worker = path.join(root, "dist/cli/agentCliUpdateWorker.js");
            if (backgroundSupervisor(isGitCheckout(root)) === "detached") {
                return spawn(process.execPath, [worker, ...args], {
                    detached: true,
                    stdio: ["ignore", openSync(logPath, "a"), openSync(logPath, "a")],
                    env: process.env,
                });
            }
            // On Linux, a plain detached process still belongs to the daemon's systemd cgroup
            // and would be killed by a service restart. A transient user unit gives
            // the updater independent supervision, while its durable state remains
            // readable by the replacement daemon process.
            const operationId = args[args.indexOf("--operation") + 1];
            return spawn("systemd-run", [
                "--user", "--collect", `--unit=peon-cli-update-${operationId}`,
                `--property=StandardOutput=append:${logPath}`,
                `--property=StandardError=append:${logPath}`,
                `--setenv=PATH=${process.env.PATH ?? ""}`,
                "--", process.execPath, worker, ...args,
            ], { detached: true, stdio: "ignore", env: process.env });
        });
        this.now = options.now ?? Date.now;
    }
    async reconcile() {
        const state = await this.store.update((current) => {
            for (const provider of cliUpdateProviders())
                current.providers[provider] ??= emptyProvider();
            return current;
        });
        let changed = false;
        for (const provider of cliUpdateProviders()) {
            const operation = state.providers[provider].operation;
            if (!operation || operation.status !== "running" || this.now() - operation.startedAt < 10_000)
                continue;
            let alive = false;
            if (operation.pid) {
                try {
                    process.kill(operation.pid, 0);
                    alive = true;
                }
                catch { /* not running */ }
            }
            if (!alive) {
                operation.status = "interrupted";
                operation.finishedAt = this.now();
                operation.error = "update worker exited before recording a result";
                changed = true;
            }
        }
        if (changed)
            await this.store.write(state);
        return state;
    }
    async refresh(provider) {
        const state = await this.reconcile();
        if (state.providers[provider].operation?.status === "running")
            return;
        let currentVersion = null;
        let latestVersion = null;
        const errors = [];
        try {
            currentVersion = parseCliVersion(await this.versionRunner(this.command(provider)));
        }
        catch (error) {
            errors.push(`current version: ${safeError(error)}`);
        }
        if (!currentVersion && errors.length === 0)
            errors.push("current version: unrecognized version output");
        try {
            latestVersion = parseCliVersion(await this.latestRunner(provider));
        }
        catch (error) {
            errors.push(`latest version: ${safeError(error)}`);
        }
        if (!latestVersion && errors.every((entry) => !entry.startsWith("latest version:")))
            errors.push("latest version: unrecognized registry response");
        await this.store.update((next) => {
            next.providers[provider] = {
                ...next.providers[provider], currentVersion, latestVersion,
                updateAvailable: currentVersion && latestVersion ? semver.gt(latestVersion, currentVersion) : null,
                checkedAt: this.now(), checkError: errors.length ? errors.join("; ") : null,
            };
            return next;
        });
    }
    async get(provider, refresh = false) {
        const candidates = provider ? [provider] : cliUpdateProviders();
        const before = await this.reconcile();
        await Promise.all(candidates
            .filter((item) => refresh || before.providers[item].checkedAt === null || this.now() - before.providers[item].checkedAt >= CHECK_TTL_MS)
            .map((item) => this.refresh(item)));
        const state = await this.reconcile();
        const selected = candidates;
        let updatedAt = null;
        for (const item of selected) {
            const checkedAt = state.providers[item].checkedAt;
            if (checkedAt !== null && (updatedAt === null || checkedAt > updatedAt))
                updatedAt = checkedAt;
        }
        return {
            updatedAt,
            providers: selected.map((item) => ({ provider: item, ...state.providers[item] })),
        };
    }
    start(provider) {
        const operation = this.startTail.then(() => this.startSerialized(provider));
        this.startTail = operation.catch(() => undefined);
        return operation;
    }
    async startSerialized(provider) {
        await this.refresh(provider);
        const state = await this.reconcile();
        const current = state.providers[provider];
        if (current.operation?.status === "running")
            throw new CliUpdateError("UPDATE_IN_PROGRESS", `${provider} update is already running`);
        if (current.updateAvailable === false)
            throw new CliUpdateError("NO_UPDATE_AVAILABLE", `${provider} is already up to date`);
        const id = randomUUID();
        const logPath = path.join(stateDir(), "cli-updates", `${id}.log`);
        mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
        const operation = {
            id, status: "running", startedAt: this.now(), finishedAt: null, pid: null,
            fromVersion: current.currentVersion, toVersion: null, error: null, logPath,
        };
        await this.store.update((next) => { next.providers[provider].operation = operation; return next; });
        try {
            const child = this.spawnWorker(["--provider", provider, "--command", this.command(provider), "--state", this.statePath, "--operation", id], logPath);
            child.unref();
            child.once("error", (error) => void this.failStart(provider, id, error));
            return operation;
        }
        catch (error) {
            await this.failStart(provider, id, error);
            throw new CliUpdateError("UPDATE_START_FAILED", safeError(error));
        }
    }
    async failStart(provider, id, error) {
        await this.store.update((state) => {
            const operation = state.providers[provider].operation;
            if (operation?.id === id && operation.status === "running") {
                operation.status = "failed";
                operation.finishedAt = this.now();
                operation.error = safeError(error);
            }
            return state;
        });
    }
}
export function safeError(error) {
    return error instanceof Error ? error.message : String(error);
}
export const cliUpdates = new CliUpdateManager();
export async function runCliUpdateWorker(input) {
    const store = new AtomicJsonStore({ filePath: input.statePath, schema: stateSchema, defaults });
    await store.update((state) => {
        const operation = state.providers[input.provider].operation;
        if (!operation || operation.id !== input.operationId || operation.status !== "running")
            throw new Error("update operation is no longer active");
        operation.pid = process.pid;
        return state;
    });
    try {
        await run(input.command, ["update"], 30 * 60_000);
        const version = parseCliVersion(await run(input.command, ["--version"]));
        await store.update((state) => {
            const provider = state.providers[input.provider];
            const operation = provider.operation;
            if (!operation || operation.id !== input.operationId)
                return state;
            operation.status = "succeeded";
            operation.finishedAt = Date.now();
            operation.toVersion = version;
            provider.currentVersion = version;
            provider.updateAvailable = version && provider.latestVersion ? semver.gt(provider.latestVersion, version) : null;
            provider.checkedAt = Date.now();
            provider.checkError = version ? null : "update completed but the installed version could not be read";
            return state;
        });
    }
    catch (error) {
        await store.update((state) => {
            const operation = state.providers[input.provider].operation;
            if (operation?.id === input.operationId) {
                operation.status = "failed";
                operation.finishedAt = Date.now();
                operation.error = safeError(error);
            }
            return state;
        });
        throw error;
    }
}
