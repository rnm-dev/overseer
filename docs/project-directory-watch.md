# Live project directory updates

Web's project Files page and chat Files sidebar subscribe to the directories
currently visible and expanded. Peon observes those directories with native
`fs.watch`; Overseer relays invalidations over the existing workspace WebSocket.
There is no regular directory polling and no second browser connection.

## Transport

1. After the workspace `snapshot` advertises `project-directory-watch-v1`, the
   browser sends `files:subscribe` with `watchId`, `peonId`, `projectKey` and
   project-relative `path` (`""` means root).
2. Overseer authorizes workspace membership, Peon and the immutable indexed
   project identity. Session guest/participant sockets cannot subscribe.
3. Overseer opens authenticated Fleet HTTP
   `GET /api/v1/projects/:key/files-watch?path=...&projectId=...`. Peon checks
   the pinned project ID and realpath containment, attaches the watch, then
   emits SSE `ready`. Native event bursts coalesce for 150 ms into `changed`.
   Both carry only `{}`. `failed` ends a broken or replaced watch.
4. Overseer sends `files:ready` or `files:changed` with the client's `watchId`.
   Both trigger an authoritative directory listing through the existing
   [HTTP file plane](file-viewing.md). File bytes never travel over this socket.
5. `files:unsubscribe` releases the watch. Folding an ancestor, hiding the tab
   or CSS-hidden sidebar, changing project and unmounting release subscriptions.

The [wire schema](protocol/project-directory-watch-v1/schema.json) and
[fixtures](protocol/project-directory-watch-v1/fixtures.json) define the frames.
No durable replay cursor is needed for an invalidation: every successful
subscription and reconnect rereads the current directory. An event during an
HTTP request queues one trailing read, so a pre-event snapshot cannot swallow
an update. Reads use `cache: no-store`; expansion and usable rows survive refresh.
Focus/online also reconcile active trees. Failed reads and failed subscriptions
retry with exponential backoff from 1 to 30 seconds, cancelled on unsubscribe.
Healthy directories have no refresh timer.

## Ownership, security and bounds

- Peon shares native watchers by canonical directory and device/inode. It
  allows at most 1,024 native watchers and 2,048 SSE streams per router.
- Overseer shares an upstream by workspace, Peon, immutable project ID, root
  and relative path. The last subscriber aborts it. Limits are 128 directory
  subscriptions per client and 1,024 shared upstream streams per server.
- Every event delivery rechecks current membership and project ACL. Peon's
  15-second heartbeat also drives idle ACL revalidation and validates the
  original root/target identity. Replaced, deleted or escaping targets fail
  closed. A new subscription can attach to a newly created inode.
- Watch setup checks traversal, absolute paths and escaping symlinks. No event
  discloses an absolute path, a filename or file contents.
- A single dirty bit coalesces events while authorization is running. Upstream
  SSE buffering is capped at 16 KiB; 45 seconds of silence aborts the upstream.
  Peon closes backpressured SSE consumers. The existing client WebSocket's
  8 MiB buffer cap and heartbeat reaper handle slow/dead clients.
- Project switches and disconnects fence pending authorization and listing
  responses. Overseer restart/socket reconnect resubscribes; no watchers are
  durable and none live without subscribers.

## Compatibility and limits

Peon advertises `project-directory-watch-v1` at registration. An older Peon or
Overseer yields an unavailable status; the web tree shows a refresh action.
There is no hidden polling fallback. Manual refresh, completed-turn refresh and
browser file mutation refresh remain available. The daemon must be updated and
restarted before the new capability is advertised.

Native filesystem notifications are hints, not a durable change log. Network
filesystems or silent OS notification loss can require manual/focus refresh.
A watcher monitors direct entries only; descendants get their own watchers when
expanded. Root/target identity checks on heartbeat are metadata checks, not
periodic directory enumeration. This implementation updates web trees (including
webview clients); the Flutter tree has not adopted this subscription contract.
