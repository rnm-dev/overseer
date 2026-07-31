# Protocol conformance and failure injection

The private `@rnm-dev/protocol-conformance` workspace validates the shared
control/realtime socket, durable delivery, catalogs, reverse commands,
transcript synchronization and topology.

For OVSR-292 the transfer handshake, file-read/write frames, lifecycle harness
and fixtures were removed. The capability matrix now routes directory
listings, file bodies, Range/download, uploads/mutations and session artifacts
to `legacy-http`, meaning the authenticated Fleet HTTP API over mesh. The
topology harness rejects a `file-transfer` reverse channel and permits these
explicit byte surfaces on Fleet HTTP.

Update conformance asserts one authenticated Fleet HTTP authority for check,
apply, operation status, approved metadata and archive bytes. The retired
`update.check`/`update.apply` reverse operations and lifecycle fixtures are
absent.
