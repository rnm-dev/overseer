# Fleet cache and multi-Overseer live sync

The application keeps one isolated runtime mounted for every saved Overseer
connection. Selecting an Overseer changes which runtime is visible; it does not
dispose the other runtimes.

## Runtime lifecycle

Each runtime owns its connection-specific:

- authentication state and secure device token;
- Drift database;
- HTTP client;
- cached workspaces and Peons;
- workspace cursors and WebSocket service;
- active-session and presence projections.

Every runtime restores authentication independently. Once authenticated, it
loads its fleet and opens one WebSocket for every workspace. Hidden runtimes
remain mounted and continue reconciling their caches while the application
process can execute. Failure or sign-out in one runtime does not stop another.

Deleting a saved connection removes its runtime from the mounted stack. Normal
provider disposal then stops its sockets and closes its HTTP client and
database. Credential removal remains part of the connection deletion flow.

The operating system may suspend the application in the background. Ordinary
WebSockets are therefore guaranteed only while the process can execute. Each
workspace persists its cursor; reconnecting resumes ordered events and REST
remains the reconciliation fallback.

## Cached-first fleet

Each connection database stores the latest workspace catalog and Peon catalog
in `cached_workspaces` and `cached_fleet_peons`.

The fleet controller:

1. reads the cached fleet;
2. renders it immediately when present;
3. observes both fleet tables for changes;
4. refreshes workspaces and Peons from REST in the background;
5. replaces the fleet snapshot atomically;
6. applies live Peon projections to the same cache.

The initial loading shell is reserved for a connection that has no cached
fleet. A failed background refresh preserves the visible cached fleet.

Fleet refreshes opt into the authenticated operator's bounded recent-session
projection with
`includeRecentSessions=mine&recentSessionsLimit=10`. The response remains one
request per workspace: every Peon carries its recent sessions, and the
repository upserts them into `cached_sessions` in the same fleet transaction.
The overview renders the first three per Peon while retaining the larger buffer
for deletion and reorder backfill. Adjacent Peon groups keep one `xs` spacing
step between them, placed after the previous Peon's final recent-session row.
The Peon header is a compact 44-pixel row: online state precedes the name,
operator presence follows it inline, and a session-list-style `+ NEW SESSION`
action replaces the active-session count on the right.

Operator membership, request lifecycle, and response attention remain separate
from the Peon session state machine. Cached rows store whether the current
operator has requested work, whether a request is still outstanding, the last
request timestamp, and whether a completed response is unread. A refresh
replaces the operator-scoped projection without regressing attention events
that arrived after the request began.

The Peon session-page refresh shares those cached rows but does not necessarily
carry the operator membership or request-lifecycle fields. Its merge updates
only fields present in that response, so opening a Peon and returning to Fleet
cannot remove the personalized recent-session projection.

After a refreshed catalog changes the workspace set, live sync adds sockets for
new workspaces and closes sockets for removed workspaces without restarting
unaffected connections.

Workspace `attention` events update the same cached rows and cursor
transactionally. New rows enter the overview, activity changes move them into
authoritative order, and state changes replay the shared status-edge flare.
Reduced-motion preferences suppress entrance, reorder, and flare animation.

## Shared native services

Push registration remains active in every authenticated runtime so an inactive
Overseer can still route a notification to its connection.
