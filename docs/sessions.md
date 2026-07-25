# Session list

The peon home page renders sessions from Drift first and reconciles them with
Overseer afterward.

## Data flow

1. `SessionRepository.loadCachedSessions` reads the selected peon's cached
   sessions.
2. `SessionRepository.watchSessions` keeps the page subscribed to the same
   rows, ordered by descending `lastActivityAt`, then `startedAt`, then
   `sessionId`.
3. The controller refreshes the first 50 sessions from
   `GET /api/workspaces/:workspaceId/sessions?peonId=...` and loads older pages
   by offset. While the page remains mounted, it silently reconciles the first
   page every 5 seconds as a backstop for a temporarily disconnected workspace
   socket or missing catalog updates.
4. The workspace WebSocket forwards every `session` projection to the
   repository. The projection and workspace cursor are committed in one Drift
   transaction.
5. Activity projections update `lastActivityAt`, so Drift emits the reordered
   list without presentation-layer sorting. Delete projections remove the row.

Rows use `(workspaceId, peonId, sessionId)` as their local identity and
`syncedAt` for last-writer-wins reconciliation. Older REST or WebSocket
projections cannot regress newer cached data.

Session history and current activity have separate freshness rules. Drift owns
the offline-first history, but a cached `status == running` is only a fallback
until live sync has seeded the workspace's authoritative active-session set.
After each workspace socket snapshot, the client fetches every indexed
`status=running` page and publishes the resulting session IDs with their
`peonId`, `projectId`, and `projectKey`. Project counts and running indicators
use that set instead of historical Drift statuses. An empty successful seed
clears stale indicators; a failed seed leaves the set unknown so cached state
remains usable offline. Later session projections update both Drift and the
active set.

Visible rows animate into activity order. Newly inserted rows appear in their
authoritative slot, and reduced-motion preferences disable reordering effects.

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
