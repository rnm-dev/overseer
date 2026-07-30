# Protocol conformance and failure-injection harness

OVSR-151 owns the reusable cross-version test foundation under
`packages/protocol-conformance`. It is a private npm workspace and joins the
root `npm run verify` command through its `verify` script. It does not replace
the Peon and Overseer implementation tests; it supplies the shared frames,
matrix, transport faults and topology assertions that those adapters can reuse.

Run the focused suite with:

```sh
npm test -w @rnm/protocol-conformance
```

## Stable executable slice

`fixtures/stable-v1.json` is the shared golden-frame document. Its runner checks
the released control and transfer socket handshakes, the durable envelope,
session and project snapshots/events/acknowledgements, folder requests/pages/
cancellation/errors, and project/sandbox file open/metadata/credit/end/errors.
Positive and negative frames share the same adapters. Complete serialized frame
sizes are checked against the control, durable, catalog-page, folder-page and
transfer-JSON limits, and error frames accept only their stable code allowlists.

`fixtures/capability-matrix-v1.json` defines three Peon profiles and three
Overseer profiles:

| Peon \ Overseer | legacy | stable-v1 | current |
| --- | --- | --- | --- |
| legacy-http | green: legacy fallback | green: exclusive downgrade | green: exclusive downgrade |
| stable-v1 | green: exclusive downgrade | green: stable reverse slice | green: mixed reverse slice |
| current | green: exclusive downgrade | green: mixed reverse slice | green: current reverse slice |

Every cell asserts one route per surface: `reverse-socket`, `legacy-http`, or
`unavailable`. The session catalog and durable delivery capabilities are
all-or-nothing; project catalog depends on that pair. Folder listing negotiates
independently. Project directory metadata stays on HTTP unless both sides
negotiate `entry-metadata-v1`. Project and sandbox file reads independently
downgrade to HTTP when their transfer capability is absent.

The current×current cell also includes `session.cancel` through
`reverse-command-v1` and transcript history/live demand through
`transcript-sync-v1`, plus update check/apply route selection through the
shared reverse-command dispatcher, and runs through `NoInboundTopology` with
the Peon fleet port blocked. It opens only Peon-initiated control and file-transfer
connections and fails immediately if a surface selects legacy HTTP or Overseer
attempts to dial Peon. This proves the already stable socket/catalog/folder/
file-read/session-cancel/transcript slice behind NAT; it is not yet proof of
the epic's full fleet surface.

## Deterministic faults and diagnostics

`DeterministicTransport` injects `drop`, `duplicate`, `hold` plus FIFO/reverse
release, disconnect, reconnect and Peon/Overseer restart. Every frame carries a
harness generation, so a held frame from a replaced connection is rejected.
`DeterministicDeliveryHarness` adds a bounded durable journal, ordered receiver
checkpoint, message-ID deduplication, cumulative acknowledgement and
restart-preserved sender/receiver state. Tests cover dropped data, dropped ACK,
duplicate delivery, out-of-order gap detection, stale-generation delivery and
eventual one-effect convergence.

`ReverseCommandLifecycleHarness` attaches stateful Peon-command and
Overseer-registry adapters to that transport. The shared
`reverse-command-lifecycle-v1.json` fixture exercises every released
`session.cancel` boundary: before durable admission, admission before
`command_accepted`, acceptance before effect, effect/terminal persistence
crash and replay, terminal persistence before durable result delivery, and
Overseer atomic result/projection/audit/browser commit before ACK. Dropped and
duplicate acceptance/results, reverse
release of stale held frames, Peon and Overseer restart, status reconciliation,
generation rebinding, same-ID/different-body rejection, queue bounds and torn
durable-record rejection converge to one Peon effect and one Overseer commit.
These are executable protocol adapters backed by the frozen fixture semantics;
the implementation workspaces retain their own database/filesystem endpoint
tests.

Fault queues, frames, journals and convergence steps are bounded and fail with
stable harness codes such as `QUEUE_FULL`, `FRAME_TOO_LARGE`, `OUTBOX_FULL` and
`CONVERGENCE_TIMEOUT`. `BoundedDiagnostics` produces a JSON-safe artifact with
entry and byte ceilings. It redacts authorization, cookies, tokens, credentials,
pairing material, prompts, transcripts, actor email and sensitive paths; raw
frames are not included in the golden-run report.

`auditVendoredContracts` compares contract copies by byte count, exact SHA-256
and canonical-JSON SHA-256 without placing schema or fixture bodies in
diagnostics. The claim schema and fixtures are currently identical between Peon
and Overseer. The reverse-command fixtures are identical; the schemas are
JSON-equivalent but not byte-identical because one copy is expanded formatting.
This drift remains visible without treating formatting as a released lifecycle
test.

`peon-claim-lifecycle-v1.json` promotes the frozen enrollment contract into a
required conformance cell. It checks that both byte-identical security-vector
vendors retain all 59 golden outcomes and every claim, recovery, rotation,
revocation and legacy-race operation. Its mixed-version cells keep legacy
enrollment only before claim capability selection and make claim start an
irreversible authority boundary across timeout, TLS, `429` and `5xx` failures.
Named fault cells cover lost/duplicate responses, restart at claim and rotation
commit boundaries, ACK/cancel reordering, delayed old-generation control and
transfer hellos, and the claim-versus-legacy race. The app-level suites remain
the executable endpoint/database adapters for those frozen outcomes.

`transcript-sync-v1.json` is the shared canonical wire fixture for snapshot
request/page, durable live event, cancellation and unsubscribe. Its adapters
enforce the implementation's frozen epoch/revision/barrier, contiguous event
sequence/revision, page and envelope limits, durable identity and pagination.
The lifecycle harness stages snapshots until the complete barrier, shares one
Peon demand across consumers, and models the atomic projection + durable inbox
+ ACL browser-event commit before ACK. Tests inject dropped and duplicate
delivery, reordered gaps, ACK loss, Peon/Overseer restart, epoch mismatch,
stale generation, cancellation, oversized and corrupt snapshots.
Current×legacy and legacy×current select only HTTP; current×current selects
only the reverse socket.

`file-write-v1.json` covers the released project/attachment upload,
same-project no-clobber move and project regular-file DELETE dialect:
correlated `write_open`, `write_ready`, credit, the exact 22-byte-header binary
chunk shape, `write_end`, terminal result and cancellation. Its lifecycle
adapter exercises slow credited producer/consumer progress, bounded
backpressure, size/length/checksum refusals, cancellation and temporary
cleanup, stale generations, duplicate and reused IDs, terminal replay,
disconnect/reconnect tombstones, atomic visibility, no-clobber move, one-effect
DELETE replay, traversal and parent/symlink-swap failure. DELETE additionally
records the released process-local boundary: reconnect retains a receipt,
whereas daemon restart loses it and a missing regular-file target still fails
closed. Matrix selection is reverse-only for current×current and HTTP-only for
mixed versions; once the socket route is selected, failure never retries
through HTTP. The NAT guard exercises all four write surfaces with no
Overseer→Peon dial.

`update-lifecycle-v1.json` attaches the shipped update model to the shared
reverse-command lifecycle. Its adapters cover durable admission before
acceptance, same-command replay without a second installer launch, bounded
release metadata, downloaded archive size/SHA-256 verification, the
version-fenced `RELEASE_CHANGED` outcome, process replacement, durable receipt
recovery/corrupt-receipt rejection, and the rule that a command stays running
until a different PID attests the expected running version and revision.
Dropped ACK/result, reconnect, durable terminal replay, stale socket generation
and the stable download/install/rollback/restart/attestation failure codes reuse
the command harness's commit-before-ACK path. Matrix routing is reverse-only for
current×current, exclusively HTTP for mixed versions, and is included in the
NAT/no-dial assertion. These tests never invoke the real installer or restart a
daemon.

## Extension cells that must not report green

The matrix reports reverse-command and transcript coverage separately and
registers these unfinished families explicitly:

- updates: the released updater binds its TOCTOU check to approved version and
  validates the downloaded archive SHA-256, while its durable receipt and
  replacement-process attestation carry version/revision but no SHA. Approved
  release revision/SHA TOCTOU binding and replacement runtime SHA attestation
  therefore remain blocked rather than being simulated by the harness.
- rollout: fairness and latency SLOs, production-like soak artifacts and staged
  fleet rollout remain unfinished operational cells.

Enrollment operational evidence remains blocked separately: a real-machine
NAT/TLS exercise, a production-like mixed-fleet soak, and legacy removal after
the published compatibility window. Contract conformance must not turn those
cells green.

File-write coverage deliberately does not turn future semantics green.
Optimistic revision fences and durable destructive receipts across a Peon
daemon restart remain explicit blocked cells. The v1 receiver's five-minute
replay cache is process-local, so the harness does not claim durable restart
deduplication.

`reverse-command-v1` is covered for the released `session.cancel` operation.
The vendored schemas are canonical-JSON equivalent; byte-formatting differences
are audit metadata and not a semantic blocker. This does not claim coverage for
future command operations whose operation-specific result and cancellation
contracts are not frozen.

To extend the harness, add a version profile and expected route cell, add golden
frames with a named adapter passed through
`executeGoldenFrames(document, { adapters })`, then attach the real Peon and
Overseer endpoint adapters to the deterministic transport. A family moves from
`extensions` into the required matrix only after its capability, limits, stable
errors and downgrade authority are frozen.
