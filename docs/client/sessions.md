# Session list

The peon home page renders sessions from Drift first and reconciles them with
Overseer afterward.

## Data flow

1. `SessionRepository.loadCachedSessions` reads the selected peon's cached
   sessions.
2. `SessionRepository.watchSessions` keeps the page subscribed to the same
   rows, ordered by descending `lastActivityAt`, then `startedAt`, then
   `sessionId`.
3. The controller refreshes the first 20 sessions from
   `GET /api/workspaces/:workspaceId/sessions?peonId=...` and loads older pages
   by offset. While the page remains mounted, it silently reconciles the first
   page every 5 seconds as a backstop for a temporarily disconnected workspace
   socket or missing catalog updates.
4. The workspace WebSocket forwards every `session` projection to the
   repository. The projection and workspace cursor are committed in one Drift
   transaction.
5. Activity projections update `lastActivityAt`, so Drift emits the reordered
   list without presentation-layer sorting. Delete projections remove the row.

Every durable session projection also carries `projectSessionCounts`, an
authoritative list of the affected project totals after that mutation. Web
assigns those totals directly to its project rows, and Flutter updates
`cached_projects` in the same transaction as the session projection and live
cursor. Assigning a total instead of applying a delta makes replay and duplicate
delivery idempotent even though session history is paginated. Flutter also
adjusts the cached total immediately after a locally accepted create/delete;
the following projection replaces that provisional value with the authoritative
count.

The cache retains the complete known history, while the sliver-native Peon
history lazily builds only rows near the viewport and exposes 20 sessions at a
time. Approaching the end automatically reveals the next cached page, which
remains useful offline, and requests another server page only after the visible
cache has been exhausted.

Rows use `(workspaceId, peonId, sessionId)` as their local identity and
`syncedAt` for last-writer-wins reconciliation. Older REST or WebSocket
projections cannot regress newer cached data.

Session history and current activity have separate freshness rules. Drift owns
the offline-first history, but cached `status == running` does not make a
session row active. Until live sync has seeded the workspace's authoritative
active-session set, session rows default to inactive so stale cache hydration
and lazy row construction cannot flash a false running glow.
Every successful REST session page immediately contributes its current
`status=running` rows to the in-memory active set and retires prior REST
observations for rows that the page now reports terminal. Cached Drift status
alone remains insufficient, but opening a list no longer waits for a WebSocket
before showing activity that its authoritative REST response already proved.

After each workspace socket snapshot, the client still fetches every indexed
`status=running` page and publishes the resulting session IDs with their
`peonId`, `projectId`, and `projectKey`. This complete socket-barrier seed takes
precedence over partial REST-page observations. While it is rebuilding, the
last fresh REST observation remains visible rather than flashing false idle.
An empty successful seed clears stale indicators; a failed seed leaves REST
evidence usable. During startup, the client buffers session projections until
both the running-session seed and every initial cursor replay have finished,
then publishes one reconciled active set. Later session projections update
both Drift and the active set.

Submitting a follow-up adds a narrow in-memory running marker before the HTTP
request starts, so the transcript and session row show activity immediately
instead of waiting for the next socket projection. A refusal or locally queued
retry removes it. An authoritative snapshot that first observes the session
running takes ownership of the marker, and its later terminal snapshot removes
the activity normally; unrelated workspace updates cannot erase a start that
has not reached the projection yet.

Visible rows animate into activity order. Newly inserted rows appear in their
authoritative slot, and reduced-motion preferences disable reordering effects.

Session and project rows mirror the web sidebar. State is carried by a
two-pixel left edge rather than a dot: authoritatively running is green, an
unread completion is amber, failures are red, and idle is a quiet neutral edge.
Changes to a session's status, activity, preview, title, or unread state replay
a 620 ms edge flare; project rows do the same when their name, rollups, active
count, or session activity changes. Initial cached hydration stays still.
Section headers and rows are full bleed, with the same typography, padding,
and four-pixel list insets as the web sidebar.

Opening a session sends
`POST /api/workspaces/:workspaceId/peons/:peonId/sessions/:sessionId/attention/read`.
The acknowledgement updates the cached row only after the server accepts it,
so the amber unread edge clears immediately when returning to the list.
Returning to the foreground retries the idempotent acknowledgement. A failed
request does not block the cached transcript or incorrectly claim that it was
read.

The Peon session state machine remains `running → completed`. Operator request
lifecycle is orthogonal: `hasOutstandingRequest`, `lastRequestedAt`, and
`attentionUnread` are user-scoped projections backed by Overseer
`session_attention`. They must not be inferred from the session status or from
an outcome value.

Project detail reuses this same cached/live list with a presentation filter:
canonical `projectId` matches first, while `projectKey` is a fallback when a
projection lacks an ID. The shared session controller continues to own
pagination and live reordering.

The WebSocket sends an explicit `resume` after the initial server snapshot
because the current server snapshot contains peon presence but no materialized
session catalog. REST remains the authoritative reconciliation path when the
retained event log cannot cover a gap.

## UI states

The page distinguishes:

- local-cache loading;
- cached or refreshed results;
- an empty catalog;
- a stale catalog reported by the server;
- a recoverable refresh error while preserving cached rows;
- loading older pages.

Opening a session transcript and subscribing to its live tail remain separate
from list synchronization. See [transcripts.md](transcripts.md) for that flow.
