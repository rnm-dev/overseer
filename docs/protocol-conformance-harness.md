# Protocol conformance and failure injection

The private `@rnm-dev/protocol-conformance` workspace validates the shared
control/realtime socket, durable delivery, catalogs, reverse commands and
topology.

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

## Transcript synchronization

The capability fixture executes every cell in the 3 × 3 legacy, stable and
current Peon/Overseer matrix. Transcript history always selects authenticated
Fleet HTTP. There is no reverse-socket transcript capability, snapshot protocol
or durable transcript ACK.

Component tests cover the deliberately small contract: HTTP cursor pagination,
post-append Fleet SSE publication, a bounded newest-50 replay when the live
boundary is missing or unknown, stable-event-ID upsert, reconnect and browser
delivery through the client's existing workspace WebSocket. The canonical Peon
JSONL remains the only message authority; Postgres does not project transcript
rows.

The workspace `verify` script runs these Node tests. Because the package is a
root npm workspace, `npm run verify` includes them through the root
`npm run verify --workspaces --if-present` gate.

## Session catalog convergence

`fixtures/session-catalog-acceptance-v1.json` indexes the authority, snapshot,
commit/ACK, replay, gap/epoch, generation, orphan-liveness, tombstone, offline,
client-merge and bounded-recovery invariants in
[session list and status synchronization](session-list-sync.md). Its objective
SLO clocks and payload-free diagnostic dimensions are machine checked.

`SessionCatalogHarness` reuses `DeterministicTransport` and injects
snapshot/live races, duplicate replay, ACK loss, Peon/Overseer restart, stale
generations, gaps, epoch rollover, crash boundaries, corrupt/oversized pages and
deletion. Component coverage remains in Peon's catalog/orphan suites, Overseer's
socket/projection suites, web's session-list merge suite and Flutter's repository
and cached-repository suites.

## Unified resource projections

`fixtures/resource-sync-acceptance-v1.json` classifies sessions, projects,
Peon/runtime state and workspaces by authority and transport. One
`ResourceProjectionHarness` executes their shared qualified-identity,
monotonic-version, cursor, generation, freshness, bounded-rebuild and
commit-before-ACK lifecycle. This common test does not erase domain protocol
tests or apply catalog semantics to transcript tails, byte streams or commands.

The apply-SLO cells cover sessions, projects and Peon/runtime state through the
same generic client acknowledgement. An acknowledgement is possible only after
the durable client projection and cursor commit, is matched to the exact kind
and cursor, and excludes replay delivery from the live latency clock.

The server route and live-socket suites cover the HTTP proxy and WebSocket
bridge. Peon's session-stream suite covers the disk-commit boundary and bounded
replay. Web and Flutter reconciliation suites cover stable-ID idempotency and
HTTP recovery. See [transcript synchronization](transcript-sync.md).
