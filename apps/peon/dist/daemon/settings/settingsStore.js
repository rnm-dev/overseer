import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir } from "../xdgPaths.js";
import { ensurePrivateDirectory, secureExistingPrivateFile, writePrivateFileDurably, } from "../durablePrivateFile.js";
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
    fleetMode: "legacy-mesh",
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
        ensurePrivateDirectory(path.dirname(this.settingsPath));
        this.withWriteLock(() => {
            // Another daemon may have enrolled and persisted a fresh credential since
            // this instance was constructed. Merge the patch into the latest durable
            // value, never this process's potentially stale in-memory snapshot.
            const latest = this.read();
            const next = {
                ...latest,
                ...patch,
                // Deep-merge the one nested setting so a partial `{ ai: { ... } }` patch
                // keeps sibling ai fields rather than replacing the whole object.
                ...(patch.ai ? { ai: { ...latest.ai, ...patch.ai } } : {}),
            };
            this.writeAtomically(next);
            this.current = next;
        });
        return this.current;
    }
    read() {
        secureExistingPrivateFile(this.settingsPath);
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
        writePrivateFileDurably(this.settingsPath, JSON.stringify(value, null, 2));
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
            catch {
                // Lock cleanup is best effort and must not mask the settings write
                // result that controls credential handoff ordering.
            }
        }
    }
}
