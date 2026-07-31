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
`peon start` (regenerates the unit with your current `PATH`) or restart the service
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

On macOS, remove `~/Library/LaunchAgents/dev.peon.daemon.plist` after `peon stop`
to disable future login starts.

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

By default the daemon binds `0.0.0.0` so it keeps listening when Tailscale comes
up after the service. Overseer reaches the authenticated Fleet HTTP API through
the Peon's MagicDNS name. Only a genuine loopback peer can use the local CLI/MCP
surface; tailnet callers still need the Peon's Fleet bearer. Restrict port 4570
to the tailnet in the host firewall.

- **Tunnel (no config).** Port-forward the control port over a channel you already trust
  (`ssh -L 4570:localhost:4570 you@box`). A forwarded request is
  indistinguishable from a local process to peon and **skips login entirely** — same as the
  "local access is always trusted" behavior above. Only tunnel over SSH you trust as
  much as a shell on this box, and never put the port behind a plain reverse proxy with no
  auth of its own.
- **Tailscale, with Fleet auth.** Open the listener without changing the
  separately configured MagicDNS callback URL:

  ```sh
  peon remote on 0.0.0.0:4570
  ```

  Remote connections aren't loopback, so they require the Fleet credential — only
  genuinely local processes can use local CLI/MCP routes. `peon remote` shows the current
  state and `peon remote off` reverts to loopback-only. **The listen address is read at startup**,
  so restart the daemon after toggling it
  (`systemctl --user restart peon-daemon.service`). Still keep the port firewalled to
  tailnet.

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
| `publicControlUrl` | `http://127.0.0.1:4570` | advertised `http://` or `https://` Tailscale/MagicDNS URL Overseer uses for the control API |
| `listenAddress` | `0.0.0.0:4570` | listener address; wildcard avoids startup races with the Tailscale interface (`127.0.0.1:4570` for local-only). Read at startup — restart to apply |
| `paused` | `false` | whether task polling is on |

## Commands

Lifecycle commands. (Integration commands are listed above, under Configure.)

| command | what it does |
|---|---|
| `peon start` | install, enable, and start the service |
| `peon stop` | stop the service |
| `peon update [--force]` | update to the latest version and restart |
| `peon status` | is it running, is it authenticated, is an update available |
| `peon pause` / `peon resume` | turn task polling off/on |
| `peon settings` | show current settings |
| `peon settings set <key> <value>` | change a setting |
| `peon remote [status]` | show listener and advertised URL |
| `peon remote on <host:port>` | accept remote connections while preserving loopback (see Configure) |
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

Control API: `http://127.0.0.1:4570`. Operator UI: Overseer.

## Developing peon itself

Already have a checkout and want hot-reload instead of the systemd service?

```sh
npm ci
npm run dev
```

This runs the daemon with live reload on save, on the same port (`4570`) the
background service uses — don't run both at the same time.

| npm script | what it does |
|---|---|
| `npm run dev` / `npm run dev:daemon` | daemon, hot reload |
| `npm run restart:daemon` | typecheck, then restart (refuses if a task is running) |
| `npm run update` | same as `peon update` |
| `npm run compile` | compile the CLI and daemon to `dist/` — run after editing anything under `src/` and commit `dist/` |

## More detail

Detailed architecture, development constraints, and machine-specific operating notes live in
the Peon project information injected into agent sessions. Durable decisions and debugging
history also live in commit messages.
