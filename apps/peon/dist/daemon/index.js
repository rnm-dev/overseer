import { createControlServer } from "./controlServer.js";
import { settings } from "./settings/index.js";
import { sdNotify } from "./sdNotify.js";
import { armoryCommandHandlers, peonRegistrar, peonSocket } from "./overseer/index.js";
import { sessions } from "./sessions/index.js";
import { updateChecker } from "./updateChecker.js";
import { claudeCodeAuth } from "./claudeCodeAuth.js";
import { configDir, stateDir } from "./xdgPaths.js";
import { createDaemonCompositionRoot } from "./bootstrap/compositionRoot.js";
import { recoverInterruptedArmoryOperations, recoverInterruptedArmoryUninstalls } from "./armory/index.js";
import { armoryInventory } from "./armory/index.js";
import { shutdownAgentDriverRuntimes } from "./agents/index.js";
import { peonClaimClient } from "./enrollment/index.js";
import { controlListenerHosts, isLoopbackBindHost } from "./controlListeners.js";
const PORT = Number(process.env.ACA_CONTROL_PORT ?? 4570);
// Interface to bind. Defaults to loopback-only (settings.bindHost === "127.0.0.1");
// set it wider (0.0.0.0 or a specific interface IP) via `peon remote on` to accept
// remote connections. Remote peers then go through per-user magic-link auth —
// only genuine loopback connections are auto-trusted as admin (isLoopback() in
// controlServer.ts keys off the real TCP socket address, which can't be spoofed).
const configured = settings.get();
const BIND_HOST = process.env.ACA_BIND_HOST ?? configured.bindHost;
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
peonSocket.registerReverseCommandHandlers(armoryCommandHandlers({
    ...composition.armoryApi,
    inventory: armoryInventory,
}));
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
const listenerHosts = controlListenerHosts(BIND_HOST);
const servers = listenerHosts.map((host, index) => app.listen(PORT, host, index === 0 ? () => {
    const s = settings.get();
    console.log(`peon daemon: control API listening on http://${BIND_HOST}:${PORT}`);
    console.log("fleet transport: authenticated Fleet HTTP with outbound WSS projections");
    console.log(`config dir: ${configDir()}`);
    console.log(`state dir: ${stateDir()}`);
    // Redact the two secrets so a routine settings dump never leaks them — the
    // pairing phrase in particular is meant to be printed exactly once, on
    // generation (below), and never again.
    console.log("current settings:", {
        ...s,
        overseerToken: s.overseerToken ? "<set>" : "",
        pairingSecret: s.pairingSecret ? "<armed>" : "",
    });
    const { publicControlUrl } = settings.get();
    if (!isLoopbackBindHost(BIND_HOST)) {
        // Bound wide on purpose — reachable from the network. This is the intended
        // remote-access path (auth handles it), so make the exposure visible, not alarming.
        console.warn(`NOTE: bound to ${BIND_HOST} for authenticated Fleet HTTP. ` +
            "Local CLI routes still require a real loopback peer; operator access belongs in Overseer.");
        if (isLoopbackHost(publicControlUrl)) {
            console.warn("  ...but publicControlUrl still points at loopback. Fix with `peon remote on <public-host>`.");
        }
    }
    else if (!isLoopbackHost(publicControlUrl)) {
        console.warn("WARNING: publicControlUrl is remote but the daemon still binds loopback. " +
            "Use `peon remote on <mesh-host>` to enable Fleet HTTP over the mesh.");
    }
    console.log("(task claim: milestone 1 only — claims + reports needs_human, does not implement yet)");
    // A fresh Peon now initiates peon-claim-v1 outbound. Legacy pairing remains
    // available only after an explicit unsupported capability response (or an
    // explicit local legacy arm), so startup must not silently choose it.
    if (!settings.get().overseerToken.trim()) {
        const rule = "═".repeat(60);
        console.log(`\n${rule}`);
        console.log("  peon is unrecruited — start an outbound claim with:\n");
        console.log("      peon pair https://your-overseer.example\n");
        console.log("  No inbound address, callback, or Tailscale reachability is required.");
        console.log(`${rule}\n`);
    }
    // Restores a persisted start, poll, delivery acknowledgement, or rotation
    // before opening sockets. Any newly installed credential updates settings,
    // which then generation-replaces both socket supervisors.
    peonClaimClient.start();
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
} : () => {
    console.log(`peon daemon: local CLI/MCP listening on http://${host}:${PORT}`);
}));
const watchdogIntervalMs = sdNotify.watchdogIntervalMs();
if (watchdogIntervalMs) {
    setInterval(() => sdNotify.watchdog(), watchdogIntervalMs);
}
process.on("SIGTERM", () => {
    sdNotify.stopping();
    peonClaimClient.stop();
    peonRegistrar.stop();
    sessions.notifyShuttingDown();
    // server.close() waits for every open connection to end — but SSE clients
    // (dashboard tabs, live session streams) hold theirs open indefinitely,
    // and EventSource auto-reconnects the instant a connection is force-closed,
    // so even closeAllConnections() doesn't reliably win that race. Confirmed
    // empirically: a restart with the dashboard open hung until systemd's
    // stop-timeout force-killed it, repeatedly. Exit on a hard deadline
    // instead of waiting on client behavior we don't control.
    for (const server of servers) {
        server.close();
        server.closeAllConnections();
    }
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
