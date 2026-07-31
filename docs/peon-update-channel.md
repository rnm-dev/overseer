# Peon update channel

Peon update checks and approved self-updates use only the direct authenticated
Fleet HTTP API over mesh. `update.check` and `update.apply` are not
`reverse-command-v1` operations; there is no selector, fallback or second
request authority.

The machine routes are:

- `POST /api/v1/control/check-update`;
- `POST /api/v1/control/update`, with the approved
  `{ version, revision, sha256 }` identity and optional `force`;
- `GET /api/v1/control/update/:requestId`, returning a bounded pending or
  terminal view.

`Peon-Request-Id` is the apply idempotency identity. The same ID and approved
release replays the existing lifecycle. Reuse with different identity returns
`409 REQUEST_ID_REUSED`; another check or apply while one is running or awaiting
replacement attestation returns `409 UPDATE_IN_PROGRESS`.

Overseer resolves the approved release once and binds version, immutable
release revision and SHA-256 into the apply request. The updater re-fetches
authenticated release metadata immediately before download and returns
`RELEASE_CHANGED` if that identity changed.

Release metadata and the Overseer-served npm archive use authenticated Fleet
HTTP. Bytes never use the control WebSocket, a transfer WebSocket or the
reverse-command ledger. Streaming preserves Range, abort/backpressure, declared
length and SHA-256 verification. Public npm is not the enrolled fleet update
channel.

The detached updater durably writes a mode-0600 receipt containing only request
ID, initiating PID and expected version/revision/SHA-256. It downloads and
verifies the exact archive, transactionally installs it, validates compiled
output, writes the same bounded identity into the installed package and keeps a
locally packed rollback archive. Duplicate delivery does not reinstall or
restart.

Only a replacement daemon with a different PID may complete the operation. Its
running package must report the exact approved version, revision and SHA-256;
changed files, version alone, or a mismatched revision/digest fail with
`ATTESTATION_MISMATCH`. Source checkouts are rejected because they cannot attest
process replacement.

Stable bounded outcomes distinguish no update, registry unavailability,
changed release, download or archive-integrity failure, policy rejection,
install/restart failure with rollback, restart timeout and attestation mismatch.
Credentials, URLs and free-form updater output stay out of receipts and API
results. Realtime update-state notification may remain a WebSocket event, but
it is not a request or command transport.
