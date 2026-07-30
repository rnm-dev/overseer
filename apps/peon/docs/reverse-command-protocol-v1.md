# Reverse command protocol v1

Status: normative design contract for implementation  
Capability: `reverse-command-v1`  
Operations include `session.detail`, `session.cancel`, `project.archive`, `project.unarchive`,
`daemon.configuration.patch`, `update.check`, and `update.apply`

This document defines the common command lifecycle used when Overseer controls a Peon through
Peon's outbound control WebSocket. It complements the channel-specific wire contract in
repository-root `PROTOCOL.md`. Peon remains authoritative for command admission and effects;
Overseer remains authoritative for operator authorization and its rebuildable projections.

Remote daemon pause/resume is intentionally not part of this protocol. Overseer may display the
daemon's paused state as read-only runtime status, but only a local Peon caller may change it.

## Transport and capability

Commands use the authenticated control connection at `/api/v1/peons/ws`. File bodies use the
independent transfer connection. A peer must not send a command until `reverse-command-v1` was
offered by Peon and echoed by Overseer in `hello_ack`.

The complete UTF-8 JSON command frame is limited to 60 KiB. Operation-specific limits may be
smaller. Binary data, unbounded tool output, transcripts, files, and archives never enter a
command frame.

`reverse-command-v1` requires:

- stable Peon identity in the authenticated socket generation;
- server-derived actor identity;
- a UUID command ID;
- durable Peon-side admission for mutating commands;
- durable terminal result delivery through `durable-delivery-v1`;
- idempotent replay on both sides.

## Envelope

Overseer sends:

```json
{
  "type": "command",
  "protocol": 1,
  "capability": "reverse-command-v1",
  "commandId": "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
  "operation": "session.cancel",
  "target": {
    "peonId": "f4de920f-e33e-4cf5-97d0-3a75e9266090",
    "sessionId": "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5"
  },
  "actor": {
    "userId": "b169219d-45f6-4f42-b78f-3fb931dac7ee",
    "email": "operator@example.com"
  },
  "payload": {},
  "requestedAt": 1784912400000
}
```

Peon sends an ephemeral acceptance only after the command record is durable:

```json
{
  "type": "command_accepted",
  "protocol": 1,
  "commandId": "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
  "operation": "session.cancel",
  "state": "accepted",
  "replayed": false,
  "acceptedAt": 1784912400010
}
```

The terminal result is a typed payload in the existing durable envelope:

```json
{
  "type": "durable_message",
  "epoch": "delivery-epoch",
  "cursor": "0000000000000042",
  "messageId": "b47f43a9-a537-4af7-abcf-ad7acfef8904",
  "priority": "critical",
  "capability": "reverse-command-v1",
  "payload": {
    "type": "command_result",
    "protocol": 1,
    "commandId": "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    "operation": "session.cancel",
    "status": "applied",
    "code": "OK",
    "completedAt": 1784912400040,
    "result": {
      "sessionId": "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5",
      "sessionStatus": "cancelled"
    }
  }
}
```

Overseer acknowledges the result only after committing its inbox record, command outcome, audit
record, projection change, and authorized browser event:

```json
{
  "type": "durable_ack",
  "epoch": "delivery-epoch",
  "cursor": "0000000000000042"
}
```

## Reconciliation frames

After reconnect or an HTTP wait timeout, Overseer reuses the same command ID:

```json
{
  "type": "command_status_request",
  "protocol": 1,
  "commandId": "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a"
}
```

Peon answers ephemerally with one of `unknown`, `accepted`, `running`, or `terminal`. A terminal
response repeats the stored result. It does not replace durable result delivery.

```json
{
  "type": "command_status",
  "protocol": 1,
  "commandId": "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
  "state": "terminal",
  "result": {
    "type": "command_result",
    "protocol": 1,
    "commandId": "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    "operation": "session.cancel",
    "status": "applied",
    "code": "OK",
    "completedAt": 1784912400040,
    "result": {
      "sessionId": "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5",
      "sessionStatus": "cancelled"
    }
  }
}
```

`command_cancel` is reserved for operations whose operation-specific contract explicitly declares
cancellability. Cancelling an agent session uses `session.cancel` as the primary command; it is
not cancellation of another command envelope.

## Identity, validation, and hashing

- `commandId`, Peon ID, user ID, session ID, project ID, transfer ID, and message ID use canonical
  lowercase UUID text when that identity is UUID-backed.
- Overseer derives `actor` from the authenticated server session. Actor fields from a browser
  request are ignored.
- The authenticated socket Peon must equal `target.peonId`. A mismatch is a protocol violation and
  closes the connection.
- Peon validates the entire envelope and operation payload before durable admission.
- Unknown top-level fields are rejected in v1. Operation payloads are strict and reject unknown
  fields.

For command-ID reuse detection, both sides calculate lowercase SHA-256 over RFC 8785 canonical JSON
of:

```json
{
  "protocol": 1,
  "capability": "reverse-command-v1",
  "operation": "<operation>",
  "target": "<complete target object>",
  "actor": "<complete actor object>",
  "payload": "<complete payload object>",
  "expected": "<complete expected object or null>"
}
```

`commandId` and `requestedAt` are excluded. Same ID and same hash replays the stored lifecycle.
Same ID with a different hash returns `COMMAND_ID_REUSED` and performs no effect.

## Lifecycle and failure semantics

| State | Durable on Peon | Meaning | Retry rule |
|---|---:|---|---|
| received | no | Frame may still fail validation or persistence | Same ID is safe |
| accepted | yes | Peon owns eventual execution/result | Same ID only |
| running | yes | Effect is in progress | Status query; do not create another ID |
| terminal | yes | Stored terminal outcome exists | Replay same outcome |
| acknowledged | yes until compaction | Overseer committed terminal outcome | Replay remains harmless |
| expired | tombstone | Retained result was compacted | Return `COMMAND_EXPIRED` |

Disconnect before `command_accepted` leaves admission unknown to Overseer, so it retries the exact
same ID and body. Disconnect after acceptance is never reported as failure. An HTTP caller receives
`202` with the command ID if the terminal result is not observed within its bounded wait.

Peon must persist mutating admission before acceptance. It must persist the terminal outcome before
enqueueing the durable result. A crash at either boundary may cause replay, never a second effect.

Terminal results stay in the Peon ledger until their durable cursor is acknowledged and for at
least seven days after completion. The default bound is 10,000 terminal records or 32 MiB of
serialized ledger data. Peon rejects new mutating commands with `COMMAND_LEDGER_FULL` rather than
evicting an unacknowledged result. Expired records retain bounded command-ID/hash tombstones for
another seven days.

## Generic result statuses

| Status | Meaning |
|---|---|
| `applied` | Requested effect occurred |
| `noop` | Desired state was already true or the target was already terminal |
| `rejected` | Valid envelope, but operation validation or policy rejected it |
| `conflict` | Expected revision/state did not match |
| `cancelled` | A cancellable command ended without its intended effect |
| `failed` | Admitted execution failed |

Operation-specific stable codes remain authoritative. Generic codes are:

- `OK`
- `BAD_COMMAND`
- `COMMAND_ID_REUSED`
- `COMMAND_EXPIRED`
- `COMMAND_LEDGER_FULL`
- `CAPABILITY_UNAVAILABLE`
- `PEON_OFFLINE`
- `COMMAND_PENDING`
- `COMMAND_TIMEOUT`
- `PERSIST_FAILED`
- `INTERNAL`

## Operator HTTP mapping

| Condition | HTTP | Stable code |
|---|---:|---|
| Peon offline before send | 503 | `PEON_OFFLINE` |
| Capability not negotiated | 503 | `CAPABILITY_UNAVAILABLE` |
| Reused ID with different request | 409 | `COMMAND_ID_REUSED` |
| Operation conflict | 409 | operation-specific |
| Validation/policy rejection | 400/403/404/429 | operation-specific |
| Terminal applied/noop | existing route success status | `OK` |
| Accepted but terminal result not observed | 202 | `COMMAND_PENDING` |
| No acceptance before bounded timeout | 504 | `COMMAND_TIMEOUT` |
| Admitted execution failed | existing safe 5xx mapping | operation-specific or `INTERNAL` |

The response for `COMMAND_PENDING` contains `commandId` and a command-status URL. Overseer must not
retry with a new command ID.

## Session operation: `session.cancel`

`session.cancel` requires `target.sessionId`, an empty payload, and an authenticated actor. It is
high priority.

- Running session successfully interrupted: `applied`, `OK`.
- Session already terminal/cancelled: `noop`, `OK`, returning current public session state.
- Unknown session: `rejected`, `UNKNOWN_SESSION`.
- Session exists but cannot currently be cancelled: `rejected`, `SESSION_NOT_RUNNING`.
- Duplicate command: replay the original result without a second interrupt or transcript result.

## Project archive operations

`project.archive` and `project.unarchive` require `target.projectId`, an empty payload, and an
authenticated actor. They update reversible `archivedAt` metadata without deleting the project
directory or its sessions. A project already in the requested state returns `noop` with code
`OK`; an unknown immutable project identity returns `rejected` with code `UNKNOWN_PROJECT`.

Each additional operation requires explicit support in both peers and entry in the capability
matrix.

## Project administration and resources

Project administration uses `project.create`, `project.suggest-directory`,
`project.detail`, `project.settings.get`, `project.settings.update`,
`project.delete`, `project.documentation.index`, `project.documentation.read`,
`project.skills.list`, and `project.quick-links.{list,create,update,delete}`.
After creation/suggestion, every operation targets immutable
`target.projectId`; mutable keys never identify a command target.

Settings updates, deletion, and quick-link mutations require the lowercase
SHA-256 `expected.digest` returned by a settings/detail read. A mismatch is
`conflict/PROJECT_CONFLICT`, preventing key reuse or concurrent rename from
redirecting an operation. The shared durable ledger supplies replay and
deduplication, while successful mutations publish through
`project-catalog-v1`.

Documentation paths remain contained by `ProjectService` inside `docs/`.
Individual page reads accept byte-based `offset` and `limit`, cap content chunks
at 32 KiB, never split a UTF-8 sequence, and return the next byte offset in
`nextOffset`. Negative offsets and limits outside `1..32768` are rejected before
admission.

The documentation index is a bounded snapshot (2 MiB aggregate maximum) split
into UTF-8-safe pages. The first command carries an optional `limit`; later
commands carry the opaque `cursor` returned as `nextCursor`. Each result contains
`snapshotDigest`, `byteOffset`, `totalBytes`, `chunk`, `cursor`, and
`nextCursor`. The cursor binds the offset to the complete snapshot digest:
malformed cursors return `INVALID_CURSOR`, while a filesystem change invalidates
the prior identity with `conflict/CURSOR_EXPIRED`. Each page is an ordinary
deduplicated reverse command; there is no pagination ledger or frame dialect.

## Peon update operations

`update.check` takes an empty payload. `update.apply` requires
`release: { version, revision, sha256 }` and accepts optional `force`; both
target the authenticated Peon without a session. Overseer resolves that
immutable identity before admission, so it is part of the canonical request
hash and survives gateway restart/reconciliation.
They reuse the shared durable admission, dedupe, reconciliation, and terminal
result lifecycle. Apply persists a receipt across process replacement and
returns `OK` only when the replacement daemon's running
version/revision/SHA-256
matches the expected release inputs.

The release mechanism remains the authenticated Overseer registry with exact
archive size and SHA-256 verification plus local rollback. The receipt and
terminal result contain no credential, archive URL, or download grant.
All three approved identity fields are rechecked after fetching metadata so a
moving `latest` release cannot silently change the artifact. `OK` requires a daemon
process different from the admitting process; files updated on disk do not
count as reconnect attestation. Download, integrity, install, rollback,
restart, timeout, and attestation failures have distinct stable codes.

## Daemon configuration operation

`daemon.configuration.patch` is owned by `daemon-configuration-v1` and is
available only when that capability and `durable-delivery-v1` are negotiated.
It targets the authenticated Peon, carries `{ "patch": { ... } }`, and requires
an `expected` configuration epoch, revision, and digest. The operation reuses
this protocol's admission, request hashing, ledger, status reconciliation, and
durable terminal result. The typed result contains the complete safe
configuration identity and values; no private setting may appear in it.

## Armory operations

`armory-command-v1` uses this dispatcher for inventory, settings, package,
configuration, MCP and operation reads plus refresh, install, update, enable,
disable, configure, verify, configuration deletion and uninstall. Package
operations require exactly one `packageId`; operation reads require exactly one
`operationId`; fleet-wide inventory, refresh and settings require neither.

The durable command ID is the lifecycle idempotency key. A replay therefore
returns the admitted operation/result from the shared reverse-command ledger
and never invokes an install, hook, configuration write or uninstall twice.
Armory's own package locks, transactional staging, recovery journals and
rollback remain authoritative below the dispatcher.

Results are capped at 48 KiB. Operation results expose only identity, kind,
state, phase, percentage, stable error code and timestamps. Hook messages are
blanked, and submitted configuration values, archive bodies, credentials and
raw diagnostics never enter command results. Registry URLs fail closed unless
they are credential-free HTTPS URLs. Armory package archives remain
Peon-initiated authenticated downloads; the control socket carries metadata
only. Running operations are recovered by the existing Armory journals after a
Peon restart and reconciled through `armory.operation`.

## Fleet surface capability matrix

`projection` means Overseer serves a committed local projection. `query` and `command` use the
control socket. `transfer` uses the dedicated transfer socket. `local-only` is deliberately not
available to Overseer.

| Existing Peon fleet surface | Target authority | Planned capability | Actor | Migration rule |
|---|---|---|---:|---|
| `POST /enroll` | outbound claim | `peon-claim-v1` | operator approval | Legacy callback only until claim ships |
| `GET /status` | projection | `runtime-state-v1` | no | Legacy HTTP until initial projection commits |
| `PATCH /status` | local-only | none | n/a | Do not migrate remote pause |
| `GET /models` | projection | `runtime-state-v1` | no | Legacy HTTP until ready |
| `GET /quota[/:provider]` | query | `runtime-query-v1` | yes | Exclusive query or legacy HTTP |
| `GET /capabilities[/:provider]` | projection/query | `runtime-state-v1` | no/yes | Projection where safe; bounded query otherwise |
| `GET /filesystem[/…]` | query | `folder-listing-v1` | yes | Reverse channel already available |
| `GET /projects` | projection | `project-catalog-v1` | no | Reverse channel already authoritative after sync |
| `GET /projects/suggest-dir` | query | `project-command-v1` | yes | Reverse query or legacy HTTP |
| `POST /projects` | command | `project-command-v1` | yes | Stable command ID; catalog confirms state |
| `GET /projects/:key` | projection | `project-catalog-v1` | no | Resolve mutable key to immutable project ID |
| `GET /projects/:key/docs[/…]` | query | `project-command-v1` | yes | Bound response; transfer if oversized |
| `GET /projects/:key/skills` | query | `project-command-v1` | yes | Bound response |
| quick-link list/create/update/delete | projection/command | `project-command-v1` | mutations | Stable project and quick-link IDs |
| project settings read/update | projection/command | `project-command-v1` | mutation | Revision-fenced mutation |
| `POST /projects/:key/archive` | command | `reverse-command-v1` | yes | `project.archive`; stable project ID |
| `DELETE /projects/:key/archive` | command | `reverse-command-v1` | yes | `project.unarchive`; stable project ID |
| `DELETE /projects/:key` | command | `project-command-v1` | yes | Stable project ID; catalog tombstone confirms |
| project file list/read | query/transfer | `folder-listing-v1`, `project-file-read-v1` | yes | Project-scoped listings use negotiated entry metadata; reverse channels available |
| project file put/patch/delete | command/transfer | `project-file-write-v1` | yes | Atomic write and exclusive route |
| `GET /settings` | projection | `daemon-configuration-v1` | no | Safe allowlist only |
| `PATCH /settings` | command | `daemon-configuration-v1` | yes | `paused` is forbidden remotely |
| `GET /stats`, `GET /analytics` | projection/query | `runtime-state-v1`, `runtime-query-v1` | yes | Bounded filters; explicit freshness |
| `GET /sessions`, `GET /sessions/:id` | projection | `session-catalog-v1` | no | Reverse channel already authoritative after sync |
| `PATCH /sessions/:id` | command | `session-command-v1` | yes | Revision/state fenced |
| transcript read and session stream | projection/event | `session-transcript-v1` | subscription | Snapshot barrier plus durable live events |
| session files/raw/stream/preview | query/transfer | `session-artifact-v1` | yes | Metadata on control, bytes on transfer |
| `POST /sessions` | command | `session-command-v1` | yes | Existing request ID becomes command ID |
| follow-up | command | `session-command-v1` | yes | Same-ID replay cannot duplicate user turn |
| queue list/add/edit/send/delete | projection/command | `session-command-v1` | yes | Durable queue identity and command dedupe |
| cancel | command | `reverse-command-v1` first slice | yes | High-priority, idempotent |
| delete session | command | `session-command-v1` | yes | Stable session ID |
| `POST /control/pause`, `/control/resume` | local-only | none | n/a | Overseer support must be removed |
| check update / self-update | command | `peon-update-v1` | yes | Success only after reconnect attestation |
| generic `/files` get/put | legacy-only | none | yes | Replace with stable project/session transfer operations |
| Armory catalog/package/settings reads | projection | `armory-state-v1` | no | Safe projection after initial commit |
| Armory refresh/install/update/enable/disable/uninstall | command | `armory-command-v1` | yes | Long-running accepted operation |
| Armory configuration put/delete | command | `armory-command-v1` | yes | Secret values never persist in Overseer |

Registration and heartbeat are discovery-era HTTP operations, not operator fleet routes. Socket
identity/presence and runtime projections replace them only after outbound claim and reverse-only
mode ship.

## Data-plane allocation

| Data | Socket |
|---|---|
| Commands, acceptance, status, metadata, errors | control |
| Durable terminal results and projections | control |
| Transcript events within control-frame limits | control |
| Folder listing pages | control |
| File metadata, credit, cancellation, terminal transfer status | transfer |
| File, attachment, artifact, archive, and preview bytes | transfer binary |

No feature may open a third connection or introduce an HTTPS spool without a new protocol decision.

## Compatibility and rollout

- Capability choice is per Peon socket generation and operation family.
- One operator action uses either reverse command or legacy HTTP, never both.
- Capability negotiation alone is insufficient for a projection: the initial snapshot/state must
  commit before it becomes authoritative.
- A reverse-capable Peon may have no callback URL.
- Mixed-version fleets keep legacy HTTP until the corresponding capability is ready.
- Removal of legacy callbacks is a separate rollout gate after conformance, security, and no-inbound
  soak tests.

## Machine-readable contract

### Armory operation family

Armory uses `target.packageId` (or `target.operationId` for operation reads).
Read operations are `armory.inventory`, `armory.settings`, `armory.package`,
`armory.configuration`, `armory.mcp`, and `armory.operation`; mutations are
`armory.refresh`, `armory.install`, `armory.update`, `armory.enable`,
`armory.disable`, `armory.configure`, `armory.verify`, `armory.configuration.delete`, and
`armory.uninstall`. All share the normal durable admission, replay, status, and
terminal-result lifecycle. Results are limited to 48 KiB and operation output
is reduced to stable metadata; configuration values and hook messages are
forbidden from terminal frames.

The canonical schema and golden examples live under `protocol/reverse-command-v1/`. Overseer
vendors the exact files and both repositories run a contract test over them. Any breaking envelope
change requires a new capability version.
