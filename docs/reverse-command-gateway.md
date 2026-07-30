# Reverse command gateway

Overseer sends reverse control commands through one server-owned gateway:
`modules/reverseCommands`. Operation services submit the authenticated server
context, workspace, Peon, operation, target, and optional stable command ID.
The gateway reloads the canonical user/email and rejects a caller-supplied
`actor`; services do not read or write the Peon WebSocket directly.

The wire lifecycle is the frozen `reverse-command-v1` contract vendored in
`apps/server/protocol/reverse-command-v1/`:

1. Overseer persists the canonical request hash and complete replayable command.
2. It sends `command` only on the current authenticated socket generation after
   the exact capability and operation were negotiated.
3. Peon's ephemeral `command_accepted` records durable admission.
4. `command_status_request` / `command_status` reconcile an admitted or
   admission-unknown command after reconnect.
5. The terminal `command_result` arrives in Peon's existing
   `durable-delivery-v1` envelope.
6. Overseer commits the shared durable inbox cursor, terminal command row,
   safe projection effect, audit row, and operator-scoped browser event in one
   transaction. Only then does it send `durable_ack`.

The socket is claimed in two stages. During canonical hello, its ordinary
presence is current but `reverse-command-v1` and its operation ownership remain
unpublished. Overseer first durably claims the session-sync generation and
sends the negotiated `hello_ack`; only then does it activate reverse commands
for that exact socket generation and reconcile pending rows. A submit in the
hello gap therefore returns `CAPABILITY_UNAVAILABLE` before admission instead
of creating a row that cannot be sent.

Operation negotiation uses the intersection of Peon's bounded, well-formed
advertisement and the operations this Overseer implements. A newer Peon may
advertise later operation families without making an older Overseer reject the
whole control connection; unimplemented operations remain inactive.

No action uses both reverse WSS and legacy HTTP. A missing connection returns
`PEON_OFFLINE`; a connected Peon that did not negotiate the operation returns
`CAPABILITY_UNAVAILABLE`. Operation-specific rollout code may select legacy
HTTP before calling the gateway, but it must select exactly one route.

## Durable registry and HTTP result

Migration `024_reverse_commands` adds:

- `reverse_commands`, the restart-safe pending/result registry;
- `reverse_command_audit`, the non-compacted terminal audit trail.

Migration `026_reverse_commands_peon_scope` safely re-keys installations that
ran the unreleased workspace-scoped form to `(workspace, Peon, commandId)`;
the actor-scoped status URL carries the Peon identity explicitly.

The registry is scoped by workspace, Peon, and command ID and also stores
operation, authenticated user/email, canonical hash, socket generation,
timestamps, bounded request bytes, replay state, and safe terminal detail.
Same-ID/same-body calls join the recorded lifecycle; same-ID/different-body
returns `409 COMMAND_ID_REUSED` for that Peon. The same command UUID on another
Peon is an independent identity.

An HTTP handler may wait at most 30 seconds (15 seconds by default). If Peon has
accepted but no terminal result is committed, the gateway returns
`202 COMMAND_PENDING` with:

```text
/api/workspaces/:workspaceId/peons/:peonId/commands/:commandId
```

The status route is authenticated, workspace-scoped, actor-scoped, and checks
current Peon access. A timeout before observed acceptance is
`504 COMMAND_TIMEOUT`. A socket send failure known to occur before acceptance
is distinct from an accepted command whose result is still pending. Peon
reporting `unknown` for something Overseer had already accepted records
`UNKNOWN_OUTCOME`; Overseer does not create a replacement ID.
When a bounded HTTP wait expires for a sent or admitted command, Overseer asks
Peon for `command_status` with the same ID before returning the pending/timeout
response. Waiter registration is followed by a durable-row recheck, so a result
committed in the send-to-wait boundary cannot be missed until the full timeout.

## Bounds and observability

Pending request counts and serialized bytes are bounded per user, Peon,
workspace, and process-wide registry. The defaults are 128/2 MiB per user,
256/4 MiB per Peon, 512/8 MiB per workspace, and 2,048/32 MiB globally.
Abandoned `created` or known `send_failed` rows expire after two minutes;
sent/admitted work is never discarded by that cleanup.
The per-user dimension is global across workspaces. Every terminal row without
`durable_committed_at` remains eligible for generation rebinding indefinitely;
there is no age horizon before the durable ACK.

Process metrics count queueing, acceptance, completion, replay, timeouts,
disconnect phase, and stable error code. Labels deliberately exclude actor and
Peon IDs, payloads, prompts, paths, and credentials.

The released v1 operation is `session.cancel`. Overseer accepts only these
complete status/code/detail tuples:

- `applied` or `noop` + `OK` + exactly
  `{ sessionId: <target>, sessionStatus: "completed" | "cancelled" }`;
- `rejected` + one of `BAD_COMMAND`, `COMMAND_EXPIRED`,
  `COMMAND_LEDGER_FULL`, `SESSION_NOT_RUNNING`, or `UNKNOWN_SESSION` + `null`;
- `conflict` + `COMMAND_ID_REUSED` + `null`;
- `failed` + `INTERNAL` or `PERSIST_FAILED` + `null`.

There is no accepted `cancelled` tuple. Messages, cross-combined status/codes,
unknown codes, non-terminal cancellation states, extra fields, and detail on
non-success results are rejected before terminal persistence, projection,
browser publication, or a success HTTP response. Remote daemon pause/resume
remains local-only and is not a reverse command.

Terminal HTTP/status views use the validated canonical `result_frame` and
require its duplicated registry columns to match. A corrupt or legacy
inconsistent row is reported as `UNSAFE_RESULT`; it cannot regain a success
mapping through stale `terminal_status`, code, or detail columns.

## Update orchestration

`update.check` and `update.apply` use this registry; they do not create another
pending-command ledger. Admission is serialized and permits only one active
`update.*` command per Peon. A conflicting check or apply returns
`409 UPDATE_IN_PROGRESS` without inserting or sending a second command.

An accepted apply remains pending across the expected socket loss. The daemon
that launched the updater may publish a pre-restart failure, but it never
attests a `ready_to_attest` receipt: only the replacement daemon, during command
ledger recovery, compares its running package version/revision with the
persisted expectation. Source checkouts are rejected with `UPDATE_BLOCKED`
because their updater changes files without proving process replacement.

Update terminal results have operation-specific tuple and field allowlists.
Successful apply requires `applied + OK` and exactly
`{ version, revision, sha256, attested: true }`; an attestation mismatch requires
`failed + ATTESTATION_MISMATCH` with the same bounded fields and
`attested: false`. Failure/rollback codes carry no detail. Check/no-update
results expose only the bounded update status fields. Contradictory
status/code combinations, extra fields, messages, and credential-like detail
are rejected before persistence or browser/API publication.
