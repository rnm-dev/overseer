# Transcript history and live tail

Peon's append-only JSONL transcript is the only message store. Overseer never
persists, projects, edits or reconstructs transcript bodies.

## One simple contract

Opening a session uses two paths with separate jobs:

1. The client reads the newest transcript page through
   `GET /api/workspaces/:workspaceId/peons/:peonId/sessions/:sessionId/transcript`.
   Overseer authorizes the operator and forwards the request through the direct
   authenticated Fleet HTTP path. Older pages use the returned opaque cursor.
2. The client subscribes on its existing workspace WebSocket with
   `{type:"subscribe",peonId,sessionId,lastEventId?}`. This does not create a
   second client connection. Overseer opens Peon's authenticated Fleet HTTP SSE
   stream, relays committed frames through that WebSocket and closes the
   upstream stream when the client unsubscribes or disconnects.

Every canonical event has one Peon-authored `eventId`, persisted in the JSONL
row and returned by both HTTP pages and live frames. Clients upsert by
`(workspaceId, peonId, sessionId, eventId)`. Duplicate delivery is harmless;
payload matching and locally manufactured transcript rows are forbidden.

## Commit and replay boundary

Peon publishes a live event only after its JSONL append succeeds. The Fleet SSE
handler registers its commit listener before reading the committed suffix, so
an append racing stream setup is either in the replay, in the buffered live
commits, or both; `eventId` deduplication reduces both to one client row.

The client normally supplies the newest `eventId` from the HTTP page and Peon
replays strictly after it. A missing or unknown boundary replays at most the
newest 50 committed events. The live stream is never an unbounded history
endpoint; older or disjoint history is reconciled through HTTP pagination.

Delivery is deliberately **at least once**. There is no transcript ACK,
snapshot epoch, sequence space, generation fence, Postgres inbox, message-body
projection or selective-ACK hole. After a disconnect the client resubscribes
with its last applied `eventId`; after a malformed frame, failed cache write or
suspected gap it reads the newest HTTP page and resubscribes from that boundary.

## Authorization and bounds

Overseer checks workspace, Peon, session and project access before opening a
tail and again before each relayed frame. Revocation aborts the upstream stream
and sends a non-retryable `tailError` without delivering another row.

The browser/mobile connection remains the single multiplexed workspace
WebSocket. Each mounted session owns at most one upstream Peon SSE stream per
client connection. One SSE frame is limited to 1 MiB; queued frame delivery is
limited to 1,000 frames / 8 MiB; a client WebSocket with more than 8 MiB already
buffered is terminated and recovers from HTTP plus `eventId`.

The newest HTTP page is bounded (50 by default, 500 maximum), pagination
cursors are session-bound, and Peon's transcript index makes page reads
independent of total transcript size. Mobile may paint its local cache while
offline, but a cached boundary does not become server authority.

## Session changes and deletion

The same Peon SSE stream may emit transient `change` frames so clients can
refresh queue/session metadata. Canonical session state still comes from the
session APIs and catalog. Deleting a session terminates its stream; deletion is
not represented as a synthetic transcript row.

## Compatibility and removal

`transcript-sync-v1` is retired. Current Overseer ignores that capability from
an older Peon, so the older Peon does not publish reverse transcript messages
and its existing Fleet HTTP SSE endpoint is used. Current Peon no longer
advertises the capability; an older Overseer therefore selects its existing
Fleet HTTP fallback. Public client WebSocket and transcript page shapes are
unchanged.

Migration `035_remove_transcript_projection` removes the rebuildable
`peon_transcript_sync` and `transcript_events` tables and stale transcript rows
from Overseer's general event log. Peon's JSONL transcripts and client caches
are untouched.

## Required regression coverage

- publish only after the canonical append boundary;
- page-to-tail append races have no missing row;
- reconnect resumes after `eventId` and duplicates remain idempotent;
- missing/unknown boundaries replay only the bounded newest window;
- malformed frames reconcile through HTTP;
- concurrent subscribers receive the same ordered committed events;
- ACL revocation closes an existing tail before another row; and
- slow clients, oversized frames and disconnect cleanup remain bounded.
