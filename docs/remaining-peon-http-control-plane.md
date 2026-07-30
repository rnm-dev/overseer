# Remaining Peon HTTP control plane

This is the OVSR-236 design inventory, independently rechecked against the
shared monorepo worktree on 2026-07-30, including the operation-family changes
which were still uncommitted during the second pass. It describes the remaining
Overseer-to-Peon fleet HTTP and SSE dependency; it does not cover the Peon's
local human dashboard/CLI HTTP API, which remains.

## Census

The original task quoted 79 call sites. The second-pass production source has
**79 HTTP-dependent syntactic call sites**:

- 69 `callPeon(...)`;
- 3 direct `proxyGet(...)`, 2 direct `proxyStream(...)`, and 1 direct
  `proxyUpload(...)`;
- 2 `proxyFileDownload(...)`, 1 `proxyFileUpload(...)`, and 1
  `streamPeonTo(...)` wrapper calls.

Definitions and tests are excluded. Wrapper internals are not counted again.
The count includes fallback branches which are no longer selected after their
reverse capability is ready. It also counts both calls made by the
`callSupportedPeonPath` compatibility helper, although one logical request can
try several historical paths. The source distribution is:

| Source | Call sites | What remains |
| --- | ---: | --- |
| `routes/peons/sessions.ts` | 29 `callPeon`, 3 proxies | status/models, session reads and mutations, queue, update controls, transcript fallback, artifact metadata/bytes and preview |
| `routes/peons/projects.ts` | 21 `callPeon`, 6 proxies/wrappers | catalog fallbacks, project resources/mutations, settings/runtime/analytics queries, sandbox/project file fallbacks |
| `routes/peons/armory.ts` | 13 | inventory, configuration, lifecycle and operation polling |
| `routes/peons/fleet.ts` | 3 | enrollment/status probes and legacy reconciliation |
| `liveSocket.ts` | 1 `callPeon`, 1 SSE wrapper | session detail fallback and the browser-tail path |
| `modules/sessions/sessionProjection.ts` | 1 | legacy session catalog reconciliation |
| `peonFileSandbox.ts` | 1 | legacy `/settings` lookup for `fileTransferRoot` |

The 79 sites are a code-maintenance number, not 79 protocol operations.
Capability selectors already make several families exclusive:

- `session-catalog-v1` and `project-catalog-v1` serve canonical list/basic
  detail projections, leaving HTTP only before the initial projection commits;
- `transcript-sync-v1` serves transcript pages and the projected live tail;
- `folder-listing-v1`, `project-file-read-v1`, `sandbox-file-read-v1`, and
  `file-write-v1` own selected file paths;
- `reverse-command-v1` owns session cancel when negotiated.

No selected reverse operation may fall back to HTTP after a socket error.
Fallback is only a capability/version decision made before dispatch.

## Classification and capability ownership

| Family | Current HTTP surface | Target form and owner | Capability | Tasks |
| --- | --- | --- | --- | --- |
| Session catalog/detail | `/sessions`, `/sessions/:id`, status refreshes | Rebuildable projection; bounded authoritative detail query only where the projection lacks fields | `session-catalog-v1`; a typed session query on the shared gateway if still needed | OVSR-132, OVSR-134 |
| Transcript history/live tail | transcript GET and `/stream` SSE in API and browser socket | Durable snapshot + ordered commits into an ACL-filtered local projection/browser relay; remove both SSE dials | `transcript-sync-v1` | OVSR-133, OVSR-135 |
| Session lifecycle/queue | create, patch, follow-up, queue CRUD/send, cancel, delete | Durable commands with replayable terminal results | typed operations under `reverse-command-v1` | OVSR-129, OVSR-130, OVSR-132, OVSR-134 |
| Daemon configuration | `/settings`, mutable `/status` | Safe durable projection for reads; commands for mutation | `daemon-configuration-v1` + `reverse-command-v1` | OVSR-86, OVSR-87 |
| Project administration/resources | project CRUD/settings, suggest-dir, skills, quick links | Catalog projection for basic reads; bounded typed queries for skills/suggest-dir; durable commands for mutations | `project-catalog-v1`, project resource/query capability, `reverse-command-v1` | OVSR-136, OVSR-138 |
| Runtime/provider state | `/status`, `/models`, `/stats`, `/quota/:provider`, `/capabilities/:provider` | Durable low-cost runtime projection; bounded on-demand queries for slow/refresh probes | `runtime-state-v1`, `runtime-query-v1` | OVSR-137, OVSR-139 |
| Armory | inventory/settings/configuration, refresh/install/update/remove/enable/disable/restart, operation polling | Safe projection for inventory/config summaries; durable commands and shared command-status reconciliation for effects/long operations | Armory state/operation capability + `reverse-command-v1` | OVSR-140, OVSR-141 |
| Update control | pause/resume/check-update/update and AI CLI update aliases | Durable commands; update result remains pending across process replacement and completes only after reconnect attestation | update capability + `reverse-command-v1` | OVSR-142, OVSR-143 |
| Session artifacts/previews | session file metadata/raw/stream, preview handoff, attachments | Bounded transfer stream plus control metadata/lease; no Peon SSE | `session-artifact-v1` and existing transfer primitives | OVSR-144, OVSR-146; live watched revisions stay OVSR-50/52 |
| Project/sandbox files | generic `/files`, project file read/write/move fallbacks | Existing reverse read/write/list operations; retain HTTP only for older Peons | `folder-listing-v1`, `project-file-read-v1`, `sandbox-file-read-v1`, `file-write-v1` | OVSR-228/229/230/232/234; residual OVSR-49/51/53; proxy/API retirement OVSR-231/235 |
| Enrollment/reconciliation | `/enroll`, status probes, callback address | Peon-initiated claim, socket presence and projections; no outbound dial | `peon-claim-v1` and family capabilities | OVSR-210, OVSR-145, OVSR-147, OVSR-148, OVSR-149 |

Read-only request/response operations may use the shared correlated gateway but
must not be written into the durable command ledger unless the Peon-side work or
result can outlive the socket generation. Mutations and long-running operations
always use the durable command lifecycle. Frequently read, naturally changing
state belongs in a rebuildable projection rather than per-view RPC.

## Identity, idempotency and results

Overseer authenticates the browser, authorizes workspace/Peon/project/session,
and creates the canonical actor. Frames carry a structured actor with stable
user ID and email; neither request bodies nor browser headers can override it.
The Peon revalidates the target and local policy, but does not infer authority
from an email string.

`Peon-Request-Id` remains the public compatibility header. Overseer validates it
and maps it to a stable `commandId` (or a transfer request ID linked to that
command). If the client omits it for an idempotent mutation, Overseer generates
one and returns it. Peon-scoped dedupe is by command ID plus an immutable
operation/target/payload fingerprint; reuse with a different fingerprint is
`COMMAND_ID_CONFLICT`, never a replay. Admission, terminal result, and status
reconciliation use the one ledger defined by `reverse-command-v1`.

Queries use a correlation `requestId`, generation fencing, deadline and
cancellation. A duplicate query may be re-executed unless its operation
explicitly promises a cached result. Projections use epoch/revision or durable
cursor identity, not request IDs.

Operation errors are stable typed codes mapped at the existing operator HTTP
boundary. Safe details may be returned, while credentials, prompts, transcript
bodies and sensitive paths stay out of logs. Once the Peon fleet listener is
disabled, `PEON_UNREACHABLE`, `CONNECTION_REFUSED` and `DNS_FAILURE` collapse to
one reverse-transport unavailable state. A disconnected Peon is unavailable
for new online-only requests; an already accepted durable command is
`pending`, not failed, until replay/status reconciliation produces its terminal
result.

## Reconnect and streaming

The outbound socket supervisor owns DNS/TCP/TLS retry, exponential backoff,
jitter, heartbeat and generation replacement. Operation code must not create a
second reconnect loop. On replacement:

1. stale-generation responses cannot complete current requests;
2. ephemeral unaccepted requests fail with reverse transport unavailable;
3. accepted commands reconcile by the same command ID;
4. projections resume from committed epoch/revision/cursor or rebuild;
5. transfer streams fail or resume only according to their explicit capability
   contract—never by silently replaying an HTTP mutation.

The Peon SSE tail has no place in the final topology. Transcript snapshots and
post-barrier commits enter the durable projection, and Overseer fans them out
over its existing browser transport. Session artifact byte streams use the
transfer socket with bounded credit/backpressure. There is no SSE-over-WebSocket
tunnel and no per-browser Peon subscription.

## Migration order

1. Finish the shared dispatcher/gateway (OVSR-129/130); every later mutation
   reuses its admission, dedupe, reconciliation and result storage.
2. Finish session lifecycle and transcript parity (OVSR-132–135), then remove
   both live SSE dials when `transcript-sync-v1` is authoritative.
3. Finish configuration (OVSR-86/87).
4. Finish projects and runtime/provider state (OVSR-136–139).
5. Finish Armory and update control (OVSR-140–143).
6. Land the reviewed OVSR-229 base `file-write-v1`, finish base session
   artifacts/previews (OVSR-144/146), then complete only the residual
   file-write scope in OVSR-49/51/53. Advanced live preview remains a later
   consumer, not a prerequisite for baseline callback removal.
7. Complete outbound enrollment (OVSR-210, OVSR-145/147) and operation parity,
   then make the Peon loopback-only capable in OVSR-148 and make callback
   addressing optional/exclusively routed in OVSR-149.
8. Extend security/conformance coverage (OVSR-150/151). OVSR-152 then owns the
   canary, no-inbound soak, rollback exercise, default-disable decision and the
   start of the published mixed-version support window.
9. Only after OVSR-152 and that support window completes may OVSR-211 delete
   callback routes, enrollment/heartbeat compatibility and obsolete stored
   addressing/credentials. OVSR-148/149/152 must not absorb this deletion.

File-specific retirement has an additional inner sequence: land and review
OVSR-228/229/230/232/234, remove Overseer's file proxy fallbacks in OVSR-231
after the fleet capability check, then remove Peon's remote file HTTP routes in
OVSR-235. OVSR-211 remains the broader final callback/enrollment/address
retirement and must not run before the global support-window gate.

Each slice advertises its exact capability only after both implementations
support the complete contract. During the support window an older Peon uses
legacy HTTP. A newer Peon uses exactly one authority per operation family and
socket generation.

## Gaps and blockers

- The shared command implementations are not both released yet
  (OVSR-129 is in review; OVSR-130 is in progress), so mutation families cannot
  claim durable parity.
- Session/runtime/project/Armory/update Peon and Overseer pairs are still in
  progress; configuration and session-artifact Overseer counterparts remain
  backlog.
- Some current reads still use HTTP to compensate for incomplete projection
  shape: session detail, project identity for legacy ACL checks, quick-link
  refresh, and `fileTransferRoot`. Their owners must either add the missing safe
  projected fields or define a typed query; a generic HTTP-shaped RPC is not an
  acceptable shortcut.
- `callSupportedPeonPath` preserves three historical AI CLI update path
  dialects. The reverse contract needs one canonical operation name and keeps
  aliases only at the operator HTTP boundary.
- Enrollment and callback retirement are independently blocked on
  `peon-claim-v1` implementation and the parity/soak gates.
- Conformance coverage must assert a NAT-only run fails on every attempted
  Overseer-to-Peon dial and must include command, transcript, transfer and
  reconnect boundaries before OVSR-152 can make reverse-only the default.
- OVSR-248 (trusted proxy attribution) is a public-claim/reverse-cutover
  security gate, and OVSR-249 closes a browser-visible filesystem-root leak in
  the legacy attachment fallback. Both are in review and must be verified
  before their affected public/fallback paths are declared safe.

### File-write task boundary

OVSR-229 is not a fourth competing design. It is the reviewed base transport
and current implementation of `file-write-v1`:

- it covers the OVSR-51 base coordinator (bounded client-to-Peon frames,
  Peon-issued credit, checksum/length, cancellation, timeout and generation
  fencing);
- it covers the OVSR-53 base receiver for attachment/sandbox and project
  uploads plus same-project atomic no-clobber rename;
- it covers the OVSR-49 compatibility routing for attachment PUT and project
  PUT/PATCH with immutable `projectId` and exclusive capability selection.

The older tasks remain only for their explicitly unshipped residual scope:
OVSR-49 owns project DELETE and remaining route/audit/conflict behavior;
OVSR-51 owns any required durable restart lifecycle, broader quotas,
observability and command/transfer coupling; OVSR-53 owns Peon project DELETE,
restart cleanup/replay, optimistic fences and missing filesystem fault
coverage. They must extend the same `file-write-v1` transport and must be
re-scoped or closed by OVSR-152 when their residual acceptance criteria are
satisfied. No second write socket, lifecycle or command dialect is permitted.

OVSR-231 and OVSR-235, not OVSR-49/51/53, own deletion of the remaining file
proxy and Peon remote file HTTP API after the capability rollout. OVSR-234 owns
the shared transfer-channel documentation; implementation tasks should update
that one contract instead of creating task-local protocol descriptions.

No new implementation tasks are needed: the existing task pairs above cover
every inventoried family and the final deletion. Creating another family task
would duplicate their scopes.
