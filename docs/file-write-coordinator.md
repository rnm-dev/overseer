# File-write coordinator

OVSR-229 is the compatible base implementation of `file-write-v1`. OVSR-51
extends that implementation; it does not add another socket, request ledger or
file-write protocol. Project and attachment HTTP routes authorize the
workspace, Peon, project and operator first, select the capability exactly
once, and then hand the already-authorized request stream to
`apps/server/src/peonFileStream.ts`.

## Correlation and lifecycle

Every admitted write has one UUID `transferId` (the existing wire
`requestId`) and one `commandId`. When the caller does not supply a separate
command correlation ID, both IDs are deliberately the same. These fields
correlate the browser request, transfer metadata and terminal Peon result
without enrolling file bytes in the reverse-command ledger. Peon remains the
authority for the atomic filesystem commit and checksum result.

The coordinator lifecycle is `pending` → `accepted` → `streaming` →
`verifying` → `committed`. Refusal, browser abort and timeout map to
`rejected`, `cancelled` and `expired`; terminal entries are removed
immediately and retained only as the existing bounded late-frame tombstone.
Socket object identity fences every inbound frame and connection replacement
settles only work owned by the replaced generation.

## Bounds and backpressure

- Browser bodies are consumed incrementally only after Peon grants byte
  credit. Binary frames are at most 64 KiB including their header.
- The writer never buffers a complete body. Node stream backpressure plus
  Peon credit bounds bytes in flight; control traffic remains on the separate
  control socket.
- Admission reserves the declared content length, or the route's maximum when
  length is unknown. Limits are eight writes and 256 MiB per user, 64 writes
  and 1 GiB per workspace, 32 transfers per Peon, 256 transfers and 4 GiB
  globally. A refusal is the stable, path-free
  `TRANSFER_QUOTA_EXCEEDED`/HTTP 429.
- The safe coordinator snapshot contains only active count, reserved bytes and
  aggregate lifecycle counts. It never contains actor identity, project ID,
  target path, body data or credentials.

Cancellation, transfer timeout, checksum/length refusal, browser stream
failure and socket replacement all release the same admission reservation.
Late terminal frames hit the bounded tombstone and cannot complete a newer
transfer.

## Attachment commit receipts

An attachment upload returns a server-generated receipt `transferId` only
after Peon emits a terminal `write_result` whose path, size and SHA-256 pass
validation. Overseer persists the receipt with its workspace, Peon and
canonical actor. A reverse `session.start` or `session.followup` attachment
reference carries `transferId`, `path`, `size` and `sha256`; the
reverse-command admission transaction binds every receipt to the command ID
and complete request fingerprint before inserting the durable command.

A receipt is reusable only by an idempotent replay of that exact fingerprint.
A different actor, Peon, workspace, session, command, path, size or digest
fails closed. Receipts expire after one hour; commands remain bounded to 20
attachments, 25 MiB per attachment and 100 MiB aggregate bytes.

Peon's completed-write replay cache remains process-local. Overseer therefore
never reconstructs a receipt from a path after restart: when the terminal
result was not durably recorded, the client must upload again. This explicit
restart boundary prevents unfinished or unverifiable bytes from entering
durable command admission.

## Task mapping

OVSR-229 owns the released-compatible transport and Peon receiver. OVSR-51
owns the Overseer coordinator additions documented here: correlation,
admission quotas, aggregate observability and lifecycle/boundary tests.
OVSR-49 remains responsible for public route and ACL integration not already
landed by OVSR-229. OVSR-53 retains receiver work not present in the base
implementation. All follow-ups extend `file-write-v1`.
