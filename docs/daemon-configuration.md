# Reverse daemon configuration

`daemon-configuration-v1` makes the Peon's safe daemon settings available
without an Overseer-to-Peon HTTP connection. It requires both
`durable-delivery-v1` and the generic `reverse-command-v1` operation
`daemon.configuration.patch`.

The complete projected document contains exactly `name`, `defaultAgent`,
`fileTransferRoot`, `heartbeatIntervalMs`, `aiDefaultModel`, and `soul`.
Credentials, enrollment identity, URLs, bind addresses, executable paths and
`paused` are rejected rather than ignored.

Peon remains authoritative. Every state carries an independent configuration
epoch, monotonic revision, schema version and canonical SHA-256 digest.
Overseer commits the full projection, shared durable inbox/checkpoint and an
owner-only, value-free browser event before acknowledging the durable cursor.
An exact transport replay, including one received after newer revisions, returns
the already committed cumulative acknowledgement without regressing state. A
second message carrying the same revision and digest advances the inbox but has
no second projection or browser effect. Reuse of a message ID/cursor with a
different identity and a same-revision/different-digest delivery are protocol
faults.

The owner-only existing `GET/PATCH
/api/workspaces/:workspaceId/peons/:peonId/settings` surface selects exactly one
transport:

- after the capability is negotiated and an initial projection is committed,
  reads use the projection and patches use the shared reverse command gateway;
- older/unnegotiated Peons retain the legacy HTTP route;
- a selected reverse command is never retried over HTTP.

Patches are partial but strictly allowlisted and always carry the last committed
`{ epoch, revision, digest }` as `expected`. A stale patch returns a conflict.
Accepted commands retain their ordinary gateway lifecycle and status URL.
Callers that retry one logical PATCH may retain its `Peon-Request-Id` UUID;
Overseer forwards it as the shared command ID, so same-body retries reconcile
instead of creating another mutation.
Terminal command commit updates the projection, generic command record, audit
row, browser event and shared durable checkpoint in one transaction. Restart
metadata is returned to the caller but never causes an automatic restart.
Terminal tuples are strict: applied/noop require `OK` and the corresponding
revision transition, stale conflicts require `REVISION_CONFLICT`, validation
rejections carry bounded safe field errors, and the digest must match the full
returned safe document. A delayed terminal replay cannot replace a newer
revision or a newer configuration epoch.
