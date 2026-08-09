import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { settings } from "../settings/index.js";
import { configDir } from "../runtime/xdgPaths.js";

const execFileAsync = promisify(execFile);

// Whether `claude` is logged in is asked of the CLI directly —
// `claude auth status --json` reports `{ "loggedIn": true, ... }` and exits 0.
// This is the only platform-agnostic signal: on Linux the OAuth token lives in
// ~/.claude/.credentials.json, but on macOS it lives in the login Keychain and
// no such file exists, so an earlier file-existence heuristic reported a false
// "not connected" on any Mac. The CLI knows where its own credentials are, so
// we let it answer. (`claude auth status` didn't exist when this was first
// written — it does now.)
const STATUS_TIMEOUT_MS = 10_000;

// Only the observed-failure half is persisted (see below) — this lives under
// peon's own config dir, not Claude Code's.
const STATE_FILE = path.join(configDir(), "claudeCodeAuthState.json");

export type ClaudeCodeAuthState = "ok" | "unauthenticated" | "broken" | "unknown";

interface CliCheck {
  // false when `claude auth status` couldn't be run at all (binary missing,
  // timeout, unparseable output) — distinct from ran-but-not-logged-in.
  ran: boolean;
  loggedIn: boolean | null;
  authMethod: string | null;
  email: string | null;
  error: string | null;
  checkedAt: number | null;
}

interface ObservedError {
  broken: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
}

interface PersistedObserved {
  observed: ObservedError;
}

const NO_CLI_CHECK: CliCheck = {
  ran: false,
  loggedIn: null,
  authMethod: null,
  email: null,
  error: null,
  checkedAt: null,
};
const NO_OBSERVED_ERROR: ObservedError = { broken: false, lastError: null, lastErrorAt: null };

function readObserved(): ObservedError {
  if (!existsSync(STATE_FILE)) return { ...NO_OBSERVED_ERROR };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as PersistedObserved;
    return parsed.observed ?? { ...NO_OBSERVED_ERROR };
  } catch {
    return { ...NO_OBSERVED_ERROR };
  }
}

function persistObserved(observed: ObservedError): void {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ observed } satisfies PersistedObserved, null, 2));
}

let cliCheck: CliCheck = { ...NO_CLI_CHECK };
let observed: ObservedError = readObserved();
let timer: ReturnType<typeof setTimeout> | null = null;

// A best-effort guess at what an unauthenticated `claude -p` run says on
// stderr/in its final summary — not empirically verified against a real
// unauthenticated run (that would require revoking a live token). A false
// negative here just leaves the state at whatever it already was, so this
// list is safe to be incomplete; widen it once real failure text is
// observed in production.
const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /not authenticated/i,
  /unauthorized/i,
  /invalid api key/i,
  /please (run|log ?in|re-?authenticate)/i,
  /token (expired|invalid|revoked)/i,
  /authentication (required|failed|error)/i,
  /\boauth\b.*\b(error|invalid|expired|failed)\b/i,
];

interface AuthStatusJson {
  loggedIn?: boolean;
  authMethod?: string;
  email?: string;
}

// Runs `claude auth status --json`. Uses the same command name the daemon
// spawns sessions with (settings.agentCommand, default "claude"), resolved off
// the daemon's PATH. `claude auth status` exits non-zero only on a hard error,
// not on "logged out" — a logged-out CLI still exits 0 with loggedIn:false —
// but execFile rejects on non-zero exit, so we read stdout from the error too.
async function checkAuthStatus(): Promise<CliCheck> {
  const checkedAt = Date.now();
  const command = settings.get().agentCommand || "claude";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command, ["auth", "status", "--json"], {
      timeout: STATUS_TIMEOUT_MS,
    }));
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    // A non-zero exit can still carry the JSON body on stdout; try it before
    // giving up and treating this as "couldn't run".
    if (e.stdout && e.stdout.trim()) {
      stdout = e.stdout;
    } else {
      return { ...NO_CLI_CHECK, error: e.message ?? String(err), checkedAt };
    }
  }
  try {
    const parsed = JSON.parse(stdout) as AuthStatusJson;
    return {
      ran: true,
      loggedIn: typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : null,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
      error: null,
      checkedAt,
    };
  } catch (err) {
    return { ...NO_CLI_CHECK, error: `unparseable output: ${err instanceof Error ? err.message : String(err)}`, checkedAt };
  }
}

const CHECK_INTERVAL_MS = 30_000;

function scheduleCheck(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void refresh();
  }, CHECK_INTERVAL_MS);
}

async function refresh(): Promise<void> {
  cliCheck = await checkAuthStatus();
  scheduleCheck();
}

export interface ClaudeCodeAuthStateShape {
  available: boolean;
  authState: ClaudeCodeAuthState;
  cliCheck: CliCheck;
  observed: ObservedError;
  checkedAt: number;
}

export const claudeCodeAuth = {
  start(): void {
    void refresh();
  },

  isLikelyAuthFailure(text: string): boolean {
    return AUTH_FAILURE_PATTERNS.some((re) => re.test(text));
  },

  recordPossibleAuthFailure(text: string, at: number): void {
    observed = { broken: true, lastError: text.slice(0, 500), lastErrorAt: at };
    persistObserved(observed);
  },

  clearObservedFailure(): void {
    if (!observed.broken) return;
    observed = { ...NO_OBSERVED_ERROR };
    persistObserved(observed);
  },

  getState(): ClaudeCodeAuthStateShape {
    // A real observed failure always wins — a token can look present on disk /
    // in the Keychain and still have been revoked or rotated out from under it.
    const authState: ClaudeCodeAuthState = observed.broken
      ? "broken"
      : !cliCheck.ran
        ? "unknown"
        : cliCheck.loggedIn === true
          ? "ok"
          : cliCheck.loggedIn === false
            ? "unauthenticated"
            : "unknown";

    return {
      available: cliCheck.ran || observed.lastErrorAt !== null,
      authState,
      cliCheck,
      observed,
      checkedAt: Date.now(),
    };
  },
};
