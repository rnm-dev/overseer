# The account Peon runs as

A Peon is a per-user background service, not a system daemon. It has no user
model of its own ([Peon is CLI-only](peon-cli-only.md)), so the account that
runs `peon start` is the whole security and capability boundary: the agent CLI's
credentials, the SSH and git identity, the npm prefix, the readable parts of the
filesystem and the home directory all come from that account. Choosing it and
keeping its session alive is an install decision, and most "the Peon went
offline" reports trace back to it.

## Run it as a regular login user

Do not install Peon with `sudo` or as `root`. `peon start` writes a per-user
unit — `~/.config/systemd/user/` on Linux, `~/Library/LaunchAgents/` on macOS —
and enables it for whoever invoked it. Under `sudo` the service is installed for
`root`, and the agent CLI it spawns then looks for Claude Code or Codex
credentials in `/root`, which is not where you authenticated them.

The account must be able to log in. `su`-ing into a service account with no
login session gives you a shell but not a user manager, and the install fails at
the first `systemctl --user` call.

One Peon per account. The state directories are per-user, so a second Peon needs
a second account — but the control port is not: both would default to 4570 and
the second one loses. Give it a different port with `ACA_CONTROL_PORT`, or keep
one Peon per machine. The same collision applies to a source checkout started
with `npm run dev` — do not run it against the same port and state directory as
an installed service.

## Linux: linger keeps it alive after logout

Peon runs under the systemd **user** manager. By default that manager is started
at login and stopped when the user's last session ends, which would take the
daemon down the moment you close an SSH connection, and would never start it at
boot. Lingering is what removes that coupling.

`peon start` enables it for you — it runs `loginctl enable-linger <user>` right
after `systemctl --user enable --now`. It is not a step to perform separately,
but it is a step that can fail: on hosts with a restrictive polkit policy the
call needs an administrator. Check the result rather than assuming it:

```sh
loginctl show-user "$USER" --property=Linger
```

`Linger=yes` is what you want. If it says `no`, an administrator runs:

```sh
sudo loginctl enable-linger <user>
```

`peon start` also refuses to continue when `systemctl` or `loginctl` are
missing, because there is no persistent service to install without them.

**`Failed to connect to bus`** means the session has no user manager to talk to —
typically `sudo -u`, `su`, a cron job, or any context without `XDG_RUNTIME_DIR`
and a session bus. Get a real login session instead of a switched shell:
`ssh <user>@<host>`, or `sudo machinectl shell <user>@`.
If you must stay in `su`, enable linger first (so `/run/user/<uid>` exists), then
`export XDG_RUNTIME_DIR=/run/user/$(id -u)` before `peon start`; add
`DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus` only if it still fails.
The public docs carry this under Common issues (`ovrseer.org/docs/#troubleshooting`).

**An encrypted or network home directory defeats linger.** If the home is
mounted at login (ecryptfs, an automounted NFS home), it is not there at boot,
so the lingering manager starts with no unit files and no state. Give Peon an
account with a plain local home.

## macOS: there is no linger

The launchd agent is installed with `RunAtLoad` and `KeepAlive`, so it starts
with the GUI login session and launchd restarts it if it crashes. There is no
equivalent of lingering: a Mac sitting at the login window runs no Peon. A Mac
meant to stay available needs automatic login enabled and the console session
left signed in. Sleep settings matter for the same reason.

## The unit is generated, and it freezes your environment

Both units are generated at install time rather than shipped fixed, so they
point at the node that actually ran `peon start` (`process.execPath`) and at the
`PATH` that invocation saw. That makes the install work regardless of nvm,
volta, Homebrew or the npm prefix — and it means the unit is a snapshot:

- installing or authenticating an agent CLI *after* `peon start` leaves it
  invisible to the service. `spawn claude ENOENT` in the log is this, not a
  broken install;
- removing or upgrading the node version that ran the install breaks
  `ExecStart`.

One directory is not left to chance: `serviceEnvPath` in
`apps/peon/src/cli/servicePath.ts` appends `~/.local/bin` to the baked `PATH`
when the install shell did not already have it, because uv, pipx and a
user-level npm prefix install executables there and a non-login shell often
omits it. It is appended, never prepended, so an operator who already has the
directory keeps their own precedence.

The fix in the two cases above is to run `peon start` again from a shell with the
environment you want; it regenerates the unit in place. Alternatively pin the
executable explicitly, which survives a `PATH` change:

```sh
peon settings set agentCommand /path/to/claude
peon settings set codexCommand /path/to/codex
```

## State lives in the account's XDG directories

Config, state and data are `~/.config/.peon`, `~/.local/state/.peon` and
`~/.local/share/.peon`, each honouring the matching `XDG_*_HOME` override. The
override is read by both the CLI and the daemon, from their own environments —
so exporting `XDG_STATE_HOME` in your interactive shell alone makes `peon`
address a different directory than the running service. Either set such an
override for the user manager as a whole, or do not set it at all.

Those directories hold identity, credentials, session records, command
deduplication and update recovery state. They are not a cache; see the safety
boundaries in [Peon restart recovery](peon-restart-recovery.md) before deleting
anything in them.

## Where the control port listens is a separate decision

The account decides who Peon *is*; `listenAddress` decides who can reach it.
Check the current one before assuming, because the built-in default in
`apps/peon/src/daemon/settings/settingsStore.ts` is `0.0.0.0:4570`, not
loopback:

```sh
peon settings
```

`peon status` labels it `loopback only — no remote access` or
`remote + loopback`. `peon remote off` narrows it to `127.0.0.1`, and
`ACA_LISTEN_ADDRESS` overrides the stored value for one run. Whatever the
listener does, the address Overseer is told to call back on stays operator-owned
configuration that Peon never infers from a request — see
[callback addressing](callback-addressing.md).
