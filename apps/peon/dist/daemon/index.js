import { createControlServer } from "./controlServer.js";
import { settings } from "./settings/index.js";
import { sdNotify } from "./sdNotify.js";
import { peonRegistrar, peonSocket } from "./overseer/index.js";
import { sessions } from "./sessions/index.js";
import { updateChecker } from "./updateChecker.js";
import { claudeCodeAuth } from "./claudeCodeAuth.js";
import { pairing } from "./pairing.js";
import { configDir, stateDir } from "./xdgPaths.js";
import { createDaemonCompositionRoot } from "./bootstrap/compositionRoot.js";
import { recoverInterruptedArmoryOperations, recoverInterruptedArmoryUninstalls } from "./armory/index.js";
import { shutdownAgentDriverRuntimes } from "./agents/index.js";
const PORT = Number(process.env.ACA_CONTROL_PORT ?? 4570);
// Interface to bind. Defaults to loopback-only (settings.bindHost === "127.0.0.1");
// set it wider (0.0.0.0 or a specific interface IP) via `peon remote on` to accept
// remote connections. Remote peers then go through per-user magic-link auth —
// only genuine loopback connections are auto-trusted as admin (isLoopback() in
// controlServer.ts keys off the real TCP socket address, which can't be spoofed).
const BIND_HOST = process.env.ACA_BIND_HOST ?? settings.get().bindHost;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];
function isLoopbackHost(url) {
    try {
        return LOOPBACK_HOSTS.includes(new URL(url).hostname);
    }
    catch {
        return false;
    }
}
const composition = createDaemonCompositionRoot();
const app = createControlServer(composition.controlServerOptions);
const { armoryRuntime, armoryStores } = composition;
// Armory bindings are snapshotted when each agent turn starts. Finish the
// initial reconciliation before accepting session requests so a session
// created during daemon startup cannot permanently miss healthy package tools
// on its first turn. Startup still proceeds when recovery/reconciliation
// fails; the runtime records package failures and schedules retries itself.
try {
    const recoveredUninstalls = await recoverInterruptedArmoryUninstalls(armoryStores);
    if (recoveredUninstalls)
        console.warn(`recovered ${recoveredUninstalls} interrupted Armory uninstall(s)`);
    const recovered = await recoverInterruptedArmoryOperations(armoryStores);
    if (recovered)
        console.warn(`recovered ${recovered} interrupted Armory operation(s)`);
    await armoryRuntime.reconcile();
}
catch (error) {
    console.error("failed to initialize Armory runtime:", error);
}
const server = app.listen(PORT, BIND_HOST, () => {
    console.log(`peon daemon: control API listening on http://${BIND_HOST}:${PORT}`);
    console.log(`config dir: ${configDir()}`);
    console.log(`state dir: ${stateDir()}`);
    // Redact the two secrets so a routine settings dump never leaks them — the
    // pairing phrase in particular is meant to be printed exactly once, on
    // generation (below), and never again.
    const s = settings.get();
    console.log("current settings:", {
        ...s,
        overseerToken: s.overseerToken ? "<set>" : "",
        pairingSecret: s.pairingSecret ? "<armed>" : "",
    });
    const { publicControlUrl, publicDashboardUrl } = settings.get();
    if (!LOOPBACK_HOSTS.includes(BIND_HOST)) {
        // Bound wide on purpose — reachable from the network. This is the intended
        // remote-access path (auth handles it), so make the exposure visible, not alarming.
        console.warn(`NOTE: bound to ${BIND_HOST} — the control API and dashboard are reachable from the network. ` +
            "Remote clients must authenticate with a magic link (`peon user auth-link <username>`); only loopback " +
            "connections are auto-trusted as admin. Keep the ports firewalled to networks you trust.");
        if (isLoopbackHost(publicControlUrl) || isLoopbackHost(publicDashboardUrl)) {
            console.warn("  ...but publicControlUrl/publicDashboardUrl still point at 127.0.0.1/localhost, so magic links " +
                "will be unusable from another machine. Fix with `peon remote on <public-host>`.");
        }
    }
    else if (!isLoopbackHost(publicControlUrl) || !isLoopbackHost(publicDashboardUrl)) {
        console.warn("WARNING: publicControlUrl/publicDashboardUrl point away from 127.0.0.1/localhost, but this process " +
            "still only binds 127.0.0.1. The only way a genuinely remote client can reach it is a tunnel or " +
            "port-forward (e.g. `ssh -L`) terminating on this box — every request arriving through one looks like " +
            "a loopback connection and BYPASSES per-user dashboard auth entirely. Only forward these ports over a " +
            "channel you trust as much as a shell on this box. To accept remote connections directly (with auth), " +
            "use `peon remote on` instead.");
    }
    console.log("(task claim: milestone 1 only — claims + reports needs_human, does not implement yet)");
    // A never-recruited peon (no overseerToken) arms a one-time pairing phrase at
    // boot so an operator can connect it to an overseer. Printed once, here, on
    // generation — never logged again (redacted from the settings dump above).
    // Done before peonRegistrar.start() so arming (a settings write) doesn't race
    // its settings-change subscription.
    if (!settings.get().overseerToken.trim()) {
        const { phrase, expiresAt } = pairing.arm();
        const mins = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
        const rule = "═".repeat(60);
        console.log(`\n${rule}`);
        console.log(`  peon is unrecruited — pairing phrase (valid ~${mins} min):\n`);
        console.log(`      ${phrase}\n`);
        console.log("  Give this phrase + this peon's tailnet address to an operator");
        console.log('  to connect it from the overseer\'s "Connect peon" form.');
        console.log("  Re-arm anytime with `peon pair`.");
        console.log(`${rule}\n`);
    }
    // Outbound: if an overseerUrl+token are configured, announce this peon to the
    // fleet control plane and heartbeat it; a no-op (idle loop) otherwise.
    peonRegistrar.start();
    // Maintain the reverse Peon socket. It reconnects forever after transient
    // network/server failures and owns session-catalog synchronization.
    peonSocket.start();
    updateChecker.start();
    claudeCodeAuth.start();
    sessions.restoreFromDisk();
    // After reconciliation, auto-resume any eligible ad-hoc session this restart
    // (or a prior crash) killed mid-run.
    void sessions.resumeInterrupted().catch((error) => {
        console.error("failed to reconcile interrupted sessions:", error);
    }).finally(() => {
        // A crash can land after a completed turn was persisted but before its
        // queued successor spawned. Resume those durable queues on boot only after
        // native reconciliation has decided which turns are safe to continue.
        sessions.resumeQueued();
        sdNotify.ready();
    });
});
const watchdogIntervalMs = sdNotify.watchdogIntervalMs();
if (watchdogIntervalMs) {
    setInterval(() => sdNotify.watchdog(), watchdogIntervalMs);
}
process.on("SIGTERM", () => {
    sdNotify.stopping();
    sessions.notifyShuttingDown();
    // server.close() waits for every open connection to end — but SSE clients
    // (dashboard tabs, live session streams) hold theirs open indefinitely,
    // and EventSource auto-reconnects the instant a connection is force-closed,
    // so even closeAllConnections() doesn't reliably win that race. Confirmed
    // empirically: a restart with the dashboard open hung until systemd's
    // stop-timeout force-killed it, repeatedly. Exit on a hard deadline
    // instead of waiting on client behavior we don't control.
    server.close();
    server.closeAllConnections();
    const hardExit = setTimeout(() => process.exit(1), 1000);
    void Promise.all([sessions.flushTranscripts(), armoryRuntime.close(), shutdownAgentDriverRuntimes()]).then(() => {
        clearTimeout(hardExit);
        process.exit(0);
    }, (error) => {
        console.error("failed to flush session transcripts during shutdown:", error);
        clearTimeout(hardExit);
        process.exit(1);
    });
});
