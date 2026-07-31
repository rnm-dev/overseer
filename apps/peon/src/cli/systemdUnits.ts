// Generates the systemd user unit `peon start` installs. Generating it at install
// time (rather than shipping a fixed file) lets the unit point at wherever this
// particular install actually landed and
// whichever node actually ran `peon start` — no assumptions about install location, npm
// prefix, or how node itself was installed (nvm/volta/system package/etc).

export interface UnitOptions {
  /** Absolute path to the installed package root (the service WorkingDirectory). */
  peonHome: string;
  /** Absolute path to the node binary to invoke — normally `process.execPath`. */
  nodeBin: string;
  /** PATH to bake into the daemon unit, normally the PATH `peon start` itself saw. */
  pathEnv: string;
}

export function buildDaemonUnit(opts: UnitOptions): string {
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
# Session harness spawns the agent CLI by bare name (settings.agentCommand) — bake in the
# PATH \`peon start\` itself saw so it resolves the same way a login shell would, regardless
# of nvm/volta/homebrew/etc.
Environment="PATH=${opts.pathEnv}"

[Install]
WantedBy=default.target
`;
}
