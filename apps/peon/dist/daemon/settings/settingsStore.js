import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir } from "../xdgPaths.js";
const SETTINGS_PATH = path.join(configDir(), "settings.json");
function assertTestWriteIsIsolated(settingsPath) {
    const runningTests = Boolean(process.env.NODE_TEST_CONTEXT
        || process.env.PEON_TEST_RUN
        || process.argv.some((arg) => /\.test\.[cm]?[jt]s$/.test(arg)));
    if (!runningTests)
        return;
    const relative = path.relative(os.tmpdir(), path.resolve(settingsPath));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`refusing to write Peon settings outside the OS temp directory during tests: ${settingsPath}`);
    }
}
const DEFAULT_SETTINGS = {
    updateCheckIntervalMs: 15 * 60_000,
    maxTurns: 300,
    taskTimeoutMs: 30 * 60_000,
    paused: false,
    defaultAgent: "claude-code",
    agentCommand: "claude",
    codexCommand: "codex",
    maxBudgetUsd: 0,
    publicControlUrl: `http://127.0.0.1:${process.env.ACA_CONTROL_PORT ?? 4570}`,
    publicDashboardUrl: `http://127.0.0.1:${process.env.ACA_DASHBOARD_PORT ?? 4571}`,
    bindHost: "127.0.0.1",
    name: "",
    autoResumeInterrupted: true,
    overseerToken: "",
    fileTransferRoot: "",
    overseerUrl: "",
    peonId: "",
    heartbeatIntervalMs: 15_000,
    pairingSecret: "",
    pairingSecretExpiresAt: 0,
    pairingTtlMs: 15 * 60_000,
    ai: { defaultModel: "claude-sonnet-5", defaultReasoningEffort: "high", soul: "" },
};
export class SettingsStore {
    settingsPath;
    current;
    constructor(settingsPath = SETTINGS_PATH) {
        this.settingsPath = settingsPath;
        this.current = this.read();
    }
    get() {
        return this.current;
    }
    update(patch) {
        assertTestWriteIsIsolated(this.settingsPath);
        mkdirSync(path.dirname(this.settingsPath), { recursive: true });
        this.withWriteLock(() => {
            // Another daemon may have enrolled and persisted a fresh credential since
            // this instance was constructed. Merge the patch into the latest durable
            // value, never this process's potentially stale in-memory snapshot.
            const latest = this.read();
            this.current = {
                ...latest,
                ...patch,
                // Deep-merge the one nested setting so a partial `{ ai: { ... } }` patch
                // keeps sibling ai fields rather than replacing the whole object.
                ...(patch.ai ? { ai: { ...latest.ai, ...patch.ai } } : {}),
            };
            this.writeAtomically(this.current);
        });
        return this.current;
    }
    read() {
        const fromFile = existsSync(this.settingsPath)
            ? JSON.parse(readFileSync(this.settingsPath, "utf8"))
            : {};
        return {
            ...DEFAULT_SETTINGS,
            ...fromFile,
            // `ai` is the one nested (object-valued) setting; the top-level spread is
            // shallow, so deep-merge it here — an on-disk file written before a new
            // ai sub-key existed still inherits that key's default instead of a hole.
            ai: { ...DEFAULT_SETTINGS.ai, ...(fromFile.ai ?? {}) },
        };
    }
    writeAtomically(value) {
        const temporary = `${this.settingsPath}.${process.pid}.${Date.now()}.tmp`;
        try {
            writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
            renameSync(temporary, this.settingsPath);
        }
        finally {
            try {
                unlinkSync(temporary);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
    }
    withWriteLock(operation) {
        const lockPath = `${this.settingsPath}.lock`;
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        let acquired = false;
        for (let attempt = 0; attempt < 200; attempt++) {
            try {
                mkdirSync(lockPath, { mode: 0o700 });
                acquired = true;
                break;
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
                try {
                    if (Date.now() - statSync(lockPath).mtimeMs > 30_000)
                        rmdirSync(lockPath);
                }
                catch (staleError) {
                    if (!["ENOENT", "ENOTEMPTY"].includes(staleError.code ?? "")) {
                        throw staleError;
                    }
                }
                Atomics.wait(sleeper, 0, 0, 10);
            }
        }
        if (!acquired)
            throw new Error(`timed out acquiring settings lock: ${lockPath}`);
        try {
            return operation();
        }
        finally {
            try {
                rmdirSync(lockPath);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
    }
}
