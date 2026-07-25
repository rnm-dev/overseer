# Session transcripts

Session detail renders durable transcript events from Drift first, reconciles
the newest page through REST, and then follows the session tail over the
workspace WebSocket.

Only Peons with `transcript-pagination-v1` are supported. Every event therefore
has a stable `eventId`, transcript pages use opaque cursors, and the live stream
can resume strictly after an HTTP snapshot boundary.

## Cache

`cached_transcript_events` stores one row per durable event, scoped by
workspace, peon, and session. Its primary key includes `eventId`; repeated REST
or tail delivery updates the existing payload rather than creating a duplicate.
`orderKey` is local presentation order and must not be derived from the opaque
event ID.

`cached_transcripts` stores whether the latest fetched page reported older
remote history. REST cursors are intentionally kept only by the mounted
controller: after reopening a session, the client requests a fresh newest page
and obtains a new cursor chain.

`cached_queued_followups` stores the last authoritative Peon queue snapshot in
FIFO order. The queue renders from this cache before its initial REST refresh,
and an empty authoritative snapshot clears stale rows transactionally.

`pending_followup_commands` stores committed attachment type/path metadata with
the prompt, overrides, command ID, and delivery mode. It never stores selected
file bytes.

The cache contains pages the operator has actually loaded plus live events. It
does not eagerly download the entire transcript.

## Opening a session

1. Read and watch cached events in ascending `orderKey`.
2. Render those rows immediately.
3. Fetch the newest 50 events from
   `GET /api/workspaces/:workspaceId/peons/:peonId/sessions/:sessionId/transcript`.
4. Upsert the page by `eventId` in one Drift transaction.
5. Subscribe to the session tail with the last event ID from that HTTP page.

Passing the HTTP boundary as `lastEventId` closes the fetch-to-subscribe race:
events appended after the snapshot are replayed by the durable tail.

The UI uses a reversed list whose first data item is the newest event. Loading
older pages inserts above the current viewport, so the visible scroll anchor
does not jump. Live updates follow the tail only while the viewport is already
at the bottom; reading older content preserves the operator's scroll position.

## Presentation

Drift stores the durable wire events unchanged. The presentation adapter
flattens them into the same semantic rows as the web client:

- `user_message` becomes an operator bubble with author, avatar, timestamp, and
  inline attachment pills.
- Assistant text renders directly on the transcript surface; thinking is an
  inline expandable row.
- An assistant `tool_use` and the later user-role `tool_result` are paired by
  `tool_use_id` and rendered once as a compact tool row. Each row reserves a
  dotted-underlined `Details` affordance. It opens the shared app bottom sheet:
  regular tools show scrollable command and output sections, compound JSON
  output is formatted, and errors retain their failure treatment. Edit-family
  rows show web-compatible colored added/removed line counts and the details
  sheet replaces output with a numbered, colored diff.
- System reinitialization and rate-limit events are hidden.
- Run duration, turn count, cost, and output-token metadata attach to the last
  assistant text in that turn.
- Unmatched action output, previews, and raw fallback events remain visible in
  subdued inline treatments.
- Rows from the same side stay compact (3 px for an operator burst, 6 px for
  assistant/tool activity); a 24 px gap continues to mark a change of side.
- While the run is active, the transcript tail shows animated activity dots,
  a contextual label derived from the freshest assistant block, and elapsed
  step time. Its inline `Stop` action posts to the session cancel endpoint,
  disables as `Stopping…` while pending, removes the working row after
  acceptance, and keeps a retryable inline error on failure. Tail `result`
  events and REST status reconciliation also remove it.
- With the SCV sound pack selected, each fresh non-terminal agent tail event
  may play one bundled `work-active` clip. Clips never overlap or repeat
  consecutively. Cached history, user messages, terminal results, and duplicate
  event IDs stay silent; leaving the transcript or changing packs stops the
  current clip.

Transcript attachment pills with a committed `path` open a dedicated
full-screen attachment detail surface. Transcript `preview` cards open the
same surface in artifact mode. Both are read-only and reuse the shared file
renderer for images, PDFs, Markdown, HTML, and syntax-highlighted source. The
viewer fetches sent attachments through the Peon files endpoint and preview
artifacts through the session file endpoints; failures retain an explicit
Retry action.

## Composer

Session detail keeps a compact composer dock below the transcript. Its dark
surface, focus ring, autoresizing text field, attachment affordance, and
send/queue actions follow the web hierarchy. Action pucks are 32 logical
pixels while retaining 45-pixel mobile touch targets.

The composer floats above the transcript instead of consuming list layout
space. Messages can scroll behind its gradient surface, while the transcript
tail receives bottom padding measured from the composer's current rendered
height. The final message therefore remains fully visible at rest even when
the composer grows to multiple lines.

Text drafts are stored in `composer_drafts`, scoped by workspace, Peon, and
session. Drafts render cache-first and are removed only after the message has
been accepted for delivery or durable retry.

The Peon screen's New session action opens this same detail surface with the
reserved local draft scope `new-session`, an empty transcript, and no project
files action. The first composer submit sends
`POST /api/workspaces/:workspaceId/peons/:peonId/sessions` with a stable
`Peon-Request-Id`, then replaces the local state with the returned real session
without adding another navigation layer. The cached session row is written
immediately so the underlying session list can reconcile in place.

The new-session transcript area uses the cached-first project catalog as a
project selector. A short catalog is centered vertically and horizontally in
the space above the composer; longer catalogs scroll without moving the
composer. Selecting a row highlights it, updates the session header, and sends
that project's key with the create-session request. Opening New session from a
project detail page preselects that project.

New sessions and follow-ups share the same attachment flow:

- choose files with the system picker or paste clipboard files and images;
- accept up to ten files of 25 MB each;
- accept Android rich-keyboard images, including URI-only payloads;
- show removable chips and separate reading, upload, and submission progress;
- verify uploads with `Peon-Content-Sha256`; and
- use `(see attachments)` for an attachment-only message.

Files are checked before loading, so rejected choices do not consume memory or
valid slots. Upload names receive stable numeric suffixes on collision.
Failures preserve the selection for retry, and a selection beyond ten files
reports how many were rejected.

The client allocates the follow-up command ID before upload and uses it as the
upload directory and eventual idempotency key. A failed upload keeps the
selected bytes and that ID for an unchanged retry. Changing the draft or
attachment selection allocates a new ID on the next Send. Once every upload is
committed, its type/path metadata is stored with the pending command in Drift;
raw attachment bytes are never stored there. A transient `/followup` or
`/queue` failure therefore retries the same body and ID in FIFO order without
re-uploading the files. Once the command is accepted for immediate delivery or
durable local retry, the composer clears and releases the selected bytes.

After any required uploads, every submission is written to
`pending_followup_commands` with a stable client-generated command ID and its
committed attachment paths. Idle sessions use
`POST /api/workspaces/:workspaceId/peons/:peonId/sessions/:sessionId/followup`
and pass that ID through `Peon-Request-Id`. Running sessions use the Peon's
server-owned queue endpoint and include the same ID as `commandId`; the
secondary lightning action also passes `startNow: true`. Overseer durably
deduplicates that `commandId`, so retrying after a lost response cannot enqueue
the same turn twice.

Transient transport errors and HTTP 408, 425, 429, or 5xx responses retain the
local command for exponential retry. Commands for one session remain FIFO, so
a later prompt cannot overtake an earlier failed prompt. Permanent failures
remove the rejected command and leave the draft visible with an inline error.

New sessions send text plus optional agent, model, and reasoning-effort
overrides. Existing sessions keep their original agent and allow only model
and effort changes, matching the Peon follow-up contract. A single compact
toolbar control shows the effective values and opens a shared capability
bottom sheet. It loads the Peon's provider capability catalog from `/models`,
silently hides the control for Peons without the catalog, and retains overrides
with a pending command across retries.

## Authoritative queue

Opening an existing session renders the cached queue and reconciles it with:

```text
GET /api/workspaces/:workspaceId/peons/:peonId/sessions/:sessionId/queue
```

Peon order is authoritative. Queue snapshots are serialized so an overlapping
transcript `change` signal schedules one final refresh instead of allowing an
older response to replace a newer one. While the queue is non-empty, a
two-second REST poll guards against Peons that miss the automatic dequeue
signal.

Peons that do not implement the queue endpoint return 404. The client clears
any stale cached queue and silently disables authoritative queue polling for
that mounted composer instead of presenting a persistent error.

Each queued follow-up appears above the composer as a compact operator-side
card with its prompt and attachment names. It intentionally omits author,
permission, model, and effort metadata to match the web hierarchy. Its mobile
actions retain at least 42-by-44 logical-pixel touch targets:

- Send now posts to
  `/queue/:itemId/send`.
- Remove deletes `/queue/:itemId`.

Both actions reconcile the authoritative list in `finally`. An
`UNKNOWN_QUEUE_ITEM` response is treated as an already-completed race and does
not surface an error. A non-empty queue also keeps the session's working state
active across consecutive turn results so the UI does not flash idle between
automatically dequeued turns.

Initial loading and REST reconciliation share a centered loading pill over the
top of the transcript. It waits two seconds before fading and sliding into
view, so cache hits and fast refreshes do not flash loading chrome, and fades
and slides back out when reconciliation finishes.

The session navbar is also cache-first. Its title comes from the cached session
summary, while turn and token statistics are derived from cached `result`
events. The session-details request silently replaces those values with its
authoritative totals when it completes. The statistics row keeps its height
when no cached totals exist, but does not show a shimmer.

## Older history

The mounted controller owns the opaque `nextCursor`. `Load older events`
requests the next server page and prepends unseen IDs. When cached history
already overlaps the returned page, the controller advances through duplicate
pages until it reaches an unseen event or the server reports no more history.

## Live reconciliation

The existing workspace WebSocket multiplexes presence, workspace projections,
and session tails. Each active transcript subscription tracks its own
`lastEventId` and retry backoff.

- A tail event is committed to Drift before the next socket frame is handled.
- Socket reconnect resubscribes every mounted transcript after the workspace
  snapshot.
- `tailEnd` and retryable `tailError` resubscribe independently without
  replacing the workspace socket.
- After 15 seconds of silence in a running session, the controller checks the
  small session-details endpoint.
- A terminal tail, malformed frame, or completed run triggers a bounded newest
  page reconciliation.
- Transient fallback failures preserve cached rows and do not mark the cache
  unusable.

Workspace replay cursors and transcript event IDs are separate protocols and
must never share storage.
