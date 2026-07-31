# Peon update channel

Public npm is the only Peon release and update channel. Global installations
check `@rnm-dev/peon` through the public npm registry and install an exact
version such as `@rnm-dev/peon@0.11.3`. Overseer does not publish, approve,
store or proxy Peon release metadata or archive bytes.

Overseer still exposes the owner-only operator control surface and relays it to
the Peon's authenticated Fleet HTTP API:

- `POST /api/v1/control/check-update`;
- `POST /api/v1/control/update`, with optional `{ force: true }`;
- `GET /api/v1/control/update/:requestId`.

`Peon-Request-Id` is the apply idempotency identity. Another check or apply
while one is running or awaiting replacement attestation returns
`409 UPDATE_IN_PROGRESS`.

The Peon reads the npm `latest` metadata immediately before installation and
refuses with `RELEASE_CHANGED` if it differs from the version admitted by the
check. npm performs package integrity verification. The updater installs the
exact version while preserving the existing global npm prefix, validates the
compiled output and restarts the daemon through launchd on macOS or systemd on
Linux. The updater runs detached on macOS and in its own transient systemd unit
on Linux so it survives the service restart.

Before replacement it packs the current installation locally with lifecycle
scripts disabled. Failed installation, validation or restart rolls back from
that local archive without depending on the network. A replacement process
with a different PID completes the durable operation only when its running
package version matches the admitted npm version.

Source checkouts retain the development-only `git fetch` plus `merge --ff-only`
path and require a manual daemon restart. That path is not a production
distribution channel.
