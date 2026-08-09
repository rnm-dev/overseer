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

## Transcript synchronization

`packages/protocol-conformance/fixtures/transcript-sync-v1.json` is the golden
wire set for bounded snapshot request/page, durable live event, durable
deletion, cancel and unsubscribe frames. Invalid barrier and byte-bound cases
are kept beside the valid frames so the shared validator must fail closed.

The capability fixture executes every cell in the 3 × 3 legacy, stable and
current Peon/Overseer matrix. Live transcript sync selects the reverse socket
only when both peers negotiate `transcript-sync-v1` and its canonical catalog
and durable-delivery dependencies; all eight mixed or older cells exclusively
retain Fleet HTTP history.

`TranscriptSyncHarness` models the production commit boundary and recovery
rules deterministically. Its tests inject dropped, duplicated and reverse-order
delivery, disconnects, Peon/Overseer restarts, stale generations, crashes before
and after commit, snapshot/live overlap, gaps, epoch rollover, cursor loss,
projection eviction, queue pressure, slow consumers, oversized/corrupt input,
deletion and durable-identity payload reuse. Assertions require one projected
and browser effect, no ACK before or across an uncommitted gap, and convergence
after snapshot rebuild. Failure artifacts use `BoundedDiagnostics`; transcript
payloads are never included, and entry/byte bounds remain enforced.

The workspace `verify` script runs these Node tests. Because the package is a
root npm workspace, `npm run verify` includes them through the root
`npm run verify --workspaces --if-present` gate.

## Transcript convergence acceptance

`fixtures/transcript-acceptance-v1.json` is the executable index for the
invariants, SLO clocks, safe diagnostic dimensions and supported mixed-version
cells defined in [transcript synchronization](transcript-sync.md#convergence-acceptance-model).
Its test fails if a boundary disappears, a covered invariant has no executable
mapping, an SLO lacks an objective start/stop/target, or a sensitive payload
field is admitted as a diagnostic dimension.

Coverage labels resolve as follows:

| Label | Executable suite |
| --- | --- |
| `conformance:transcriptSync` | `packages/protocol-conformance/test/transcriptSync.test.js` |
| `conformance:topology` | `packages/protocol-conformance/test/topology.test.js` |
| `peon:transcriptChannel` | `apps/peon/src/daemon/__tests__/transcriptChannel.test.ts` |
| `server:transcriptProjection` | `apps/server/src/modules/sessions/transcriptProjection.test.ts` |
| `server:transcriptSocketIntegration` | `apps/server/src/adapters/transcriptSocketIntegration.test.ts` |
| `server:transcriptPagination` | `apps/server/src/routes/peons/transcriptPagination.test.ts` |
| `server:transcriptBrowserBounds` | `apps/server/src/routes/peons/transcriptBrowserBounds.test.ts` |
| `web:transcriptReconciliation` | `apps/web/src/features/sessions/transcriptReconciliation.test.ts` and merge/pagination tests |
| `flutter:transcriptController` | `apps/client/test/features/sessions/application/transcript_controller_test.dart` and transcript item tests |

The deterministic transcript lifecycle suite currently covers canonical
golden frames, shared demand, atomic snapshot barriers, drop, duplicate,
reorder/gap, stale generation, both-side restart, crash-after-commit-before-ACK,
ACK loss/replay, cancellation, epoch mismatch and resource rejection. Database,
Peon, web and Flutter suites cover the component boundaries named above.

Planned cells are deliberately visible rather than presented as passing:

- `TCA-SESSION-ISOLATION` needs a multi-session backpressure scenario proving a
  pathological session cannot starve a healthy one;
- all `TCS-*` rows need payload-free correlated clocks and percentile/ceiling
  assertions;
- the four `MVC-*` rows need a 4-party released-version fixture matrix rather
  than only the existing Peon/Overseer capability matrix;
- long-offline client cases need process-death, evicted boundary and stale
  resume scenarios on both web and Flutter.

These are the objective gates for the later epic workstreams: a transport,
observability or client recovery change is incomplete until it converts its
applicable catalog rows from `planned` to executable coverage without weakening
the authority split or payload-free diagnostic policy.
