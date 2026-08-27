# Reverse command protocol v1

Status: normative design contract for implementation  
Capability: `reverse-command-v1`  
Update, session, project, daemon configuration, runtime-query and Armory
request/response traffic uses authenticated Fleet HTTP and is not part of this
capability.

This document defines the common command lifecycle used when Overseer controls a Peon through
Peon's outbound control WebSocket. It complements the channel-specific wire contract in
repository-root `packages/protocol/PROTOCOL.md`. Peon remains authoritative for command admission and effects;
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

## Envelope and reconciliation

The v1 envelope and ledger remain documented for persisted historical command
records, but the current operation set is empty. A current Peon advertises no
settings operation and Overseer sends no command, acceptance, status, or
terminal-result frame for daemon configuration.

`command_cancel` is reserved for operations whose operation-specific contract explicitly declares
cancellability. Cancelling an agent session uses Fleet HTTP session cancel as the primary command; it is
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

Peon persists ordinary ledger transitions as checksummed, fsynced append-only journal mutations;
it does not rewrite the complete retained ledger for every accepted/running/terminal/acknowledged
state change. The journal checkpoints to two identical atomic snapshots after 1,024 mutations or
4 MiB. Restart recovery must reproduce the same generation from both usable snapshot bases. A
partial, corrupt, divergent, or gapped journal remains fail-closed so recovery can never discard a
deduplication fence after an effect may have occurred.

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

## Direct HTTP session Stop

Session Stop is outside this protocol. Overseer calls the authenticated Fleet
HTTP `POST /sessions/:id/cancel` endpoint through authenticated Fleet HTTP over Tailscale and relays its response
unchanged. A `409 SESSION_NOT_RUNNING` additionally triggers a best-effort
authoritative session read so Overseer's index heals without changing the
operator-visible refusal.

## Project control plane

Project catalog/detail/settings/documentation/skills/quick links and lifecycle mutations use the authenticated Fleet HTTP API over Tailscale. `project-catalog-v1` remains the realtime projection and invalidation channel. `reverse-command-v1` contains no `project.*` operations.

## Peon update control

Update check, apply and bounded operation status use authenticated Fleet HTTP
through Tailscale. Release metadata and package bytes
come directly from the public npm registry.
There are no `update.*` reverse operations, negotiation branches or fallback.
The durable update receipt retains idempotency, serialized admission, restart
recovery and exact-version replacement-process attestation.

## Fleet surface capability matrix

`projection` means Overseer serves a committed local projection. `query` and `command` use the
control socket. `transfer` uses the dedicated transfer socket. `local-only` is deliberately not
available to Overseer.

| Existing Peon fleet surface | Target authority | Planned capability | Actor | Migration rule |
|---|---|---|---:|---|
| `POST /enroll` | direct Fleet HTTP | none | pairing phrase | Sole enrollment authority; Overseer initiates the request |
| `GET /status` | projection | `runtime-state-v1` | no | Legacy HTTP until initial projection commits |
| `PATCH /status` | local-only | none | n/a | Do not migrate remote pause |
| `GET /models` | projection | `runtime-state-v1` | no | Legacy HTTP until ready |
| `GET /quota[/:provider]` | query | `runtime-query-v1` | yes | Exclusive query or legacy HTTP |
| `GET /capabilities[/:provider]` | projection/query | `runtime-state-v1` | no/yes | Projection where safe; bounded query otherwise |
| `GET /filesystem[/…]` | query | Fleet HTTP | yes | Deliberately kept as the one directory-picker transport |
| `GET /projects` | query | Fleet HTTP | no | HTTP authority; `project-catalog-v1` remains realtime only |
| `GET /projects/suggest-dir` | query | Fleet HTTP | yes | Reverse query or legacy HTTP |
| `POST /projects` | command | Fleet HTTP | yes | Stable command ID; catalog confirms state |
| `GET /projects/:key` | query | Fleet HTTP | no | Resolve mutable key to immutable project ID |
| `GET /projects/:key/docs[/…]` | query | Fleet HTTP | yes | Bound response; transfer if oversized |
| `GET /projects/:key/skills` | query | Fleet HTTP | yes | Bound response |
| quick-link list/create/update/delete | projection/command | Fleet HTTP | mutations | Stable project and quick-link IDs |
| project settings read/update | projection/command | Fleet HTTP | mutation | Revision-fenced mutation |
| `DELETE /projects/:key` | command | Fleet HTTP | yes | Stable project ID; catalog tombstone confirms |
| project file list/read | query/transfer | Fleet HTTP listings, `project-file-read-v1` bodies | yes | Directory listings deliberately stay on Fleet HTTP; reverse body reads remain available |
| project file put/patch/delete | command/transfer | `project-file-write-v1` | yes | Atomic write and exclusive route |
| `GET /settings` | direct Fleet HTTP | none | yes | Safe allowlist plus revision identity |
| `PATCH /settings` | direct Fleet HTTP | none | yes | Required revision headers; `paused` is forbidden remotely |
| `GET /stats`, `GET /analytics` | projection/query | `runtime-state-v1`, `runtime-query-v1` | yes | Bounded filters; explicit freshness |
| `GET /sessions`, `GET /sessions/:id` | projection | `session-catalog-v1` | no | Reverse channel already authoritative after sync |
| `PATCH /sessions/:id` | command | `session-command-v1` | yes | Revision/state fenced |
| transcript read and session stream | Fleet HTTP | JSONL transcript + SSE | request/subscription | HTTP pages plus a post-commit live tail |
| session files/raw/stream/preview | query/transfer | `session-artifact-v1` | yes | Metadata on control, bytes on transfer |
| `POST /sessions` | command | `session-command-v1` | yes | Existing request ID becomes command ID |
| follow-up | command | `session-command-v1` | yes | Same-ID replay cannot duplicate user turn |
| queue list/add/edit/send/delete | direct Fleet HTTP | none | yes | Existing actor, request ID, validation and response contracts |
| cancel | command | `reverse-command-v1` first slice | yes | High-priority, idempotent |
| delete session | command | `session-command-v1` | yes | Stable session ID |
| `POST /control/pause`, `/control/resume` | local-only | none | n/a | Overseer support must be removed |
| check update / self-update | command | `peon-update-v1` | yes | Success only after reconnect attestation |
| generic `/files` get/put | legacy-only | none | yes | Replace with stable project/session transfer operations |
| Armory reads and lifecycle/configuration mutations | direct Fleet HTTP | none | yes | One authenticated authority; durable operation IDs survive retries/restart |

Registration and heartbeat are machine lifecycle HTTP operations, not operator fleet routes.
Pairing remains Overseer-initiated because the same reachable Fleet HTTP boundary is required
for normal operation.

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

The canonical schema and golden examples live under `packages/protocol/reverse-command-v1/`. Overseer
vendors the exact files and both repositories run a contract test over them. Any breaking envelope
change requires a new capability version.
