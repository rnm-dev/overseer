# Peon update channel

Peon update checks and approved self-updates use only the direct authenticated
Fleet HTTP API over mesh. `update.check` and `update.apply` are not
`reverse-command-v1` operations; there is no selector, fallback or second
request authority.

The in-development [Windows desktop bundle](peon-desktop.md) sets
`PEON_DESKTOP=1` and refuses Fleet check/apply and local apply with
`409 DESKTOP_MANAGED`. Its initial preview is upgraded using the desktop
installer, so an npm update cannot mutate the bundled runtime independently.
Ordinary npm-managed Peons retain the behavior documented below.

The machine routes are:

- `POST /api/v1/control/check-update`;
- `POST /api/v1/control/update`, with only optional `{ force: true }`;
- `GET /api/v1/control/update/:requestId`, returning a bounded pending or
  terminal view.

`Peon-Request-Id` is the apply idempotency identity. The same ID replays the
existing lifecycle; another check or apply while one is running or awaiting
replacement attestation returns `409 UPDATE_IN_PROGRESS`. Peon rejects unknown
body fields instead of accepting caller-supplied release identity.

For a global installation, Peon resolves `@rnm-dev/peon@latest` directly from
the public npm registry. Apply repeats the check, snapshots the resulting exact
version into its mode-0600 operation receipt, and the detached updater resolves
`latest` again immediately before installation. If it changed,
`RELEASE_CHANGED` stops the operation rather than installing a version different
from the admitted one.

Overseer does not store or serve Peon release metadata or package bytes. Its
authenticated browser/mobile route authorizes the owner and relays only the
bounded check/apply/status request over Fleet HTTP. npm supplies both metadata
and bytes directly to Peon and performs its normal package-integrity
verification. No update request or package byte enters the control WebSocket,
a transfer WebSocket or the reverse-command ledger.

The detached updater durably writes a mode-0600 receipt containing only request
ID, initiating PID and expected version; revision and SHA-256 are null for npm
releases. It installs the exact npm spec, validates every compiled JavaScript
entry point, and keeps a locally packed rollback archive before replacement.
Duplicate delivery does not reinstall or restart. A running session blocks the
update unless the owner explicitly chooses force.

Only a replacement daemon with a different PID may complete the operation. Its
running package must report the exact admitted version; npm releases carry null
revision and SHA-256 fields. A mismatched version or non-replacement process
fails with `ATTESTATION_MISMATCH`. Managed Fleet HTTP apply rejects source
checkouts because they cannot attest process replacement; the operator-only CLI
checkout path remains a separate fast-forward workflow.

Stable bounded outcomes distinguish no update, registry unavailability,
changed release, policy rejection, install/restart failure with rollback,
restart timeout and attestation mismatch. Credentials, registry URLs and
free-form updater output stay out of receipts and API results. Realtime
update-state notification may remain a WebSocket event, but it is not a request
or command transport.
