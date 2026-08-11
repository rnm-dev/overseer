# Reverse transcript projection and live relay

Overseer serves transcript history pages through the authenticated Peon Fleet
HTTP API and serves live session tails through `transcript-sync-v1` together
with `session-catalog-v1` and `durable-delivery-v1`. Peon remains authoritative;
Postgres contains a bounded, rebuildable live-tail projection, not the history
page read authority.

## Convergence acceptance model

The executable catalog is
`packages/protocol-conformance/fixtures/transcript-acceptance-v1.json`. Stable
IDs below are requirements, not implementation hints; a later hardening change
passes only when its named invariant remains green and its applicable recovery
scenario meets the named SLO.

- **TCA-AUTHORITY:** Peon's durable transcript is the only canonical store.
  History is read only through authenticated Fleet HTTP; `transcript-sync-v1`
  supplies only a rebuildable live tail. Neither Postgres nor a client may
  manufacture, edit or become authority for a transcript row.
- **TCA-APPEND-VISIBILITY:** once Peon commits an append, every continuously
  authorized and connected consumer eventually observes that exact event, in
  transcript order. Before observation, the client may show a non-row ghost;
  it must not claim the append is canonical.
- **TCA-ACK-BOUNDARY:** Overseer ACKs only after inbox identity, projection,
  per-session and Peon-wide frontiers, and ACL-scoped browser event are one
  durable commit. A crash before commit yields no ACK; a crash after commit and
  before ACK replays safely.
- **TCA-REPLAY-IDENTITY:** `(Peon durable epoch, cursor, messageId)` identifies
  delivery and `(sessionId, transcript epoch, seq, eventId)` identifies the
  canonical append. Exact replay has one effect; reuse with different identity
  or canonical payload fails closed without advancing or ACKing.
- **TCA-SNAPSHOT-BARRIER:** only a complete contiguous `1..barrierSeq`
  snapshot with one session, epoch, revision and barrier becomes visible.
  Live events at or below the barrier must match projected identity and payload;
  later events apply strictly after the atomic replacement.
- **TCA-EPOCH:** a transcript epoch names one sequence space. Epoch change,
  absent boundary, unavailable cursor or gap invalidates suffix proof and
  requires a snapshot; no ACK crosses the gap.
- **TCA-GENERATION:** every snapshot, append, ACK and correlated response is
  fenced by the current control-socket generation. A replaced generation can
  neither write, release new demand nor ACK.
- **TCA-ACL-REVOCATION:** workspace, Peon, session and project access are read
  authoritatively before every replay/live delivery. Revocation closes the tail
  before the next event and creates no new Peon demand.
- **TCA-BOUNDED-RETENTION:** snapshot, queue, projection, browser output and
  subscription bounds fail closed. Eviction removes a whole projection, never
  an ambiguous prefix, and later demand rebuilds from Peon while Fleet HTTP
  history remains available.
- **TCA-SESSION-ISOLATION:** one stalled, oversized or rebuilding session must
  not prevent an unrelated healthy session on the same Peon from meeting its
  recovery SLO. This is a required planned harness cell, not a claim about the
  current Peon-wide ordered frontier.
- **TCA-CLIENT-ROWS:** web and Flutter render only authoritative Peon rows,
  deduplicate by event ID across page/replay/live overlap, discard state from a
  replaced session or connection generation, and recover by page plus tail.

### Measurable freshness and recovery SLOs

The SLO population is authorized transcript demands where both endpoints stay
available for the measurement window. Operator cancellation, ACL revocation,
intentional unsubscribe and a Peon remaining offline are counted separately,
not silently reported as successes. Targets apply at p99 over rolling 24-hour
windows and to deterministic acceptance scenarios at the stated ceiling:

| ID | Scenario and clock | Target |
| --- | --- | ---: |
| TCS-HEALTHY | Peon canonical append commit → authorized client applies the event | ≤ 2 s |
| TCS-RECONNECT | replacement control socket ready → client reaches Peon's captured frontier | ≤ 5 s |
| TCS-OVERSEER-RESTART | Overseer readiness after process restart → reconnected client reaches the captured frontier | ≤ 10 s |
| TCS-PROJECTION-REBUILD | snapshot demand admitted for missing/evicted/gapped projection → client reaches the captured barrier plus ordered catch-up | ≤ 30 s |
| TCS-LONG-OFFLINE | client tail connects with an unavailable/stale boundary → page and bounded tail reach the captured frontier | ≤ 30 s, excluding explicit user-driven older-page reads |

“Current” always means a frontier captured at the scenario start, not an idle
queue while new appends continue forever. Each sample records only component,
outcome, recovery class, transport/capability cell, keyed hashes of workspace,
Peon/session/epoch, generation, sequence gap, counts, bytes, duration and a
stable failure code. Hash keys rotate with the deployment secret. Prompts,
transcript/event bodies, credentials, paths and attachment content are forbidden
from metrics, traces and diagnostics. High-cardinality hashes are for bounded
debug samples, never unbounded metric labels.

Current observable state consists of projection status/frontier/timestamps in
`peon_transcript_sync`, durable cursor/inbox state, event and byte counts, and
bounded Peon transcript-read diagnostics. These prove state and bounds but do
not yet measure end-to-end client application time. Therefore all five SLO
collectors remain explicitly `planned` in the executable catalog; later
observability/client work must add correlated payload-free start/stop samples
before claiming an SLO is met.

### Supported mixed versions

| Cell | Peon / Overseer / client | Required result |
| --- | --- | --- |
| MVC-CANONICAL | `transcript-sync-v1` / capable / projected-tail web or Flutter | Fleet HTTP history plus projected live tail; all invariants and SLOs apply |
| MVC-LEGACY-PEON | no capability (legacy SSE) / dual-stack / legacy-tail client | Fleet HTTP history plus bounded legacy passthrough; authority, ACL, bounds and client-row invariants apply; reverse recovery SLOs are not claimed |
| MVC-LEGACY-CLIENT | capable / capable / released legacy-compatible client | Existing public page/SSE/WS shapes remain compatible; no capability frame reaches the client |
| MVC-UNSUPPORTED-SERVER | capable Peon / Overseer without transcript sync / any client | negotiate legacy passthrough where that released pair supports it, otherwise report offline; never partially activate projection semantics |

“Released legacy” means the oldest web/Flutter builds in the supported release
window declared by the deployment, not every historical build. A change to the
window or any cell requires updating the executable fixture and its conformance
test in the same change.

## Authority and ACL

History and realtime deliberately have different read paths:

- every `GET .../transcript` page is one authenticated Fleet HTTP request,
  including on a Peon that negotiates `transcript-sync-v1`;
- opening or paging history never creates snapshot/subscription demand and
  never reads the Postgres transcript projection;
- browser WebSocket and HTTP SSE live tails continue to share one reverse
  subscription and use the projection for replay/catch-up;
- a reverse gap or outage affects realtime freshness, but does not select a
  second history-page transport.

Workspace and session/project access is checked from the committed session
catalog before a snapshot or subscription frame is sent. Immediately before
each WS or SSE replay/live event, Overseer performs an authoritative database
read of the current workspace membership, Peon grant, indexed session scope and
project grant. This delivery gate does not use the browser socket's 15-second
access cache. A revoke therefore closes the existing tail before the next
committed event can be delivered. A member who can see the Peon but not the
session's project receives `UNKNOWN_SESSION`, and no transcript demand reaches
the Peon.

## Snapshot and live commit

The first authorized consumer sends one shared
`transcript_snapshot_request {requestId,sessionId,limit,cursor?,subscribe:true}`.
All pages must keep the same session, epoch, revision and barrier. Every
envelope repeats that session and epoch, its revision equals its sequence, and
the complete snapshot is the contiguous range `1..barrierSeq` with unique event
IDs. Pages remain within the page, event, byte, page-count, concurrency and
timeout limits and stage in memory. Only the final validated page replaces one
session's projection, checkpoint and freshness state in a transaction. A
partial, sparse or rejected snapshot is never visible.

Peon live events arrive as ordered `durable_message` frames carrying
`transcript_live_event`. For a new event, one Postgres transaction:

1. validates the active socket generation, transcript epoch and next sequence;
2. inserts the shared Peon durable inbox identity;
3. inserts the canonical transcript event;
4. advances the per-session transcript checkpoint;
5. advances the Peon-wide durable delivery checkpoint; and
6. appends the ACL-carrying browser event-log row.

Only after commit does Overseer send `durable_ack` and fan the event out.
Replayed delivery identities are silent. A different payload reusing an
identity is rejected. `transcript_deleted` removes the projection and commits a
terminal browser event through the same inbox/cursor boundary.

A durable event at or below an already committed snapshot barrier is not
accepted merely because its sequence is covered. In the same transaction,
Overseer loads the projected row for that epoch/sequence and compares both its
event ID and its canonical recursively key-sorted JSON payload with the
normalized durable event. A missing or different row is `REPLAY_MISMATCH`; the
durable inbox and shared cursor remain unchanged and no ACK is sent.

The projection stores the browser-compatible canonical event with `eventId`.
Publication metadata that does not already live in the event — epoch, revision,
sequence, event type, author, timestamp, usage, artifact references and reverse
transport truncation — is retained under `reverseTranscript`.

Before byte accounting, snapshot/live persistence, replay comparison and
browser publication, Overseer recursively normalizes the event object. An
actual U+0000 in any string value or object key becomes U+FFFD; arrays and
nested objects use the same rule. The ordinary six-character text `\u0000`
remains unchanged. This happens on values before JSON serialization, so escaped
source text cannot be mistaken for a binary NUL and PostgreSQL's `jsonb` input
never receives the forbidden code point. If transcript projection nevertheless
fails, the control-socket diagnostic may name only the Peon, session, event and
delivery cursor; it does not log the transcript payload. The event is not ACKed
or discarded.

## Gaps, reconnects and restart

Events received during a snapshot remain behind the Peon-wide ordered durable
frontier. After the atomic snapshot, events at or below its barrier are
committed as covered delivery; newer events apply in order.

An epoch change, missing checkpoint, sequence gap, oversized live envelope,
`CURSOR_UNAVAILABLE`, or `RESYNC_REQUIRED` changes freshness to `syncing` or
`gap` and requests a fresh snapshot. No ACK for that session crosses the gap.

Peers that also negotiate `durable-delivery-selective-ack-v1` may commit and
individually acknowledge other sessions and unrelated durable capabilities
while that repair runs. Overseer keeps later events for the damaged session
behind its first blocked cursor, preserving per-session order including
deletion. The one 5,000-message/32 MiB Peon outbox remains the only durable
store: an individual ACK fsyncs a bounded retired-cursor hole, removes only that
message, and advances the cumulative frontier only after every earlier cursor
is retired. On reconnect Overseer deliberately sends no cumulative delivery
resume for this mode; remaining cursors replay and its durable inbox makes
already committed duplicates silent. Thus a snapshot gap, unavailable cursor,
rejected/oversized event, or slow repair cannot indefinitely block another
session, catalog/runtime state, or a command result, while none can cause the
blocked cursor to be deleted. Old peers do not negotiate the additive feature
and retain the original Peon-wide cumulative frontier and ordering. On a
downgrade after selective ACK was used in the current outbox epoch, Peon ignores
the older Overseer's handshake cursor because it may lie beyond a hole; it
replays the bounded remainder and resumes safe cumulative ACKs in wire order.

The focused starvation reproduction queues a gap for session A, a ready event
for session B, and then deletion for A. Under the v1 scheduler B remains behind
A until its snapshot finishes (the snapshot lease is 60 seconds, and repeated
repair failures can repeat that wait indefinitely). Under selective ACK the
same serialized handler commits B on its first pass while retaining both A
cursors in order; the executable test also restarts Peon's outbox between the
out-of-order ACKs and proves that its cumulative frontier does not cross the
hole. Memory remains capped at 1,000/8 MiB on Overseer and disk at
5,000/32 MiB on Peon.

On a normal reconnect, Overseer sends
`transcript_subscribe {requestId,sessionId,epoch,afterSeq}`. Peon supplies the
bounded canonical catch-up before `transcript_subscribed`. If that suffix is no
longer available, the same connection rebuilds by snapshot. Socket replacement
claims a new generation in both the catalog and transcript rows; late frames
from the old generation cannot write or ACK. An Overseer restart retains the
projection/checkpoints, while process-local demand is rebuilt from browser
re-subscriptions.

The `transcript_subscribed.afterSeq` acknowledgement is the Peon's actual
post-catch-up frontier, so it may be greater than the requested `afterSeq`.
Overseer accepts it only after the preceding ordered durable events have
advanced the same transcript epoch through that sequence. A lower frontier,
epoch change or uncommitted jump is a protocol error; an ordinary non-empty
catch-up never closes the shared control socket.

After replay and catch-up reach that frontier, Overseer sends the subscribing
browser `tailReady {peonId,sessionId}`. Legacy SSE passthrough sends the same
acknowledgement after the upstream response is accepted. This frame carries no
transcript data and advances no cursor; it lets a browser end transient-gap
recovery even when the resumed tail is idle and therefore has no data frame to
prove health.

Demand is shared per Peon/session. Many browsers therefore create one Peon
subscription, not one each. The last authorized consumer sends
`transcript_unsubscribe` and cancels a demand-only snapshot. A snapshot needed
to unblock an already durable Peon message completes even without a browser,
then releases demand.

Opening history performs one Fleet HTTP page read with the caller's `limit` and
opaque `cursor` when the Peon advertises `transcript-pagination-v1`. The public
shape remains `{events,nextCursor,hasMore}`; Overseer retains its corrupt-row
degradation and best-effort timestamp/author enrichment. The client subscribes
to the live tail separately, and the tail's existing replay/deduplication rules
close races without making the history page part of reverse demand.

Authorship renders the same on every path. The wire carries one author string —
`Peon-Actor`, deliberately the canonical email — and the display name and avatar
are local profile metadata resolved when an event is served, never stored beside
it: the paginated page, the SSE route and the websocket projected tail (replay
and live alike) all expand that string into `authorEmail`, `authorGithubLogin`
and `authorAvatarUrl` from one identity lookup cached for a minute. Matching is
case-insensitive, matching what the client compares. An actor belonging to no
operator — `local-cli`, `system`, a removed user — passes through unenriched and
renders as its literal string, and enrichment stays best-effort: a frame is
never withheld because local profile metadata could not be read. Peons without
`transcript-sync-v1` still stream through the legacy per-Peon SSE passthrough,
which forwards opaque frames and therefore shows the raw actor until the page is
reloaded.

The transcript channel hello is an exact fixed contract, including
`subscriptions: 64`; a different or missing limit is a protocol error when the
canonical catalog+durable dependencies are present. Overseer counts each unique
session once across pending snapshot/subscribe work and active demand, and
refuses the 65th before sending a frame. Correlated subscribe response timers
are cleared on response, error, release, replacement and disposal. A silent
Peon times out the request, clears all connection-local subscription state and
closes the control socket, so reconnect cannot inherit leaked capacity.

Peon reserves an in-flight snapshot slot before JSONL I/O or snapshot cloning.
Its canonical reader uses fixed buffers and stops at 64 MiB of source, 16 MiB
for one physical row, or 20,000 valid events. Cancellation, the 30-second lease,
and socket-generation replacement invalidate late load completion. Peon checks
that lease synchronously before each continuation and after repository load;
its maintenance timer only reclaims idle state. The 192 KiB
event limit covers the complete durable envelope, including top-level author,
nested usage and artifact references; oversized canonical truth remains local
and the bounded wire copy retains its session/event artifact identity.

If critical deletion publication meets `OUTBOX_FULL` or `PERSIST_FAILED`, Peon
keeps the bounded demand state and retries after durable acknowledgements, on
reconnect, and from its maintenance timer. It releases that state only after
the deletion is durably admitted.

## Browser APIs and bounds

The existing transcript REST shape remains `{events,nextCursor,hasMore}`.

The web dashboard keeps a bounded in-memory cache of twelve recently opened
newest pages and prefetches a transcript on pointer/focus intent. Switching
back to a recent session paints that page immediately, but establishes a
live-tail boundary only from an in-flight or newly completed authoritative
Fleet HTTP page. The cache is a latency optimization: normal `eventId`
deduplication covers overlap with the live tail. It is erased on every sign-in
boundary and sign-out; invalidation also rejects already in-flight prefetches so
an old principal's response cannot become a resume candidate. Flutter likewise
paints its durable, session-scoped cache immediately, but establishes a
live-tail boundary only from the newest authoritative Fleet HTTP page obtained
while opening. On either client, if that read fails, the tail subscribes without
`lastEventId`; Overseer's bounded replay window re-anchors the client and stable
`eventId` upserts remove overlap. A cached boundary is never promoted to
authority merely because the device is offline or has restarted. Warm/cold
selection, freshness metadata and mobile cache budgets remain the separate
Instant relevant transcripts policy. Because the current Drift schema scopes
private rows by workspace rather than operator, Flutter purges cached transcript
events/metadata, authoritative queue snapshots, drafts and pending follow-ups
whenever authentication becomes unauthenticated or a new sign-in succeeds; a
valid same-user token restore keeps them for offline paint.

Pagination cursors are opaque, route/session-owned and epoch-bound. Browser
WebSocket and HTTP SSE tails replay strictly after `lastEventId`, then consume
committed event-log fan-out. Live events are held behind a bounded replay
barrier and deduplicated by `eventId`, so a commit racing the replay cannot
overtake or duplicate itself. Current membership and project ACL are queried
again before every replay and live delivery on both transports; revocation
closes an existing tail. A `lastEventId` this projection does not hold — evicted,
or belonging to another session because a caller crossed its own wires — cannot
prove a suffix, so it replays one bounded newest window of 50 events rather than
the complete retained transcript. That re-anchors a caller whose boundary was
merely evicted, is dropped row by row through the `eventId` deduplication above
when the caller already holds that page, and keeps a client defect from costing
megabytes per subscribe; older history stays reachable through pagination. A tail
that asks for no boundary at all is stating it has no snapshot, and still
replays the complete retained transcript.

Resource limits:

- 100 events requested per Peon snapshot page, at most 250 accepted in one
  inbound page;
- four active snapshots per Peon connection, 1,000 pages, 20,000 events,
  16 MiB and a 30-second lease per snapshot;
- 1,000 / 8 MiB of durable frames buffered while snapshots fence the shared
  cursor;
- 64 unique active-or-pending transcript subscriptions per Peon control
  connection, with bounded correlated response waits;
- 20,000 events / 16 MiB retained per session;
- 50,000 events / 256 MiB across the central transcript projection; and
- 8 MiB maximum buffered output for a slow browser.

Global retention evicts whole least-recently-read live-tail projections, never
an older prefix that could be mistaken for complete replay state. A later live
subscription deterministically rebuilds it from Peon's canonical JSONL
transcript; history pages are unaffected.

## Payload-safe observability

Peon and Overseer expose process-local aggregate snapshots for transcript
freshness and recovery instrumentation. They deliberately contain no Peon,
workspace, project, session, event, delivery, actor or request identifiers and
never accept transcript bodies, prompts, tool data, attachment names/paths or
credentials. Labels are closed enums; unknown values collapse to `other` or
`protocol_error`, so hostile or novel input cannot create a metric series.

Peon measures durable admission latency/result and current outbox count, bytes
and oldest age in exactly two capability buckets: `transcript-sync-v1` and
`other`. Overseer measures delivery-to-commit-and-ACK, snapshot and catch-up
duration/result; fixed counters cover gaps, epoch changes, resyncs, replay
mismatches, eviction/rebuild, slow-client disconnects and recovery completion.
Demand gauges report only session, consumer and shared-consumer totals.
Durations use ten fixed buckets (`<=100 ms` through `<=60 s`, plus overflow),
so percentile approximations remain measurable without creating dynamic metric
series.

An operations dashboard should graph p50/p95/p99 from the duration aggregates,
outbox oldest age/count/bytes, recovery result rate, gap/resync/replay-mismatch
rates, slow-client disconnects and active versus shared demand. Alerting should
pair sustained outbox age with a non-zero backlog, alert immediately on replay
mismatch, and use recovery failure/latency and gap/resync rates as burn-rate
signals. Do not add identifier labels while building those views.

No production alert threshold is selected yet. The first dev baseline must be
collected during normal idle/active use and controlled reconnect, epoch-change,
projection-eviction and slow-client scenarios. Record p50/p95/p99, maximum
outbox age/bytes, recovery result counts and demand peaks for each scenario for
at least one working day; choose thresholds only after that sample exists.
The local unit baseline for the instrumentation itself is deterministic: a
three-session demand sample totals six consumers and three shared consumers,
and the redaction/cardinality suites collapse 1,000 attacker-controlled labels
to one bounded series.

At most four transcript snapshots execute concurrently per Peon. Up to the
negotiated 64 unique subscriptions (including durable-only repairs) may wait in
a FIFO queue behind those slots. Completing or failing a snapshot starts the
next queued repair; a fifth simultaneous gap therefore cannot close the shared
control socket or starve already-ready sessions. Releasing the last browser
demand removes a queued browser-only rebuild, while a rebuild needed to retire
a durable cursor remains queued.

## Executable conformance

The shared `@rnm-dev/protocol-conformance` workspace covers this contract with
golden snapshot/page/live/deletion frames, the complete supported mixed-version
matrix and deterministic fault scenarios. It exercises commit/ACK crash
boundaries, gaps and stale generations, epoch and cursor recovery, snapshot/live
races, eviction/rebuild, pressure and malformed or mismatched replay input.
These tests assert one committed client effect, no ACK across a gap and eventual
snapshot convergence while emitting only bounded, payload-free diagnostics.
They run as part of the repository root `npm run verify` gate; see
[protocol conformance and failure injection](protocol-conformance-harness.md).
