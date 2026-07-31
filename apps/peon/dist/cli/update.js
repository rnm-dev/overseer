#!/usr/bin/env node
// Self-update, in one of two shapes depending on how peon is installed (see isGitCheckout):
//
//   - Source checkout (dev / `npm run dev`): `git fetch` + `git merge --ff-only`
//     this checkout to origin/<branch>,
//     without restarting the running daemon. The committed dist/ arrives with src/ in the same
//     pull, so there's nothing to npm-install or stamp; the operator restarts the dev harness when
//     it is safe for daemon changes to take effect.
//     See gitCheckoutUpdate.
//
//   - Global install (production, launchd/systemd-managed): check no session is running -> resolve the
//     latest version from the public npm registry -> install that exact package version ->
//     syntax-check compiled output -> restart
//     daemon service and wait for it. Before replacement, pack the current installation
//     locally so either a failed sanity check or a failed restart can roll back without GitHub or
//     network access. npm performs its normal package integrity verification.
//
// Runnable two ways: spawned by POST /api/v1/control/update (detached on macOS/checkouts; via
// systemd-run for global Linux installs, so the restart doesn't kill this script along with the
// daemon's cgroup), or directly by a human (`npm run update` / `tsx src/cli/update.ts`) — so it repeats the
// session-guard check independently rather than trusting the caller already did it. In an installed
// tree it runs as compiled JS (dist/cli/update.js) under plain node — no tsx at runtime.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { isGitCheckout } from "../shared/repo.js";
import { fetchLatestNpmRelease, peonNpmSpec } from "../shared/npmRegistry.js";
import { readUpdateCommandReceipt, writeUpdateCommandReceipt } from "../daemon/updateCommandReceipt.js";
import { readUpdateRuntimeIdentity, updateRuntimeIdentityPath, writeUpdateRuntimeIdentity, } from "../daemon/updateRuntimeIdentity.js";
import { globalInstallArgs, rollbackPackArgs } from "./npmGlobalInstall.js";
import { daemonRestartCommand, printDaemonServiceStatus, restartDaemonService, } from "./serviceControl.js";
import { configDir } from "../daemon/xdgPaths.js";
import { parseListenAddress } from "../shared/listenAddress.js";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function configuredControlPort() {
    try {
        const raw = JSON.parse(readFileSync(path.join(configDir(), "settings.json"), "utf8"));
        if (typeof raw.listenAddress === "string")
            return parseListenAddress(raw.listenAddress).port;
    }
    catch {
        // Missing and pre-listenAddress settings use the stable default.
    }
    return Number(process.env.ACA_CONTROL_PORT ?? 4570);
}
const CONTROL_API = `http://127.0.0.1:${configuredControlPort()}`;
const FORCE = process.env.FORCE === "1";
const UPDATE_COMMAND_ID = process.env.PEON_UPDATE_COMMAND_ID || null;
const EXPECTED_VERSION = process.env.PEON_UPDATE_EXPECTED_VERSION || null;
const EXPECTED_REVISION = process.env.PEON_UPDATE_EXPECTED_REVISION || null;
const EXPECTED_SHA256 = process.env.PEON_UPDATE_EXPECTED_SHA256 || null;
const INITIATOR_PID = Number(process.env.PEON_UPDATE_INITIATOR_PID);
function commandReceipt(state, code) {
    if (!UPDATE_COMMAND_ID)
        return;
    writeUpdateCommandReceipt({
        version: 1,
        commandId: UPDATE_COMMAND_ID,
        expectedVersion: EXPECTED_VERSION,
        expectedRevision: EXPECTED_REVISION,
        expectedSha256: EXPECTED_SHA256,
        initiatorPid: Number.isSafeInteger(INITIATOR_PID) && INITIATOR_PID > 0 ? INITIATOR_PID : process.ppid,
        state,
        ...(code ? { code } : {}),
        updatedAt: Date.now(),
    });
}
// npm ships alongside node (…/bin/node → …/lib/node_modules/npm/bin/npm-cli.js).
// Resolve it absolutely and run it through *this* node so the update never
// depends on `npm` being on PATH — the daemon launches this in a `systemd-run
// --user` transient unit whose PATH is the minimal /usr/bin default, which
// excludes an nvm/volta/fnm bin dir. A bare `npm` throws `spawnSync npm ENOENT`
// there before anything is pulled or restarted; even npm's own
// `#!/usr/bin/env node` shebang would re-hit that empty PATH. Passing npm-cli.js
// as a script arg to node.execPath sidesteps both lookups. (Node's dir is still
// prepended to the child PATH so the `git` npm spawns for the clone, and any
// node it re-invokes, resolve too — without assuming the caller's PATH had it.)
const NODE_BIN_DIR = path.dirname(process.execPath);
const NPM_CLI = path.resolve(NODE_BIN_DIR, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
function run(cmd, args, cwd = PACKAGE_ROOT) {
    execFileSync(cmd, args, { cwd, stdio: "inherit" });
}
function npmInstallGlobal(spec) {
    const env = { ...process.env, PATH: `${NODE_BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}` };
    const args = globalInstallArgs(PACKAGE_ROOT, spec);
    if (existsSync(NPM_CLI)) {
        execFileSync(process.execPath, [NPM_CLI, ...args], { cwd: PACKAGE_ROOT, stdio: "inherit", env });
    }
    else {
        // Unusual layout (npm not beside node) — fall back to PATH resolution, now
        // at least with node's own dir prepended.
        execFileSync("npm", args, { cwd: PACKAGE_ROOT, stdio: "inherit", env });
    }
}
function npmPackCurrent(destination) {
    const env = { ...process.env, PATH: `${NODE_BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}` };
    const args = rollbackPackArgs(PACKAGE_ROOT, destination);
    try {
        const stdout = existsSync(NPM_CLI)
            ? execFileSync(process.execPath, [NPM_CLI, ...args], { cwd: PACKAGE_ROOT, encoding: "utf8", env })
            : execFileSync("npm", args, { cwd: PACKAGE_ROOT, encoding: "utf8", env });
        const packed = JSON.parse(stdout);
        if (typeof packed[0]?.filename !== "string")
            throw new Error("npm pack did not return an archive filename");
        return path.join(destination, packed[0].filename);
    }
    catch (err) {
        throw new Error("could not pack the current installation for rollback", { cause: err });
    }
}
function installedVersion() {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    if (typeof pkg.version !== "string" || !semver.valid(pkg.version))
        throw new Error("installed package has an invalid version");
    return pkg.version;
}
function gitOut(args) {
    return execFileSync("git", args, { cwd: PACKAGE_ROOT, encoding: "utf8" }).trim();
}
// From-source update path (dev / `npm run dev`): fast-forward this checkout to origin/<branch>. The committed
// dist/ comes along with src/ in the same pull. The dev harness deliberately does not watch daemon
// source, so the pull cannot interrupt an in-flight session; the operator restarts it manually when
// safe. There is nothing to `npm install`, no install stamp, and no systemctl to call.
async function gitCheckoutUpdate() {
    const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
    console.log(`==> git fetch origin ${branch}`);
    run("git", ["fetch", "origin", branch]);
    const localSha = gitOut(["rev-parse", "HEAD"]);
    const remoteSha = gitOut(["rev-parse", `origin/${branch}`]);
    if (localSha === remoteSha && !FORCE) {
        console.log(`==> already on the latest commit (${localSha}) — nothing to do (FORCE=1 to re-pull anyway)`);
        return;
    }
    // --ff-only: only ever advance the checkout, never create a merge commit or clobber local work.
    // If this checkout has diverged (local commits not on origin, or a dirty tree in the way), the
    // pull fails loudly rather than silently rewriting a working tree someone may be developing in.
    console.log(`==> git merge --ff-only origin/${branch} (${localSha.slice(0, 7)} -> ${remoteSha.slice(0, 7)})`);
    run("git", ["merge", "--ff-only", `origin/${branch}`]);
    console.log("==> source checkout updated — daemon kept running");
    console.log("==> restart `npm run dev` manually when it is safe for daemon changes to take effect");
}
async function checkNoActiveSession() {
    console.log("==> checking for an active session");
    let running = 0;
    try {
        const body = (await (await fetch(`${CONTROL_API}/api/v1/sessions`)).json());
        running = body.sessions?.filter((s) => s.status === "running").length ?? 0;
    }
    catch {
        // control API unreachable — nothing to guard against, proceed
    }
    if (running > 0) {
        if (!FORCE) {
            console.error("refusing to update: a session is currently running (the restart below kills it)");
            console.error("cancel it first in Overseer (or POST /api/v1/sessions/<id>/cancel), or re-run with FORCE=1");
            process.exit(1);
        }
        console.warn("FORCE=1 set — updating anyway");
    }
}
async function waitFor(label, url, budgetSec) {
    for (let i = 0; i < budgetSec; i++) {
        try {
            const res = await fetch(url);
            if (res.ok)
                return true;
        }
        catch {
            // not up yet
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.error(`${label} did not come back within ${budgetSec}s`);
    return false;
}
// All compiled Node entry points under dist/ must parse as Node modules.
function listCompiledFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory())
            out.push(...listCompiledFiles(full));
        else if (entry.endsWith(".js"))
            out.push(full);
    }
    return out;
}
// Not a typecheck — that needs typescript + @types/node/@types/express/@types/multer, none of
// which a global install has (they're devDependencies, deliberately not shipped; see CLAUDE.md's
// "the peon CLI bin is compiled" section). Confirmed by testing: `npx tsc` on a real global
// install doesn't even resolve to the typescript package (there's an unrelated, unmaintained
// "tsc" package squatting that exact bin name on the registry, and npx installs *that* instead),
// and even disambiguating with `npx --package typescript` still fails immediately on every
// `process`/`Buffer`/`node:*` reference without @types/node. Since dist/ is what actually runs, a
// plain `node --check` (syntax only, zero extra dependencies) is what's actually meaningful here.
function checkCompiledOutput() {
    for (const file of listCompiledFiles(path.join(PACKAGE_ROOT, "dist"))) {
        run(process.execPath, ["--check", file]);
    }
}
// The updater packs the current global installation before replacing it. That archive is a
// local, credential-free rollback source and remains valid even when Overseer is unavailable.
function rollbackToDisk(previousArchive, previousIdentity) {
    console.error("==> rolling back to the previous local Peon release");
    try {
        npmInstallGlobal(previousArchive);
        if (previousIdentity)
            writeUpdateRuntimeIdentity(PACKAGE_ROOT, previousIdentity);
        else
            rmSync(updateRuntimeIdentityPath(PACKAGE_ROOT), { force: true });
        console.error("rolled back the previous Peon release on disk");
        return true;
    }
    catch (rollbackErr) {
        console.error("rollback itself failed — the disk install is left on the broken release:", rollbackErr);
        return false;
    }
}
async function main() {
    commandReceipt("running");
    // Two update shapes (see isGitCheckout): a source checkout fast-forwards with git without
    // restarting the daemon; a global install reinstalls with npm and restarts via launchd/systemd.
    // The npm path below can't work from a checkout because npm install -g would not touch the
    // running tree, so a checkout always takes the git path.
    if (isGitCheckout(PACKAGE_ROOT)) {
        await gitCheckoutUpdate();
        commandReceipt("ready_to_attest");
        return;
    }
    await checkNoActiveSession();
    const currentVersion = installedVersion();
    let release;
    try {
        release = await fetchLatestNpmRelease();
    }
    catch (error) {
        commandReceipt("failed", "REGISTRY_UNAVAILABLE");
        throw error;
    }
    if (!FORCE && !semver.gt(release.version, currentVersion)) {
        console.log(`==> already up to date (${currentVersion}; latest ${release.version})`);
        commandReceipt("failed", "NO_UPDATE");
        return;
    }
    if (EXPECTED_VERSION !== null && EXPECTED_VERSION !== release.version) {
        console.error("refusing update: npm latest changed before installation");
        commandReceipt("failed", "RELEASE_CHANGED");
        process.exitCode = 1;
        return;
    }
    const temporaryDir = mkdtempSync(path.join(os.tmpdir(), "peon-update-"));
    try {
        const previousArchive = npmPackCurrent(temporaryDir);
        const previousIdentity = readUpdateRuntimeIdentity(PACKAGE_ROOT);
        console.log(`==> installing ${peonNpmSpec(release.version)} from the public npm registry`);
        try {
            npmInstallGlobal(peonNpmSpec(release.version));
            console.log("==> sanity-checking the compiled output");
            checkCompiledOutput();
            rmSync(updateRuntimeIdentityPath(PACKAGE_ROOT), { force: true });
        }
        catch (err) {
            console.error("the new release failed installation or compiled-output validation:", err);
            const rolledBack = rollbackToDisk(previousArchive, previousIdentity);
            commandReceipt("failed", rolledBack ? "INSTALL_FAILED_ROLLED_BACK" : "INSTALL_FAILED_ROLLBACK_FAILED");
            process.exitCode = 1;
            return;
        }
        // The replacement daemon verifies these expected attestation inputs against
        // its own running package before it completes the durable command.
        commandReceipt("ready_to_attest");
        const daemonService = daemonRestartCommand();
        console.log(`==> restarting ${daemonService.displayName}`);
        try {
            restartDaemonService();
        }
        catch (err) {
            console.error("the new release could not restart the Peon service:", err);
            const rolledBack = rollbackToDisk(previousArchive, previousIdentity);
            let rollbackRestarted = false;
            try {
                restartDaemonService();
                rollbackRestarted = true;
            }
            catch (restartErr) {
                console.error("restarting into the rolled-back release also failed:", restartErr);
            }
            commandReceipt("failed", rolledBack && rollbackRestarted
                ? "RESTART_FAILED_ROLLED_BACK"
                : "RESTART_FAILED_ROLLBACK_FAILED");
            process.exitCode = 1;
            return;
        }
        console.log("==> waiting for the daemon to come back");
        const budgetSec = 90;
        const controlUp = await waitFor("control API", `${CONTROL_API}/api/v1/status`, budgetSec);
        if (!controlUp) {
            try {
                printDaemonServiceStatus();
            }
            catch {
                // Status exits non-zero for a failed unit; its output is still useful diagnostics.
            }
            console.error("==> the new release did not come back up — rolling back and restarting");
            const rolledBack = rollbackToDisk(previousArchive, previousIdentity);
            let rollbackRestarted = false;
            try {
                restartDaemonService();
                rollbackRestarted = true;
            }
            catch (err) {
                console.error("restarting into the rolled-back release also failed:", err);
            }
            commandReceipt("failed", rolledBack && rollbackRestarted
                ? "RESTART_TIMEOUT_ROLLED_BACK"
                : "RESTART_TIMEOUT_ROLLBACK_FAILED");
            process.exitCode = 1;
            return;
        }
        console.log("==> back up");
        commandReceipt("ready_to_attest");
        console.log(await (await fetch(`${CONTROL_API}/api/v1/status`)).json());
    }
    finally {
        rmSync(temporaryDir, { recursive: true, force: true });
    }
}
main().catch((err) => {
    const receipt = readUpdateCommandReceipt();
    if (!UPDATE_COMMAND_ID || receipt?.commandId !== UPDATE_COMMAND_ID || receipt.state !== "failed") {
        commandReceipt("failed", "UPDATE_FAILED");
    }
    console.error(err);
    process.exit(1);
});
