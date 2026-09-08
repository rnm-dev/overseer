import { servePipe } from "./pipeRpc.js";
// stdout is exclusively the inherited controller protocol. Keep daemon output
// out of it; the parent deliberately discards stderr rather than exporting secrets.
console.log = console.info = console.warn = console.error = () => { };
process.env.PEON_DESKTOP = "1";
let initialized = false;
let shutdown;
let api;
const error = (code) => { throw Object.assign(new Error(code), { code }); };
const deadline = setTimeout(() => process.exit(1), 90_000);
deadline.unref();
async function initialize() {
    // No daemon/provider work happens until the parent has installed its Job Object.
    await import("../daemon/index.js");
    const [{ settings }, { sessions }, { pairing }, { peonRegistrar, peonSocket }, { peonPublicUrl }] = await Promise.all([
        import("../daemon/settings/index.js"), import("../daemon/sessions/index.js"),
        import("../daemon/identity/pairing.js"), import("../daemon/overseer/index.js"),
        import("../daemon/identity/peonAddress.js"),
    ]);
    shutdown = () => { process.emit("SIGTERM"); };
    clearTimeout(deadline);
    return { settings, sessions, pairing, peonRegistrar, peonSocket, peonPublicUrl };
}
function snapshot() {
    if (!api)
        return error("NOT_READY");
    const s = api.settings.get();
    const link = api.peonRegistrar.getState();
    const socket = api.peonSocket.getState();
    return {
        protocol: 1, pid: process.pid, timestamp: Date.now(), nodeVersion: process.version,
        name: s.name, overseerUrl: s.overseerUrl, pairingUrl: api.peonPublicUrl(),
        listenAddress: s.listenAddress, defaultAgent: s.defaultAgent,
        agentCommand: s.agentCommand, codexCommand: s.codexCommand,
        enrolled: Boolean(s.overseerToken), paused: s.paused,
        activeSessions: api.sessions.list().filter(s => s.status === "running").length,
        connected: socket.connected, registered: link.registered,
        lastHeartbeatAt: link.lastHeartbeatAt, revoked: link.derecruited,
    };
}
servePipe(process.stdin, process.stdout, async (method, params) => {
    if (method === "initialize") {
        if (initialized || params?.protocol !== 1)
            return error("INCOMPATIBLE_PROTOCOL");
        initialized = true;
        api = await initialize();
        return snapshot();
    }
    if (!api)
        return error("NOT_READY");
    if (method === "status")
        return snapshot();
    if (method === "enroll")
        return { ...api.pairing.arm(), url: api.peonPublicUrl() };
    if (method === "configure") {
        if (!params || typeof params !== "object" || Array.isArray(params))
            return error("BAD_REQUEST");
        const allowed = new Set(["name", "publicControlUrl", "overseerUrl", "defaultAgent", "agentCommand", "codexCommand"]);
        if (Object.keys(params).some(key => !allowed.has(key)))
            return error("BAD_REQUEST");
        api.settings.patchControlSettings(params);
        return snapshot();
    }
    if (method === "shutdown") {
        if (api.sessions.isBusy() && params?.force !== true)
            return error("SESSION_BUSY");
        setTimeout(() => shutdown?.(), 30);
        return { stopping: true };
    }
    return error("UNKNOWN_METHOD");
}, () => {
    if (shutdown)
        shutdown();
    else
        process.exit(1);
});
