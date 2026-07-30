# Reverse transcript projection and live relay

Overseer serves transcript history and live session tails without dialing a
Peon's HTTP or SSE listener when the control socket negotiates
`transcript-sync-v1` together with `session-catalog-v1` and
`durable-delivery-v1`. Peon remains authoritative; Postgres contains a bounded,
rebuildable projection.

## Authority and ACL

The transport is selected once per Peon/session request:

- an active negotiated reverse connection requests or renews the reverse
  projection and never starts a legacy request in parallel;
- a previously committed reverse projection remains the read authority while
  the Peon is offline, with freshness reported as `offline`;
- before any reverse projection has committed and with no negotiated reverse
  connection, the existing Peon HTTP/SSE routes remain the exclusive fallback;
- after reverse authority exists, an eviction, gap, or outage is surfaced as
  `syncing`, `gap`, `evicted`, or `offline`; it is not hidden by switching back
  to HTTP.

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

## Gaps, reconnects and restart

Events received during a snapshot remain behind the Peon-wide ordered durable
frontier. After the atomic snapshot, events at or below its barrier are
committed as covered delivery; newer events apply in order.

An epoch change, missing checkpoint, sequence gap, `CURSOR_UNAVAILABLE`, or
`RESYNC_REQUIRED` changes freshness to `syncing` or `gap` and requests a fresh
snapshot. No ACK crosses the gap. Because the one durable queue is ordered,
catalog, transcript and other durable payloads do not overtake it.

On a normal reconnect, Overseer sends
`transcript_subscribe {requestId,sessionId,epoch,afterSeq}`. Peon supplies the
bounded canonical catch-up before `transcript_subscribed`. If that suffix is no
longer available, the same connection rebuilds by snapshot. Socket replacement
claims a new generation in both the catalog and transcript rows; late frames
from the old generation cannot write or ACK. An Overseer restart retains the
projection/checkpoints, while process-local demand is rebuilt from browser
re-subscriptions.

Demand is shared per Peon/session. Many browsers therefore create one Peon
subscription, not one each. The last authorized consumer sends
`transcript_unsubscribe` and cancels a demand-only snapshot. A snapshot needed
to unblock an already durable Peon message completes even without a browser,
then releases demand.

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

The existing transcript REST shape remains `{events,nextCursor,hasMore}` and
adds:

```json
{
  "freshness": {
    "state": "ready",
    "updatedAt": 1785400000000,
    "epoch": "transcript-epoch",
    "revision": 42,
    "barrierSeq": 42
  }
}
```

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

Global retention evicts whole least-recently-read sessions, never an older
prefix that could be mistaken for complete history. The row becomes `evicted`;
the next authorized demand deterministically rebuilds it from Peon's canonical
JSONL transcript.
