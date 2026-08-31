# Session list and status synchronization

Peon is the sole authority for a session summary and whether a run is live.
Overseer stores an offline-capable projection; web and Flutter store or render
that projection. A client-side running hint may bridge a just-accepted command,
but it is fenced by activity time and retires when a newer Peon summary arrives.

Catalog reads and mutations use authenticated Fleet HTTP over mesh.
`session-catalog-v1` plus `durable-delivery-v1` is the exclusive realtime
projection channel. The pair is negotiated atomically; there is no second event
push or reverse-command authority.

## Convergence contract

The executable acceptance index is
`packages/protocol-conformance/fixtures/session-catalog-acceptance-v1.json`.
`SessionCatalogHarness` reuses the shared deterministic fault transport and
models the production transaction: projection, delivery inbox, catalog
checkpoint and ACL-scoped browser event commit before either catalog or durable
ACK.

The stable invariants are:

- **SCA-AUTHORITY** — Peon owns summary/status; Fleet HTTP owns explicit reads;
  the socket is a projection only.
- **SCA-SNAPSHOT-BARRIER** — a frozen paged snapshot commits atomically, then
  only events beyond its barrier apply.
- **SCA-COMMIT-BEFORE-ACK** and **SCA-REPLAY-IDENTITY** — no uncommitted frame is
  acknowledged and a replay produces at most one visible effect.
- **SCA-GAP-EPOCH-RECOVERY** and **SCA-GENERATION-FENCE** — gaps, lost cursors,
  epoch rollover and replaced sockets force a bounded snapshot; late frames
  cannot mutate or ACK.
- **SCA-ORPHAN-LIVENESS** — Peon reconciles `status: running` against its live,
  resume-pending and steer-pending registries before list, page, detail or Stop
  returns. It also fences and interrupts registry entries whose durable summary
  is terminal or missing. Reconciliation persists and publishes one terminal
  summary, and fleet activity counts only the reconciled registry.
- **SCA-TOMBSTONE-MONOTONICITY** and **SCA-CLIENT-MONOTONICITY** — `(peonId,
  sessionId)` is identity; `syncedAt` fences REST/socket/cache races and stale
  deletion tombstones.
- **SCA-OFFLINE-TRUTHFULNESS** — cached rows remain available with explicit
  `syncing`, `ready`, `stale`, `offline`, `fallback` or legacy state. Transport
  loss never rewrites Peon's last summary.
- **SCA-BOUNDED-RECOVERY** — snapshot pages, items, bytes, buffered events,
  frame bytes and timers all fail closed at protocol limits.

The deterministic suite injects snapshot/live overlap, drop, duplicate, ACK
loss, gap, epoch mismatch, reverse ordering, Peon and Overseer restart, stale
generation, crash before/after commit, corrupt pages, pressure and deletion.
Peon, server, web and Flutter component tests are mapped in the fixture so a
covered invariant cannot silently lose its executable owner.

## SLO clocks

The population is authorized rows on negotiated canonical peers while both
endpoints remain available. Payload-free collectors use these clocks:

| SLO | Start → stop | p99 ceiling |
| --- | --- | ---: |
| SCS-HEALTHY | Overseer event commit → authorized client apply | 2 s |
| SCS-RECONNECT | control catalog sync start → catalog frontier current | 5 s |
| SCS-RESTART | control catalog sync start → catalog frontier current | 10 s |
| SCS-REBUILD | snapshot request admitted → catalog frontier current | 30 s |
| SCS-CLIENT-RESUME | foreground socket connected → visible list current | 5 s |

The server records fixed-bucket histograms for snapshot, reconnect and
commit-to-client-apply latency. Web acknowledges after its session reducers run;
Flutter acknowledges only after projection and durable workspace cursor commit
in one local database transaction. The server uses its own bounded event clock,
not a client-supplied timestamp. `SCS-CLIENT-RESUME` remains planned until both
clients expose one foreground-to-paint clock. Diagnostics may carry hashed
identities, epochs, generations, counts, duration and stable failure codes,
never titles, prompts, previews, transcript content, credentials or paths.

## Client recovery

Web merges paged REST results and committed `session` events by qualified
identity and monotonic `syncedAt`; attention has its own monotonic timestamp.
Flutter transactionally applies each live projection and advances its durable
workspace cursor in the same local database transaction. Both retain cached
rows during transport loss. Flutter refreshes at startup and periodically;
web refreshes the REST-owned list while the resumable workspace socket supplies
committed deltas. Foreground/reconnect recovery is idempotent in both cases.
