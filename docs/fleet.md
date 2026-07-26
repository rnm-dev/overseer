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

After a refreshed catalog changes the workspace set, live sync adds sockets for
new workspaces and closes sockets for removed workspaces without restarting
unaffected connections.

## Shared native services

Push registration remains active in every authenticated runtime so an inactive
Overseer can still route a notification to its connection.

iOS Live Activities and Android ongoing-session surfaces use the selected
runtime only. The platform activity channel is process-global, so hidden
runtimes must not install competing handlers. Switching the selected Overseer
disposes the previous activity adapter while leaving its fleet and WebSocket
runtime active.
