# `file-write-v1`

OVSR-229 is the base implementation of the transfer-socket file mutation
protocol. OVSR-53 completes the Peon receiver; it does not introduce the older
planned `project-file-write-v1` capability or a second command ledger.

The negotiated `file-write-v1` capability accepts three `write_open`
operations:

- `upload` streams a project or sandbox body under byte credit;
- `move` atomically renames one project file without replacing a destination;
- `delete` removes one regular project file.

Move and delete carry the immutable `projectId`, a strict project-relative
`relativePath`, the server-derived actor, and stable UUID correlation. The
`transferId` must equal `requestId`; `commandId` must be a UUID and is included
in the replay fingerprint. Invalid or cross-wired correlation fails with
`BAD_CORRELATION` before filesystem admission. Move also carries `destination`.
Both bodyless mutations consume the same bounded
admission pool as uploads. They retain request ownership while the native
operation settles, even after cancellation, timeout, disconnect, or socket
replacement. A terminal result is kept in the bounded process-local replay
cache: equal input replays it, changed input returns `REQUEST_ID_REUSE`, and a
retry while work is pending returns `DUPLICATE_REQUEST`.

Filesystem effects are rooted in one opened project directory. Parent
resolution is handle-relative and contained, targets must be regular files,
and symlink/traversal escapes fail closed. Uploads write and hash an exclusive
temporary sibling, fsync the file, atomically rename, then fsync the anchored
parent directory. Move is a native no-replace rename. Delete checks the target
through the anchored parent, unlinks it relative to that handle, and fsyncs the
parent directory. Unsupported secure primitives return
`UNSUPPORTED_PLATFORM`.

The process-local replay cache is deliberately the OVSR-229 v1 contract. It is
not a durable reverse-command receipt: Overseer must not retry a timed-out
mutation through legacy HTTP, and a daemon restart makes an unknown old
request eligible for a new admission. Durable cross-restart destructive
receipts are still a blocked conformance cell. They require a future versioned
contract that durably admits before the transfer effect, binds transfer results
to the control outbox/ACK lifecycle, and reuses the OVSR-129 reverse-command
ledger. Injecting that ledger into the current transfer-only channel would not
be sufficient and would silently change the released admission/recovery
semantics.

Optimistic file identity/revision fences are likewise a blocked conformance
cell. No released frame field defines their identity, digest, or conflict
result, so the receiver deliberately does not accept an invented fence.
