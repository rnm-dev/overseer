import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import semver from "semver";
import { settings } from "../settings/index.js";
import { REPO_GIT_URL, readLocalSha, isGitCheckout } from "../../shared/repo.js";
import { fetchLatestNpmRelease } from "../../shared/npmRegistry.js";
const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GIT_TIMEOUT_MS = 30_000;
const defaultReadSettings = () => settings.getUpdateCheckerSettings();
async function readRemoteSha() {
    // No local clone needed — a bare `ls-remote` gets HEAD's sha over the network, which is
    // all that's needed to compare against install-info.json's recorded sha.
    const { stdout } = await execFileAsync("git", ["ls-remote", REPO_GIT_URL, "HEAD"], { timeout: GIT_TIMEOUT_MS });
    const sha = stdout.split(/\s+/)[0];
    if (!sha)
        throw new Error(`unexpected "git ls-remote" output: ${JSON.stringify(stdout)}`);
    return sha;
}
function packageVersion() {
    const parsed = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    if (typeof parsed.version !== "string" || !semver.valid(parsed.version))
        throw new Error("installed package has an invalid version");
    return parsed.version;
}
// True when the local HEAD already contains `sha` (i.e. HEAD is up-to-date with
// or *ahead* of it). `merge-base --is-ancestor` exits 0 when `sha` is reachable
// from HEAD, non-zero otherwise — including exit 128 when `sha` isn't in the
// local object store at all (a genuinely newer remote commit), which is exactly
// the "not contained" case. Only meaningful in a git checkout.
async function headContains(sha) {
    try {
        await execFileAsync("git", ["-C", PACKAGE_ROOT, "merge-base", "--is-ancestor", sha, "HEAD"], { timeout: GIT_TIMEOUT_MS });
        return true;
    }
    catch {
        return false;
    }
}
function createUpdateChecker(options = {}) {
    const readSettings = options.readSettings ?? defaultReadSettings;
    const state = {
        updateAvailable: false,
        currentVersion: null,
        latestVersion: null,
        currentRevision: null,
        latestRevision: null,
        checkedAt: null,
        error: null,
    };
    let timer = null;
    let checkInFlight = null;
    function runCheck() {
        if (checkInFlight)
            return checkInFlight;
        checkInFlight = (async () => {
            try {
                if (!isGitCheckout(PACKAGE_ROOT)) {
                    const currentVersion = packageVersion();
                    const release = await fetchLatestNpmRelease();
                    Object.assign(state, {
                        currentVersion,
                        latestVersion: release.version,
                        currentRevision: null,
                        latestRevision: null,
                        updateAvailable: semver.gt(release.version, currentVersion),
                        checkedAt: Date.now(),
                        error: null,
                    });
                    return;
                }
                const localSha = readLocalSha(PACKAGE_ROOT);
                const remoteSha = await readRemoteSha();
                // "differs" is the base signal. But a git checkout (a dev box) is routinely
                // *ahead* of origin — local commits not yet pushed — which must NOT read as
                // "update available". There it's a real update only when HEAD doesn't already
                // contain the remote commit (behind, or the remote moved). A global install
                // has no local history to be ahead of, so the plain sha comparison stands.
                let updateAvailable = localSha !== null && localSha !== remoteSha;
                if (updateAvailable && isGitCheckout(PACKAGE_ROOT)) {
                    updateAvailable = !(await headContains(remoteSha));
                }
                Object.assign(state, {
                    currentVersion: packageVersion(),
                    latestVersion: null,
                    currentRevision: localSha,
                    latestRevision: remoteSha,
                    updateAvailable,
                    checkedAt: Date.now(),
                    error: null,
                });
            }
            catch (err) {
                state.error = err instanceof Error ? err.message : String(err);
                state.checkedAt = Date.now();
            }
        })().finally(() => {
            checkInFlight = null;
        });
        return checkInFlight;
    }
    function scheduleCheck() {
        if (timer)
            clearTimeout(timer);
        const intervalMs = Math.max(1_000, readSettings().updateCheckIntervalMs);
        timer = setTimeout(async () => {
            await runCheck();
            scheduleCheck();
        }, intervalMs);
    }
    return {
        async start() {
            await runCheck();
            scheduleCheck();
        },
        getState() {
            return state;
        },
        // Manual callers share the scheduled check's in-flight promise. This both
        // avoids duplicate git traffic and ensures every caller observes the newly
        // completed state instead of one concurrent caller receiving stale cache.
        checkNow() {
            return runCheck();
        },
    };
}
export const updateChecker = createUpdateChecker();
