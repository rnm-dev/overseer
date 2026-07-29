import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { settings } from "./settings/index.js";
import { configDir } from "./xdgPaths.js";
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
const NO_CLI_CHECK = {
    ran: false,
    loggedIn: null,
    authMethod: null,
    email: null,
    error: null,
    checkedAt: null,
};
const NO_OBSERVED_ERROR = { broken: false, lastError: null, lastErrorAt: null };
function readObserved() {
    if (!existsSync(STATE_FILE))
        return { ...NO_OBSERVED_ERROR };
    try {
        const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
        return parsed.observed ?? { ...NO_OBSERVED_ERROR };
    }
    catch {
        return { ...NO_OBSERVED_ERROR };
    }
}
function persistObserved(observed) {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ observed }, null, 2));
}
let cliCheck = { ...NO_CLI_CHECK };
let observed = readObserved();
let timer = null;
// A best-effort guess at what an unauthenticated `claude -p` run says on
// stderr/in its final summary — not empirically verified against a real
// unauthenticated run (that would require revoking a live token). A false
// negative here just leaves the state at whatever it already was, so this
// list is safe to be incomplete; widen it once real failure text is
// observed in production.
const AUTH_FAILURE_PATTERNS = [
    /not authenticated/i,
    /unauthorized/i,
    /invalid api key/i,
    /please (run|log ?in|re-?authenticate)/i,
    /token (expired|invalid|revoked)/i,
    /authentication (required|failed|error)/i,
    /\boauth\b.*\b(error|invalid|expired|failed)\b/i,
];
// Runs `claude auth status --json`. Uses the same command name the daemon
// spawns sessions with (settings.agentCommand, default "claude"), resolved off
// the daemon's PATH. `claude auth status` exits non-zero only on a hard error,
// not on "logged out" — a logged-out CLI still exits 0 with loggedIn:false —
// but execFile rejects on non-zero exit, so we read stdout from the error too.
async function checkAuthStatus() {
    const checkedAt = Date.now();
    const command = settings.get().agentCommand || "claude";
    let stdout;
    try {
        ({ stdout } = await execFileAsync(command, ["auth", "status", "--json"], {
            timeout: STATUS_TIMEOUT_MS,
        }));
    }
    catch (err) {
        const e = err;
        // A non-zero exit can still carry the JSON body on stdout; try it before
        // giving up and treating this as "couldn't run".
        if (e.stdout && e.stdout.trim()) {
            stdout = e.stdout;
        }
        else {
            return { ...NO_CLI_CHECK, error: e.message ?? String(err), checkedAt };
        }
    }
    try {
        const parsed = JSON.parse(stdout);
        return {
            ran: true,
            loggedIn: typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : null,
            authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
            email: typeof parsed.email === "string" ? parsed.email : null,
            error: null,
            checkedAt,
        };
    }
    catch (err) {
        return { ...NO_CLI_CHECK, error: `unparseable output: ${err instanceof Error ? err.message : String(err)}`, checkedAt };
    }
}
const CHECK_INTERVAL_MS = 30_000;
function scheduleCheck() {
    if (timer)
        clearTimeout(timer);
    timer = setTimeout(() => {
        void refresh();
    }, CHECK_INTERVAL_MS);
}
async function refresh() {
    cliCheck = await checkAuthStatus();
    scheduleCheck();
}
export const claudeCodeAuth = {
    start() {
        void refresh();
    },
    isLikelyAuthFailure(text) {
        return AUTH_FAILURE_PATTERNS.some((re) => re.test(text));
    },
    recordPossibleAuthFailure(text, at) {
        observed = { broken: true, lastError: text.slice(0, 500), lastErrorAt: at };
        persistObserved(observed);
    },
    clearObservedFailure() {
        if (!observed.broken)
            return;
        observed = { ...NO_OBSERVED_ERROR };
        persistObserved(observed);
    },
    getState() {
        // A real observed failure always wins — a token can look present on disk /
        // in the Keychain and still have been revoked or rotated out from under it.
        const authState = observed.broken
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
