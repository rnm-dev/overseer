#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDaemonUnit } from "./systemdUnits.js";
import { buildLaunchAgent } from "./launchdUnits.js";
import { configDir } from "../daemon/runtime/xdgPaths.js";
import { parseListenAddress } from "../shared/listenAddress.js";
import { serviceEnvPath } from "./servicePath.js";
import { SECURE_FILE_HELPER } from "../shared/runtimePrerequisites.js";
function configuredControlPort() {
    try {
        const raw = JSON.parse(readFileSync(path.join(configDir(), "settings.json"), "utf8"));
        if (typeof raw.listenAddress === "string")
            return parseListenAddress(raw.listenAddress).port;
    }
    catch {
        // A missing or old settings file uses the stable default below.
    }
    return Number(process.env.ACA_CONTROL_PORT ?? 4570);
}
const BASE = process.env.ACA_CONTROL_URL ?? `http://127.0.0.1:${configuredControlPort()}`;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYSTEMD_USER_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const LAUNCHD_USER_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const STATE_DIR = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), ".peon");
const IS_MACOS = process.platform === "darwin";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
function isLoopbackUrl(value) {
    try {
        return LOOPBACK_HOSTS.has(new URL(value ?? "").hostname.replace(/^\[|\]$/g, ""));
    }
    catch {
        return false;
    }
}
function enrollmentAddress(publicControlUrl, listenAddress) {
    const advertised = publicControlUrl?.trim();
    try {
        const listener = parseListenAddress(listenAddress ?? "");
        if (advertised && !isLoopbackUrl(advertised))
            return advertised;
        if (!LOOPBACK_HOSTS.has(listener.host) && listener.host !== "0.0.0.0" && listener.host !== "::") {
            return `http://${listener.canonical}`;
        }
    }
    catch {
        // Keep the configured public URL (or the existing not-configured message)
        // when an old/manual listenAddress cannot be parsed.
    }
    return advertised || listenAddress?.trim() || "not configured";
}
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
  enroll                       arm a one-time phrase for adding this Peon in Overseer
  pair                         compatibility alias for enroll

Remote access
  remote                              show listener and advertised Tailscale URL
  remote on <host:port> [--force]     listen remotely and restart
                                      example: peon remote on 0.0.0.0:4570
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
            console.error(`peon start needs "${name}", but it is unavailable. ${hint}`);
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
    requireBinary(SECURE_FILE_HELPER, "Python 3 at this path is required for race-safe project file writes.");
    if (IS_MACOS) {
        requireBinary("launchctl", "launchd is required for a persistent Peon service on macOS.");
        const pathEnv = serviceEnvPath(process.env.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
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
        pathEnv: serviceEnvPath(process.env.PATH, "/usr/local/bin:/usr/bin:/bin"),
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
        case "enroll":
        case "pair": {
            if (rest.length) {
                console.error(`usage: peon ${cmd}`);
                process.exit(1);
            }
            const currentResponse = await fetch(`${BASE}/api/v1/settings`);
            const current = (await currentResponse.json());
            const res = await fetch(`${BASE}/api/v1/pairing/arm`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            const body = (await res.json());
            if (!res.ok) {
                console.error(`enroll failed: ${body.error ?? res.statusText}`);
                process.exit(1);
            }
            const mins = body.expiresAt ? Math.max(1, Math.round((body.expiresAt - Date.now()) / 60_000)) : null;
            const address = enrollmentAddress(current.publicControlUrl, current.listenAddress);
            console.log("Pairing phrase armed. Add this Peon from Overseer with:\n");
            console.log(`  address  : ${address}`);
            console.log(`  phrase   : ${body.phrase ?? ""}`);
            if (mins)
                console.log(`  valid    : ~${mins} min`);
            console.log("\nThe phrase is single-use. Overseer must be able to reach this address.");
            break;
        }
        case "remote": {
            const sub = rest[0] ?? "status";
            const current = (await (await fetch(`${BASE}/api/v1/settings`)).json());
            const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(host);
            const patchSettings = async (patch) => {
                const res = await fetch(`${BASE}/api/v1/settings`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch),
                });
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    console.error(`failed to update settings: ${body.error ?? `${res.status} ${res.statusText}`}`);
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
                const address = parseListenAddress(current.listenAddress ?? "0.0.0.0:4570");
                const loopbackOnly = isLoopbackHost(address.host);
                console.log(`listenAddress      : ${address.canonical}  (${loopbackOnly ? "loopback only — no remote access" : "remote + loopback"})`);
                console.log(`publicControlUrl   : ${current.publicControlUrl}`);
            }
            else if (sub === "on") {
                const requested = rest[1] && !rest[1].startsWith("--") ? rest[1] : "";
                if (!requested) {
                    console.error("usage: peon remote on <host:port> [--force]");
                    process.exit(1);
                }
                let address;
                try {
                    address = parseListenAddress(requested);
                }
                catch (error) {
                    console.error(error instanceof Error ? error.message : "invalid listen address");
                    process.exit(1);
                }
                const patch = { listenAddress: address.canonical };
                if (isLoopbackUrl(current.publicControlUrl) && !isLoopbackHost(address.host)
                    && address.host !== "0.0.0.0" && address.host !== "::") {
                    patch.publicControlUrl = `http://${address.canonical}`;
                }
                await patchSettings(patch);
                console.log(`remote access enabled — the daemon will listen on ${address.canonical}; loopback remains available.`);
                await restartBothServices(rest.includes("--force"));
            }
            else if (sub === "off") {
                const port = parseListenAddress(current.listenAddress ?? "0.0.0.0:4570").port;
                await patchSettings({ listenAddress: `127.0.0.1:${port}` });
                console.log(`remote access disabled — listening on 127.0.0.1:${port} only.`);
                await restartBothServices(rest.includes("--force"));
            }
            else {
                console.log("usage: peon remote [status | on <host:port> [--force] | off [--force]]");
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
