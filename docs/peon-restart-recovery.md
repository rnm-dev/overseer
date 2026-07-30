# Peon restart recovery

Use this checklist if a Peon does not return after `peon restart`. A normal
restart may make it disappear from Overseer briefly; the outbound control and
transfer sockets reconnect by themselves and accepted reverse commands
reconcile with their original command IDs.

## First check

Wait up to 30 seconds, then run:

```sh
peon status
curl -fsS http://127.0.0.1:4570/api/v1/status
```

If the local status endpoint answers but Overseer still shows the Peon offline,
do not restart repeatedly. Check the daemon log for connection, authentication,
capability-negotiation, URL, or clock errors. Temporary network failures use
bounded reconnect backoff and normally heal without another restart.

## Service and logs

Linux/systemd:

```sh
systemctl --user status peon-daemon.service peon-dashboard.service --no-pager
journalctl --user -u peon-daemon.service -n 200 --no-pager
systemctl --user restart peon-daemon.service peon-dashboard.service
```

macOS/launchd:

```sh
launchctl print gui/$(id -u)/dev.peon.daemon
tail -n 200 "${XDG_STATE_HOME:-$HOME/.local/state}/.peon/daemon.stderr.log"
launchctl kickstart -k gui/$(id -u)/dev.peon.daemon
launchctl kickstart -k gui/$(id -u)/dev.peon.dashboard
```

For a source checkout started with `npm run dev`, restart that development
process manually. Do not also start a native background service against the
same ports and state directory.

## Fast diagnosis

- A startup error about `reverse-only` and a non-loopback bind means the safety
  check worked. Keep reverse-only on `127.0.0.1`/`::1`; do not widen the bind to
  recover connectivity.
- `spawn ... ENOENT` means the service environment cannot find the configured
  agent executable. Confirm it with `which`, then run `peon start` once to
  regenerate the native service with the current `PATH`.
- `Failed to connect to bus` on Linux means the user's systemd manager is not
  available. Use a real login session; an administrator may need to enable
  linger for that user.
- A local API that is healthy while Overseer remains offline points to the
  outbound Overseer URL, credential, TLS, DNS, time, or network path—not to the
  local listener.
- Repeated immediate exits require the first startup error from the service
  log. Preserve it before trying an update or reinstall.

## Safety boundaries

- Do not delete or edit the Peon config/state directories as a recovery step.
  They contain identity, credentials, session records, command deduplication,
  durable delivery state, and update recovery data.
- Do not switch to `legacy-mesh`, expose port 4570, or re-enable VPN callbacks
  merely to make the Peon appear online.
- Do not re-enrol or rotate credentials until logs demonstrate an
  authentication or revocation problem.
- Do not use repeated forced restarts while a session may be running. A forced
  restart kills its agent process; inspect the authoritative session state
  after recovery.
- Do not replay a pending mutation with a new command ID. Reverse-command
  recovery reconciles the accepted command with its original ID.

If the process still does not stay up, capture `peon status`, the service
status, and the last 200 daemon log lines. Redact credentials, pairing phrases,
tokens, prompts, and sensitive paths before sharing them.
