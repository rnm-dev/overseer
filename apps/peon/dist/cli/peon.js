#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDaemonUnit } from "./systemdUnits.js";
import { buildLaunchAgent } from "./launchdUnits.js";
const BASE = process.env.ACA_CONTROL_URL ?? "http://127.0.0.1:4570";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYSTEMD_USER_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const LAUNCHD_USER_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const STATE_DIR = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), ".peon");
const IS_MACOS = process.platform === "darwin";
// Where the daemon tees the detached updater's output — mirror the daemon's own
// `path.join(stateDir(), "update.log")` (see xdgPaths.ts) so `peon update` can
// read back what actually happened rather than reporting a blind success.
const UPDATE_LOG = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), ".peon", "update.log");
function updateLogSize() {
    try {
        return statSync(UPDATE_LOG).size;
    }
    catch {
        return 0; // no log yet
    }
}
// Only the bytes the updater appended after `offset` — i.e. this run's output,
// not the accumulation of every prior `peon update` in the append-only log.
function updateLogSince(offset) {
    try {
        return readFileSync(UPDATE_LOG).subarray(offset).toString("utf8").trim();
    }
    catch {
        return "";
    }
}
const USAGE = `peon — an autonomous Claude Code worker

usage: peon <command>

Service
  start                        install and start the background service (auto-starts on boot/login)
  stop                         stop the service
  restart [--force]            restart the service (--force overrides the running-session guard)
  status                       show running state and update status
  update [--force]             update Peon (dev checkouts require a later manual restart)

Runtime
  pause                        stop polling for new tasks
  resume                       resume polling
  session stop [id]            stop the running session (or a specific one by id)

Config
  settings [set <key> <value>] show all settings, or set one
Fleet
  pair <overseer-origin>              start outbound peon-claim-v1 enrollment
  pair --retry                       retry a parked enrollment after local recovery
  pair --legacy                       explicitly arm legacy inbound pairing
  credential rotate                   rotate an active peon-claim-v1 credential

Remote access
  remote                              show bind host and public URLs
  remote on [public-host] [--force]   accept remote connections and restart (bind 0.0.0.0)
                                        public-host may be a full URL (https://host) for a
                                        reverse proxy — no port is appended to the links then
  remote off [--force]                loopback only and restart (default)

`;
function coerce(value) {
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    if (value.trim() !== "" && !Number.isNaN(Number(value)))
        return Number(value);
    return value;
}
const DAEMON_UNIT = "peon-daemon.service";
const DAEMON_AGENT = "dev.peon.daemon";
function launchdTarget(label) {
    return `gui/${os.userInfo().uid}/${label}`;
}
function serviceRestartHint() {
    return IS_MACOS
        ? `launchctl kickstart -k ${launchdTarget(DAEMON_AGENT)}`
        : `systemctl --user restart ${DAEMON_UNIT}`;
}
function serviceStatusHint() {
    return IS_MACOS
        ? `launchctl print ${launchdTarget(DAEMON_AGENT)}\n  logs: ${path.join(STATE_DIR, "daemon.stderr.log")}`
        : `systemctl --user status ${DAEMON_UNIT}\n  journalctl --user -u ${DAEMON_UNIT} -e`;
}
function launchdLoaded(label) {
    try {
        execFileSync("launchctl", ["print", launchdTarget(label)], { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
function installLaunchAgent(label, plistPath) {
    if (launchdLoaded(label))
        return;
    execFileSync("launchctl", ["bootstrap", `gui/${os.userInfo().uid}`, plistPath], { stdio: "inherit" });
    execFileSync("launchctl", ["enable", launchdTarget(label)], { stdio: "inherit" });
}
function restartBackgroundServices() {
    if (IS_MACOS) {
        execFileSync("launchctl", ["kickstart", "-k", launchdTarget(DAEMON_AGENT)], { stdio: "inherit" });
    }
    else {
        execFileSync("systemctl", ["--user", "restart", DAEMON_UNIT], { stdio: "inherit" });
    }
}
function requireBinary(name, hint) {
    try {
        execFileSync(name, ["--version"], { stdio: "ignore" });
    }
    catch (err) {
        if (err.code === "ENOENT") {
            console.error(`peon start needs "${name}", which isn't on your PATH. ${hint}`);
            process.exit(1);
        }
        // exists but --version failed for some other reason — fine, it's present
    }
}
async function waitForUrl(url, budgetSec) {
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
    return false;
}
async function startCommand() {
    if (IS_MACOS) {
        requireBinary("launchctl", "launchd is required for a persistent Peon service on macOS.");
        const pathEnv = process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
        const daemonPlist = path.join(LAUNCHD_USER_DIR, `${DAEMON_AGENT}.plist`);
        mkdirSync(LAUNCHD_USER_DIR, { recursive: true });
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(daemonPlist, buildLaunchAgent({
            label: DAEMON_AGENT,
            description: "Peon daemon (control API)",
            peonHome: PACKAGE_ROOT,
            nodeBin: process.execPath,
            script: path.join(PACKAGE_ROOT, "dist", "daemon", "index.js"),
            pathEnv,
            portName: "ACA_CONTROL_PORT",
            port: 4570,
            stdoutPath: path.join(STATE_DIR, "daemon.stdout.log"),
            stderrPath: path.join(STATE_DIR, "daemon.stderr.log"),
        }));
        console.log("Zug zug!");
        console.log("==> installing launchd agents (auto-start at login, restart on failure)");
        try {
            installLaunchAgent(DAEMON_AGENT, daemonPlist);
        }
        catch {
            console.error(`\nsomething went wrong enabling the service — check:\n  ${serviceStatusHint()}`);
            process.exit(1);
        }
        console.log("==> waiting for it to come up (work work...)");
        const up = await waitForUrl(`${BASE}/api/v1/status`, 30);
        if (!up) {
            console.error(`peon didn't come up within 30s — check:\n  ${serviceStatusHint()}`);
            process.exit(1);
        }
        console.log(`\nWork work! peon is ready.\n\n  control : ${BASE}\n  UI      : use Overseer\n`);
        return;
    }
    requireBinary("systemctl", "peon needs a systemd user session to run as a persistent service — this doesn't look like one.");
    requireBinary("loginctl", "peon needs a systemd user session to run as a persistent service — this doesn't look like one.");
    const unitOptions = {
        peonHome: PACKAGE_ROOT,
        nodeBin: process.execPath,
        pathEnv: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    };
    console.log("Zug zug!");
    console.log("==> installing systemd user units");
    mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
    writeFileSync(path.join(SYSTEMD_USER_DIR, DAEMON_UNIT), buildDaemonUnit(unitOptions));
    console.log("==> starting peon (enabled to auto-start on boot/login)");
    try {
        execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
        execFileSync("systemctl", ["--user", "enable", "--now", DAEMON_UNIT], { stdio: "inherit" });
        execFileSync("loginctl", ["enable-linger", os.userInfo().username], { stdio: "inherit" });
    }
    catch {
        console.error(`\nsomething went wrong enabling the service — check the output above, or run:\n  systemctl --user status ${DAEMON_UNIT}`);
        process.exit(1);
    }
    console.log("==> waiting for it to come up (work work...)");
    const up = await waitForUrl(`${BASE}/api/v1/status`, 30);
    if (!up) {
        console.error(`peon didn't come up within 30s — check:\n  systemctl --user status ${DAEMON_UNIT}\n  journalctl --user -u ${DAEMON_UNIT} -e`);
        process.exit(1);
    }
    console.log(`
Work work! peon is ready to work.

  control : ${BASE}
  UI      : use Overseer
`);
}
async function stopCommand() {
    if (IS_MACOS) {
        console.log("==> stopping Peon launchd agents (no time for play...)");
        for (const label of [DAEMON_AGENT]) {
            if (!launchdLoaded(label))
                continue;
            execFileSync("launchctl", ["bootout", launchdTarget(label)], { stdio: "inherit" });
        }
        console.log(`stopped — me rest now. It'll start again on next login. To disable that too, remove:\n  ${LAUNCHD_USER_DIR}/${DAEMON_AGENT}.plist`);
        return;
    }
    console.log(`==> stopping ${DAEMON_UNIT} (no time for play...)`);
    execFileSync("systemctl", ["--user", "stop", DAEMON_UNIT], { stdio: "inherit" });
    console.log(`stopped — me rest now. It'll still start again on next boot/login — to prevent that too:\n  systemctl --user disable ${DAEMON_UNIT}`);
}
async function restartCommand(force) {
    // Same busy-session guard `/api/v1/control/update` and `peon remote` apply — a
    // restart SIGTERMs the whole cgroup, killing any in-flight `claude -p`
    // session with no way to recover it. --force (or FORCE=1) overrides.
    const RESTART_CMD = serviceRestartHint();
    try {
        const body = (await (await fetch(`${BASE}/api/v1/sessions`)).json());
        if (body.sessions?.some((s) => s.status === "running") && !force) {
            console.error(`a session is currently running — restarting kills it. Restart once it's done, or re-run with --force:\n  peon restart --force`);
            process.exit(1);
        }
    }
    catch {
        // control API unreachable — fall through and let the service manager report its own error
    }
    console.log(`==> restarting ${DAEMON_UNIT} (work work...)`);
    restartBackgroundServices();
    console.log("==> waiting for it to come back");
    const up = await waitForUrl(`${BASE}/api/v1/status`, 30);
    if (!up) {
        console.error(`peon didn't come back within 30s — check:\n  ${serviceStatusHint()}`);
        process.exit(1);
    }
    console.log("Ready to work!");
}
function formatUptime(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0)
        return `${h}h ${m}m`;
    if (m > 0)
        return `${m}m ${s}s`;
    return `${s}s`;
}
async function statusCommand() {
    let s;
    try {
        const res = await fetch(`${BASE}/api/v1/status`);
        if (!res.ok) {
            console.error(`peon answered but with an error (${res.status} ${res.statusText})`);
            process.exit(1);
        }
        s = (await res.json());
    }
    catch (err) {
        console.error(`could not reach peon at ${BASE} — is it running?\n  try \`peon start\`, or check: ${serviceStatusHint()}`);
        if (err instanceof Error)
            console.error(`  (${err.message})`);
        process.exit(1);
    }
    console.log(s.state === "paused"
        ? `No time for play — peon is PAUSED, not polling for tasks (up ${formatUptime(s.uptimeSec)}). Resume with \`peon resume\`.`
        : `Ready to work! peon is running — up ${formatUptime(s.uptimeSec)}`);
    if (s.updateCheckError) {
        console.log(`update check failed: ${s.updateCheckError}`);
    }
    else if (s.updateAvailable) {
        const current = s.updateCurrentVersion ?? s.updateCurrentRevision?.slice(0, 7) ?? "unknown";
        const latest = s.updateLatestVersion ?? s.updateLatestRevision?.slice(0, 7) ?? "unknown";
        console.log(`update available (${current} → ${latest}) — run \`peon update\``);
    }
    else {
        console.log("up to date");
    }
}
async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    switch (cmd) {
        case "start": {
            await startCommand();
            break;
        }
        case "stop": {
            await stopCommand();
            break;
        }
        case "restart": {
            await restartCommand(rest.includes("--force") || process.env.FORCE === "1");
            break;
        }
        case "status": {
            await statusCommand();
            break;
        }
        case "settings": {
            if (rest[0] === "set") {
                const [key, value] = rest.slice(1);
                const res = await fetch(`${BASE}/api/v1/settings`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ [key]: coerce(value) }),
                });
                console.log(await res.json());
            }
            else {
                console.log(await (await fetch(`${BASE}/api/v1/settings`)).json());
            }
            break;
        }
        case "pause": {
            console.log("Me busy... no. Me rest now.");
            console.log(await (await fetch(`${BASE}/api/v1/control/pause`, { method: "POST" })).json());
            break;
        }
        case "resume": {
            console.log("Zug zug! Back to work.");
            console.log(await (await fetch(`${BASE}/api/v1/control/resume`, { method: "POST" })).json());
            break;
        }
        case "update": {
            const force = rest.includes("--force") || process.env.FORCE === "1";
            // Baselines captured *before* kicking the update, so we can tell "the new
            // version is actually running" from "the API merely answered":
            //  - uptimeBefore: a global-install update restarts the daemon, so uptime
            //    resets. A dropped uptime is the honest production success signal; without it the
            //    poll returns the instant the API is reachable, which — when the
            //    updater crashes before restarting anything — is immediately, so a
            //    failed update reports success (this is exactly the npm-ENOENT bug).
            //  - logOffset: byte length of the append-only update.log now, so we only
            //    read back *this* run's output below.
            let uptimeBefore = 0;
            try {
                const pre = (await (await fetch(`${BASE}/api/v1/status`)).json());
                uptimeBefore = pre.uptimeSec ?? 0;
            }
            catch {
                // daemon not up — any reachable status after this counts as "came up"
            }
            const logOffset = updateLogSize();
            const res = await fetch(`${BASE}/api/v1/control/update`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ force }),
            });
            const body = (await res.json());
            if (!res.ok) {
                console.error(`update failed to start: ${body.error ?? res.statusText}`);
                process.exit(1);
            }
            console.log(body.message ?? "update started");
            console.log("==> waiting for the new version to come up");
            const budgetSec = 120; // npm install needs real time, same idiom as restart-daemon.sh's own poll
            for (let i = 0; i < budgetSec; i++) {
                await new Promise((r) => setTimeout(r, 1000));
                const fresh = updateLogSince(logOffset);
                try {
                    const statusRes = await fetch(`${BASE}/api/v1/status`);
                    if (statusRes.ok) {
                        const s = (await statusRes.json());
                        if ((s.uptimeSec ?? Infinity) < uptimeBefore) {
                            console.log("==> back up on the new version");
                            console.log(s);
                            return;
                        }
                    }
                }
                catch {
                    // control API unreachable mid-restart — keep polling
                }
                // Reachable but not restarted, and the updater logged that there was
                // nothing to pull — a legit no-op, not a hang. Stop waiting for a
                // restart that will never come.
                if (/already on the latest commit|nothing to do/i.test(fresh)) {
                    console.log("==> already up to date — nothing to update");
                    return;
                }
                if (/source checkout updated — daemon kept running/i.test(fresh)) {
                    console.log("==> source checkout updated; daemon kept running");
                    console.log("restart `npm run dev` manually when it is safe for daemon changes to take effect");
                    return;
                }
            }
            // Never saw a restart. Either the updater died before restarting anything
            // (the common failure) or it's genuinely wedged — surface this run's log
            // so the reason is visible instead of a phantom success.
            const fresh = updateLogSince(logOffset);
            console.error(`update did not complete within ${budgetSec}s. Recent ${UPDATE_LOG}:`);
            console.error(fresh || "(updater produced no output — did it launch? check the daemon journal for `update:` lines)");
            process.exit(1);
        }
        case "session": {
            const sub = rest[0];
            if (sub === "stop") {
                let id = rest[1];
                if (!id) {
                    // Only one session can ever be running at a time, so a bare
                    // `peon session stop` finds it rather than making the caller look
                    // up its id first (via Overseer or `GET /api/v1/sessions`).
                    const body = (await (await fetch(`${BASE}/api/v1/sessions`)).json());
                    const running = body.sessions?.find((s) => s.status === "running");
                    if (!running) {
                        console.error("no session is currently running");
                        process.exit(1);
                    }
                    id = running.id;
                }
                const res = await fetch(`${BASE}/api/v1/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" });
                const respBody = (await res.json());
                if (res.ok && respBody.ok) {
                    console.log(`stopped session ${id}.`);
                }
                else {
                    console.error(`stop failed: ${respBody.error ?? res.statusText}`);
                    process.exit(1);
                }
            }
            else {
                console.log("usage: peon session stop [id]");
            }
            break;
        }
        case "credential": {
            if (rest[0] !== "rotate") {
                console.error("usage: peon credential rotate");
                process.exit(1);
            }
            const res = await fetch(`${BASE}/api/v1/enrollment/credential/rotate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            const body = (await res.json());
            if (!res.ok) {
                console.error(`credential rotation failed: ${body.error ?? res.statusText}`);
                process.exit(1);
            }
            console.log(body.rotation
                ? `credential rotation ${body.rotation.state}; Peon will finish it automatically`
                : body.credential
                    ? `credential rotation complete: generation ${body.credential.generation} (${body.credential.credentialId})`
                    : "credential rotation started");
            break;
        }
        case "pair": {
            const currentResponse = await fetch(`${BASE}/api/v1/settings`);
            const current = (await currentResponse.json());
            const explicitLegacy = rest[0] === "--legacy";
            const retryParked = rest[0] === "--retry";
            const endpoint = explicitLegacy
                ? "/api/v1/pairing/arm"
                : retryParked
                    ? "/api/v1/enrollment/retry"
                    : "/api/v1/enrollment/claim";
            const serverOrigin = explicitLegacy ? "" : (rest[0] ?? current.overseerUrl ?? "").trim();
            if (!explicitLegacy && !retryParked && !serverOrigin) {
                console.error("usage: peon pair <https://overseer-origin> (or `peon pair --retry` / `peon pair --legacy`)");
                process.exit(1);
            }
            const res = await fetch(`${BASE}${endpoint}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(explicitLegacy || retryParked ? {} : { serverOrigin }),
            });
            const body = (await res.json());
            if (!res.ok) {
                console.error(`pair failed: ${body.error ?? res.statusText}`);
                process.exit(1);
            }
            if (retryParked) {
                console.log(`enrollment retry requested; current state: ${body.state ?? "idle"}`);
                break;
            }
            const phrase = body.legacyPhrase ?? body.phrase;
            if (phrase) {
                const expiresAt = body.legacyExpiresAt ?? body.expiresAt;
                const mins = expiresAt ? Math.max(1, Math.round((expiresAt - Date.now()) / 60_000)) : null;
                console.log("This Overseer does not support peon-claim-v1; explicit legacy pairing is armed:\n");
                console.log(`  phrase   : ${phrase}`);
                if (mins)
                    console.log(`  valid    : ~${mins} min`);
                console.log("\nLegacy mode requires the Overseer to reach this Peon's control API.");
                break;
            }
            console.log("Outbound enrollment claim created. Give the operator this code or URL:\n");
            if (body.operatorCode)
                console.log(`  code     : ${body.operatorCode}`);
            if (body.operatorUrl)
                console.log(`  URL      : ${body.operatorUrl}`);
            if (body.expiresAt) {
                const mins = Math.max(1, Math.round((body.expiresAt - Date.now()) / 60_000));
                console.log(`  valid    : ~${mins} min`);
            }
            console.log("\nPeon will poll securely and connect automatically after owner approval.");
            break;
        }
        case "remote": {
            const sub = rest[0] ?? "status";
            const current = (await (await fetch(`${BASE}/api/v1/settings`)).json());
            const portOf = (url, fallback) => {
                try {
                    return new URL(url ?? "").port || fallback;
                }
                catch {
                    return fallback;
                }
            };
            const controlPort = portOf(current.publicControlUrl, new URL(BASE).port || "4570");
            const isLoopbackHost = (host) => ["127.0.0.1", "localhost", "::1"].includes(host);
            const patchSettings = async (patch) => {
                const res = await fetch(`${BASE}/api/v1/settings`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch),
                });
                if (!res.ok) {
                    console.error(`failed to update settings: ${res.status} ${res.statusText}`);
                    process.exit(1);
                }
            };
            const RESTART_CMD = serviceRestartHint();
            const hostnameOf = (url) => {
                try {
                    return new URL(url ?? "").hostname;
                }
                catch {
                    return "";
                }
            };
            // Mirrors the busy-session guard `/api/v1/control/update` applies before its own
            // restart — restarting kills any in-flight session the same way a daemon update does.
            const restartBothServices = async (force) => {
                try {
                    const body = (await (await fetch(`${BASE}/api/v1/sessions`)).json());
                    if (body.sessions?.some((s) => s.status === "running") && !force) {
                        console.log(`a session is currently running — restarting kills it. Restart once it's done, or re-run with --force:\n  ${RESTART_CMD}`);
                        return;
                    }
                }
                catch {
                    // control API unreachable — fall through and let the service manager report its own error
                }
                try {
                    restartBackgroundServices();
                    console.log("restarted.");
                }
                catch {
                    console.log(`couldn't restart automatically — do it by hand:\n  ${RESTART_CMD}`);
                }
            };
            if (sub === "status") {
                const host = current.bindHost ?? "0.0.0.0";
                const loopbackOnly = isLoopbackHost(host);
                console.log(`bind host          : ${host}  (${loopbackOnly ? "loopback only — no remote access" : "accepting remote connections"})`);
                console.log(`publicControlUrl   : ${current.publicControlUrl}`);
            }
            else if (sub === "on") {
                const publicHost = rest[1] && !rest[1].startsWith("--") ? rest[1] : undefined;
                const patch = { bindHost: "0.0.0.0" };
                if (publicHost) {
                    if (/^https?:\/\//i.test(publicHost)) {
                        // A full URL means a reverse proxy fronts both the dashboard and the
                        // control API on one origin (served on 80/443, not our own ports) — use
                        // it verbatim for both so magic links come out portless
                        // (https://host/?token=...) instead of host:4571. api.js already routes
                        // /api/v1/* same-origin behind a proxy, so the two sharing one origin is fine.
                        const origin = new URL(publicHost).origin;
                        patch.publicControlUrl = origin;
                    }
                    else {
                        patch.publicControlUrl = `http://${publicHost}:${controlPort}`;
                    }
                }
                await patchSettings(patch);
                console.log("remote access enabled — both processes will bind 0.0.0.0 after a restart.");
                if (publicHost) {
                    console.log(`  control   : ${patch.publicControlUrl}`);
                }
                else {
                    console.log("next: set the public host so magic links resolve from other machines:");
                    console.log("  peon remote on <public-host-or-ip>");
                }
                await restartBothServices(rest.includes("--force"));
            }
            else if (sub === "off") {
                await patchSettings({
                    bindHost: "127.0.0.1",
                    publicControlUrl: `http://127.0.0.1:${controlPort}`,
                });
                console.log("remote access disabled — loopback only.");
                await restartBothServices(rest.includes("--force"));
            }
            else {
                console.log("usage: peon remote [status | on [public-host] [--force] | off [--force]]");
            }
            break;
        }
        default:
            console.log(USAGE);
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
