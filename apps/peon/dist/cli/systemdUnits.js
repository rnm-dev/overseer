// Generates the two systemd user units `peon start` installs, replacing the old static
// `systemd/*.service` files. Generating them at install time (rather than shipping fixed
// files) lets each unit point at wherever this particular install actually landed and
// whichever node actually ran `peon start` — no assumptions about install location, npm
// prefix, or how node itself was installed (nvm/volta/system package/etc).
export function buildDaemonUnit(opts) {
    const controlPort = opts.controlPort ?? 4570;
    return `[Unit]
Description=peon daemon (control API)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WorkingDirectory=${opts.peonHome}
ExecStart=${opts.nodeBin} dist/daemon/index.js
Restart=always
RestartSec=2
WatchdogSec=30
Environment=ACA_CONTROL_PORT=${controlPort}
# Session harness spawns the agent CLI by bare name (settings.agentCommand) — bake in the
# PATH \`peon start\` itself saw so it resolves the same way a login shell would, regardless
# of nvm/volta/homebrew/etc.
Environment="PATH=${opts.pathEnv}"

[Install]
WantedBy=default.target
`;
}
export function buildDashboardUnit(opts) {
    const dashboardPort = opts.dashboardPort ?? 4571;
    return `[Unit]
Description=peon dashboard (read-only web UI)
After=network-online.target peon-daemon.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${opts.peonHome}
ExecStart=${opts.nodeBin} dist/dashboard/server.js
Restart=always
RestartSec=2
Environment=ACA_DASHBOARD_PORT=${dashboardPort}

[Install]
WantedBy=default.target
`;
}
