import { createControlServer } from "./controlServer.js";
import { settings } from "./settings/index.js";
import { sdNotify } from "./runtime/sdNotify.js";
import { peonRegistrar, peonSocket } from "./overseer/index.js";
import { sessions } from "./sessions/index.js";
import { updateChecker } from "./updates/updateChecker.js";
import { claudeCodeAuth } from "./providers/claudeCodeAuth.js";
import { configDir, stateDir } from "./runtime/xdgPaths.js";
import { createDaemonCompositionRoot } from "./bootstrap/compositionRoot.js";
import { reconcileArmoryInstalledState, recoverInterruptedArmoryOperations, recoverInterruptedArmoryUninstalls } from "./armory/index.js";
import { shutdownAgentDriverRuntimes } from "./agents/index.js";
import { controlListenerHosts, isLoopbackBindHost } from "./controlListeners.js";
import { recoverUpdateOperation } from "./updates/updateOperations.js";
import { parseListenAddress } from "../shared/listenAddress.js";
import { refreshAgentModelCatalogs } from "./providers/modelCatalog.js";
// Interface to bind. Defaults to all interfaces so enrolled Overseers can use
// authenticated Fleet HTTP. `peon remote off` opts into loopback-only access.
// Remote peers go through per-user magic-link or Fleet bearer authentication —
// only genuine loopback connections are auto-trusted as admin (isLoopback() in
// controlServer.ts keys off the real TCP socket address, which can't be spoofed).
const configured = settings.get();
const listenAddress = parseListenAddress(process.env.ACA_LISTEN_ADDRESS ?? configured.listenAddress);
const BIND_HOST = listenAddress.host;
const PORT = listenAddress.port;
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
const { armoryRuntime, armoryStores, armoryWorkflows } = composition;
recoverUpdateOperation();
// Discover provider-owned models and effort capabilities before accepting a
// session. Each driver is isolated and falls back to its bundled catalog when
// its installed CLI does not expose a compatible discovery surface.
await refreshAgentModelCatalogs(configured);
const modelCatalogRefreshTimer = setInterval(() => {
    void refreshAgentModelCatalogs(settings.get());
}, 60_000);
modelCatalogRefreshTimer.unref();
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
    const reconciled = await reconcileArmoryInstalledState(armoryStores);
    if (reconciled.restored.length)
        console.warn(`restored Armory installed state for: ${reconciled.restored.join(", ")}`);
    if (reconciled.pruned.length)
        console.warn(`pruned stale Armory installed state for: ${reconciled.pruned.join(", ")}`);
    for (const issue of reconciled.unresolved)
        console.warn(`could not reconcile Armory package ${issue.packageId}:`, issue.error);
    await composition.armoryApi.projectPackages?.initializeMigration();
    await armoryRuntime.reconcile();
}
catch (error) {
    console.error("failed to initialize Armory runtime:", error);
}
const listenerHosts = controlListenerHosts(BIND_HOST);
const servers = listenerHosts.map((host, index) => app.listen(PORT, host, index === 0 ? () => {
    const s = settings.get();
    console.log(`peon daemon: control API listening on ${listenAddress.canonical}`);
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
            console.warn("  ...but publicControlUrl still points at loopback; set it to this Peon's MagicDNS URL.");
        }
    }
    else if (!isLoopbackHost(publicControlUrl)) {
        console.warn("WARNING: publicControlUrl is remote but the daemon still binds loopback. " +
            "Use `peon remote on 0.0.0.0:4570` to enable Fleet HTTP over Tailscale.");
    }
    console.log("(task claim: milestone 1 only — claims + reports needs_human, does not implement yet)");
    if (!settings.get().overseerToken.trim()) {
        const rule = "═".repeat(60);
        console.log(`\n${rule}`);
        console.log("  peon is not enrolled — arm a one-time pairing phrase with:\n");
        console.log("      peon enroll\n");
        console.log("  Then enter this Peon's address and phrase in Overseer.");
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
    armoryWorkflows.start();
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
// app.listen() returns before the socket is bound. Desktop initialization must
// not report success until every requested listener is live; in particular, a
// Windows port-proxy conflict otherwise makes the tray briefly show a running
// Peon whose process immediately exits from an unhandled EADDRINUSE event.
await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
    if (server.listening) {
        resolve();
        return;
    }
    const listening = () => {
        server.off("error", failed);
        resolve();
    };
    const failed = (error) => {
        server.off("listening", listening);
        reject(error);
    };
    server.once("listening", listening);
    server.once("error", failed);
})));
const watchdogIntervalMs = sdNotify.watchdogIntervalMs();
if (watchdogIntervalMs) {
    setInterval(() => sdNotify.watchdog(), watchdogIntervalMs);
}
process.on("SIGTERM", () => {
    clearInterval(modelCatalogRefreshTimer);
    sdNotify.stopping();
    peonRegistrar.stop();
    armoryWorkflows.stop();
    sessions.notifyShuttingDown();
    // server.close() waits for every open connection to end — but SSE clients
    // hold live session streams open indefinitely,
    // and EventSource auto-reconnects the instant a connection is force-closed,
    // so even closeAllConnections() doesn't reliably win that race. Confirmed
    // empirically: a restart with a stream open hung until systemd's
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
