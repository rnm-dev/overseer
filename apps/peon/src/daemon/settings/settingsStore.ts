import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DaemonSettings } from "./settingsTypes.js";
import { configDir } from "../xdgPaths.js";
import {
  ensurePrivateDirectory,
  secureExistingPrivateFile,
  writePrivateFileDurably,
} from "../durablePrivateFile.js";

const SETTINGS_PATH = path.join(configDir(), "settings.json");

function assertTestWriteIsIsolated(settingsPath: string): void {
  const runningTests = Boolean(
    process.env.NODE_TEST_CONTEXT
    || process.env.PEON_TEST_RUN
    || process.argv.some((arg) => /\.test\.[cm]?[jt]s$/.test(arg)),
  );
  if (!runningTests) return;

  const relative = path.relative(os.tmpdir(), path.resolve(settingsPath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `refusing to write Peon settings outside the OS temp directory during tests: ${settingsPath}`,
    );
  }
}

const DEFAULT_SETTINGS: DaemonSettings = {
  updateCheckIntervalMs: 15 * 60_000,
  maxTurns: 300,
  taskTimeoutMs: 30 * 60_000,
  paused: false,
  defaultAgent: "claude-code",
  agentCommand: "claude",
  codexCommand: "codex",
  maxBudgetUsd: 0,
  publicControlUrl: `http://127.0.0.1:${process.env.ACA_CONTROL_PORT ?? 4570}`,
  listenAddress: `0.0.0.0:${process.env.ACA_CONTROL_PORT ?? 4570}`,
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
  private current: DaemonSettings;

  constructor(private readonly settingsPath = SETTINGS_PATH) {
    this.current = this.read();
  }

  get(): DaemonSettings {
    return this.current;
  }

  update(patch: Partial<DaemonSettings>): DaemonSettings {
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

  private read(): DaemonSettings {
    secureExistingPrivateFile(this.settingsPath);
    const fromFile = existsSync(this.settingsPath)
      ? JSON.parse(readFileSync(this.settingsPath, "utf8")) as Partial<DaemonSettings>
      : {};
    // `codex` was the retired `codex exec --json` driver. Its model catalog is
    // shared with app-server, so the configured model/effort remain valid.
    if (fromFile.defaultAgent === "codex") fromFile.defaultAgent = "codex-app-server";
    // Fleet HTTP is the only topology now. Ignore retired topology switches
    // from older settings files; the next update persists a clean document.
    delete (fromFile as unknown as Record<string, unknown>).fleetMode;
    delete (fromFile as unknown as Record<string, unknown>).publicDashboardUrl;
    const legacy = fromFile as unknown as Record<string, unknown>;
    if (typeof fromFile.listenAddress !== "string" && typeof legacy.bindHost === "string") {
      let port = Number(process.env.ACA_CONTROL_PORT ?? 4570);
      try {
        port = Number(new URL(fromFile.publicControlUrl ?? "").port) || port;
      } catch {
        // Keep the legacy/default control port.
      }
      fromFile.listenAddress = `${legacy.bindHost.includes(":") ? `[${legacy.bindHost}]` : legacy.bindHost}:${port}`;
    }
    delete legacy.bindHost;
    return {
      ...DEFAULT_SETTINGS,
      ...fromFile,
      // `ai` is the one nested (object-valued) setting; the top-level spread is
      // shallow, so deep-merge it here — an on-disk file written before a new
      // ai sub-key existed still inherits that key's default instead of a hole.
      ai: { ...DEFAULT_SETTINGS.ai, ...(fromFile.ai ?? {}) },
    };
  }

  private writeAtomically(value: DaemonSettings): void {
    writePrivateFileDurably(this.settingsPath, JSON.stringify(value, null, 2));
  }

  private withWriteLock<T>(operation: () => T): T {
    const lockPath = `${this.settingsPath}.lock`;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    let acquired = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30_000) rmdirSync(lockPath);
        } catch (staleError) {
          if (!["ENOENT", "ENOTEMPTY"].includes((staleError as NodeJS.ErrnoException).code ?? "")) {
            throw staleError;
          }
        }
        Atomics.wait(sleeper, 0, 0, 10);
      }
    }
    if (!acquired) throw new Error(`timed out acquiring settings lock: ${lockPath}`);
    try {
      return operation();
    } finally {
      try {
        rmdirSync(lockPath);
      } catch {
        // Lock cleanup is best effort and must not mask the settings write
        // result that controls credential handoff ordering.
      }
    }
  }
}
