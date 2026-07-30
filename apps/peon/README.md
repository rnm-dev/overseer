# peon

<p align="center">
  <img src="assets/peon.png" alt="peon — a worker bot grinding through a queue of coding tasks" width="640">
</p>

A background daemon that watches Heroboard for tasks assigned to a bot account, implements
them with a coding agent CLI, verifies the result, commits, and moves the task forward.

Peon is a CLI-only managed daemon. Use Overseer for every operator UI,
authentication and authorization flow; Peon has no local dashboard or users.

## Install

Requirements: Linux with systemd or macOS with launchd, `git`, `node >= 22`, `npm`, and a
supported coding-agent CLI installed, on `PATH`, and authenticated.

```sh
npm install -g @rnm-dev/peon
```

```sh
peon start
```

That's it. `peon start` installs a native per-user background service (systemd on Linux,
launchd on macOS). It restarts itself if it crashes and starts automatically on boot/login,
then prints the local control API URL once it's up. Temporary network failures do not
require a restart: the Overseer connection keeps retrying with bounded backoff.

### If `npm install -g` fails with a permission error

This means your global npm folder isn't writable by your user (common on a fresh machine).
Fix it once:

```sh
npm config set prefix "$HOME/.local"
```

Then run the install command again. If `peon` still isn't found afterward, make sure
`$HOME/.local/bin` is on your `PATH` (check your shell's rc file).

### If a session fails with `spawn claude ENOENT`

peon couldn't find the `claude` binary on the daemon process's own `PATH` — either it
isn't installed, or it was installed *after* `peon start` last ran. `peon start` snapshots
whatever `PATH` your shell had at that moment into the systemd unit
(`Environment=PATH=...`); installing `claude` afterward doesn't retroactively update an
already-running service. Confirm it resolves (`which claude`), then either re-run
`peon start` (regenerates the unit with your current `PATH`) or restart both services
(`systemctl --user restart peon-daemon.service`). If `claude` lives
somewhere you'd rather not add to `PATH`, point `agentCommand` at its full path instead:
`peon settings set agentCommand /full/path/to/claude`.

### Don't run peon as root

`peon start` works as any regular user, but not as root — Claude Code itself refuses to
run in the permission-bypass mode peon needs (`--permission-mode bypassPermissions`,
required so a session can run shell commands unattended) when the process is root/sudo,
as a hard safety guard that peon has no way to configure around. If you're on a fresh box
and logged in as root, create/switch to a regular user first, make sure `claude` is
installed and authenticated for *that* user (not root), and run the install/`peon start`
steps above as them instead.

### Linux: if `peon start` fails with `Failed to connect to bus`

This is systemd's own error, not peon's — it means the user you're running `peon start`
as doesn't have a running systemd user-manager instance yet, which normally only starts
via a real login (SSH, console), not a `su`/`sudo -u` shell switch. Fix, as root:

```sh
loginctl enable-linger <username>
```

This keeps that user's systemd instance running independent of any login session — it's
the same thing `peon start` itself tries to enable, just too late in its own sequence to
get you past this. Then either open a **fresh** session as that user (e.g.
`ssh <username>@localhost` — a real login sets up the bus connection correctly) or, to
keep using the current shell, point it at the now-running instance manually:

```sh
export XDG_RUNTIME_DIR=/run/user/$(id -u <username>)
```

Then re-run `peon start`.

### Stopping peon

```sh
peon stop
```

This stops it now, but it'll start again on the next reboot/login. To turn that off too:

```sh
systemctl --user disable peon-daemon.service
```

On macOS, remove `~/Library/LaunchAgents/dev.peon.daemon.plist` and
`~/Library/LaunchAgents/dev.peon.dashboard.plist` after `peon stop` to disable future
login starts.

### Updating peon

```sh
peon update
```

Installs the latest version, typechecks it, and restarts. Refuses to run if a task is
currently in progress — pass `peon update --force` to override that.

## Configure

**Connect Heroboard (or another integration)** — required before peon has any tasks to do:

```sh
peon integration add <label> <apiUrl>
```

This asks for an API key (input is masked) and checks it works before saving it. You can
connect more than one integration. Other integration commands:

- `peon integration remove <key>` — disconnect one (refuses if a project still uses it)

**Dashboard login** — only needed if you access the dashboard from somewhere other than the
machine it runs on. Local/`localhost` access is always trusted, no login needed.

```sh
peon user add <username>
peon user auth-link <username>
```

`add` creates the dashboard user; `auth-link` prints a one-time login link for an existing
user, valid for 15 minutes. Opening it in a browser logs you in for 30 days. Other user
commands:

- `peon user list` — list users
- `peon user sessions <username>` — list a user's login sessions
- `peon user revoke <username> [sessionId]` — log out one session, or all of them

By default both servers bind `127.0.0.1` only — peon has no direct network exposure, and there
are two ways to reach it from another machine:

- **Tunnel (no config).** Port-forward both ports over a channel you already trust
  (`ssh -L 4570:localhost:4570 -L 4571:localhost:4571 you@box`). A forwarded request is
  indistinguishable from a local process to peon and **skips login entirely** — same as the
  "local access is always trusted" behavior above. Only tunnel over SSH/a VPN you trust as
  much as a shell on this box, and never put either port behind a plain reverse proxy with no
  auth of its own.
- **Direct, with auth.** Bind the ports to the network and require each remote user to log in:

  ```sh
  peon remote on <public-host-or-ip>   # binds 0.0.0.0, sets the public URLs
  # restart both processes, then:
  peon user add alice && peon user auth-link alice
  ```

  Remote connections aren't loopback, so they go through the per-user magic-link auth — only
  genuinely local processes are auto-trusted. `peon remote` shows the current state and
  `peon remote off` reverts to loopback-only. **The bind host is read at startup**, so restart
  the daemon and dashboard after toggling it
  (`systemctl --user restart peon-daemon.service peon-dashboard.service`). Still keep the ports
  firewalled to networks you trust.

### Settings

View or change settings with `peon settings` / `peon settings set <key> <value>`. Don't edit
`settings.json` directly while peon is running — it only reads that file at startup.

| key | default | meaning |
|---|---|---|
| `pollIntervalMs` | `30000` | how often to poll each project for tasks |
| `contextPollIntervalMs` | `300000` | how often to refresh the project list/prompts |
| `updateCheckIntervalMs` | `900000` | how often to check for a newer version |
| `maxTurns` | `300` | max agent turns per task |
| `taskTimeoutMs` | `1800000` (30 min) | max wall-clock time per task |
| `maxBudgetUsd` | `3` | max `$` spend per task |
| `agentCommand` | `claude` | Claude Code CLI binary used by default sessions and autonomous tasks |
| `codexCommand` | `codex` | Codex CLI binary used by `codex-app-server` sessions and provider probes |
| `publicControlUrl` | `http://127.0.0.1:4570` | public URL of the control API |
| `publicDashboardUrl` | `http://127.0.0.1:4571` | public URL of the dashboard |
| `bindHost` | `127.0.0.1` | interface both servers bind (`0.0.0.0` for remote); prefer `peon remote on/off`. Read at startup — restart to apply |
| `paused` | `false` | whether task polling is on |

> `publicControlUrl` and `publicDashboardUrl` must use the same hostname (a different port
> is fine) — dashboard logins break otherwise. This only matters once the dashboard is
> reached from somewhere other than `127.0.0.1`.

## Commands

Lifecycle commands. (Integration and user commands are listed above, under Configure.)

| command | what it does |
|---|---|
| `peon start` | install, enable, and start the service |
| `peon stop` | stop the service |
| `peon update [--force]` | update to the latest version and restart |
| `peon status` | is it running, is it authenticated, is an update available |
| `peon pause` / `peon resume` | turn task polling off/on |
| `peon settings` | show current settings |
| `peon settings set <key> <value>` | change a setting |
| `peon remote [status]` | show bind host and public URLs |
| `peon remote on [public-host]` | accept remote connections (see Configure) |
| `peon remote off` | revert to loopback-only |

`peon status` reads like a sentence, not a JSON dump:

```
$ peon status
peon is running — up 3h 12m
integration: authenticated
up to date
```

If something needs attention it tells you what and how to fix it, e.g. `integration: NOT
authenticated — connect one with peon integration add <label> <apiUrl>`, or
`update available (2b9f105 → eaa8f21) — run peon update`.

Dashboard: `http://127.0.0.1:4571`. Control API: `http://127.0.0.1:4570`.

## Developing peon itself

Already have a checkout and want hot-reload instead of the systemd service?

```sh
npm ci
npm run dev
```

This runs the daemon and dashboard together with live reload on save, on the same ports
(4570/4571) the systemd service uses — don't run both at the same time.

| npm script | what it does |
|---|---|
| `npm run dev` | daemon + dashboard, hot reload |
| `npm run dev:daemon` / `npm run dev:dashboard` | just one side |
| `npm run restart:daemon` | typecheck, then restart (refuses if a task is running) |
| `npm run restart:dashboard` | same, no task-running check needed |
| `npm run update` | same as `peon update` |
| `npm run compile` | compile the whole app to `dist/` (CLI, daemon, dashboard) — run after editing anything under `src/` and commit `dist/` |

## More detail

Detailed architecture, development constraints, and machine-specific operating notes live in
the Peon project information injected into agent sessions. Durable decisions and debugging
history also live in commit messages.
