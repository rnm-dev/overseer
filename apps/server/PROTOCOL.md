# Overseer ↔ Peon protocol (`/api/v1`)

> **Vendored snapshot.** The canonical copy lives in the peon repo
> (`peon/PROTOCOL.md`); paths like `src/daemon/*` below refer to that repo. The
> peon side is frozen/stable, so this copy is safe to code the overseer against —
> if the peon contract ever changes, re-copy it here. This is the full wire
> contract for both directions between the overseer and its peons.

The machine-facing API an **overseer** (fleet control plane) uses to drive many
peons. It is separate from the human `/api/*` dashboard surface: its own auth,
its own version handle, none of the human presence bookkeeping. Implemented in
`src/daemon/agentApi.ts` (peon repo), mounted at `/api/v1` ahead of the human cookie
auth-gate in `controlServer.ts`.

The shared `reverse-command-v1` schema and golden frames are vendored under
`protocol/reverse-command-v1/`. Its first enabled operation is `session.cancel`.
Daemon pause/resume is intentionally local-only: Overseer may display paused
state but must not change it.

## Topology

- **Transport:** HTTP/JSON over a **Tailscale** tailnet. NAT (office desktops
  with no public IP) is solved by the overlay — every peon has a stable MagicDNS
  name the overseer can reach; WireGuard provides the encryption. Plain HTTP on
  the tailnet is acceptable.
- **Direction:** the **overseer is the client** for all *control* — request /
  response, the peon is a passive server. The one exception is discovery: the
  peon *announces itself* outbound (see "North-bound" below), so a NAT'd box with
  no inbound reachability is still discoverable.
- **Addressing:** `http://<peon>.<tailnet>.ts.net:4570/api/v1/...`

### Dedicated reverse transfer socket (staged)

Overseer exposes a second Peon-initiated WebSocket at
`/api/v1/peons/transfer/ws`. This data-plane connection is deliberately
separate from the control/session socket at `/api/v1/peons/ws`, so future bulk
file bytes cannot delay control heartbeats, acknowledgements, or session state.
Both sockets use the same enrolled, revocable Peon bearer credential and
Peon/workspace binding checks.

After the HTTP upgrade, Peon must send:

```json
{ "type": "hello", "protocol": 1, "channel": "file-transfer", "peonId": "optional-stable-id", "capabilities": ["project-file-read-v1"] }
```

Overseer answers:

```json
{ "type": "hello_ack", "protocol": 1, "channel": "file-transfer", "capabilities": ["project-file-read-v1"] }
```

At most one ready transfer connection is current per Peon; a newer successful
hello replaces the older generation. Transfer connectivity does not determine
Peon online presence, which remains owned by the control socket. Overseer sends
WebSocket ping frames every 30 seconds and terminates a connection that misses a
pong round. Credential revocation evicts both channels.

Overseer echoes only implemented transfer capabilities. A connected Peon that
does not negotiate `project-file-read-v1` is lifecycle-ready but unavailable to
the project file stream service; Overseer never sends it `file_open`.

The first data-plane operation is a project-relative file read. Its authenticated
browser surface uses stable project identity:

```
GET /api/workspaces/:wsId/peons/:peonId/projects/by-id/:projectId/files/{relativePath}
Range: bytes=<start>-<optional-end>
```

Overseer authorizes workspace, Peon, and project-ID access, rejects absolute or
traversing paths, and sends the trusted server-derived actor:

```json
{
  "type": "file_open", "protocol": 1, "requestId": "uuid",
  "projectId": "stable-project-id", "relativePath": "dist/index.html",
  "actor": { "userId": "stable-user-id", "email": "operator@example.com" },
  "range": { "start": 0, "end": 1023 }
}
```

Peon resolves the project ID and remains authoritative for canonical root,
symlink, permission, and file checks. It answers exactly one pre-body outcome:

```json
{ "type": "file_error", "requestId": "uuid", "status": 404, "code": "NOT_FOUND", "message": "file does not exist" }
```

or:

```json
{
  "type": "file_meta", "requestId": "uuid", "status": 200,
  "contentType": "application/octet-stream", "contentLength": 1234,
  "acceptRanges": "bytes", "etag": "optional", "lastModified": "optional"
}
```

Status `206` additionally requires `contentRange`. After valid metadata,
Overseer grants a bounded byte window with
`file_credit {requestId,bytes}`. Peon must not exceed cumulative granted credit.
File bytes use binary WebSocket frames with a 22-byte header: byte 0 protocol
version `1`, byte 1 frame type `1` (chunk), bytes 2–17 the UUID as 16 network
bytes, bytes 18–21 an unsigned big-endian sequence, then at most 65,514 payload
bytes. Sequence starts at zero. Peon finishes with
`file_end {requestId}`; the exact `contentLength` must have arrived.

Overseer sends `file_cancel {requestId,reason}` when the browser aborts, metadata
times out, or the transfer is no longer wanted. Socket disconnect/replacement
fails every request owned by that socket. Late frames for a recently cancelled
request are ignored for a short bounded window so a cancellation race cannot
kill other users' multiplexed transfers. Protocol violations close the transfer
socket. No complete file is buffered by Overseer.

### Reverse-connected session catalog (incremental rollout)

The canonical path requires both `session-catalog-v1` and
`durable-delivery-v1` in the authenticated WebSocket hello. The HTTP
registration capability list describes the Peon's HTTP API and is not used to
negotiate reverse-socket channels. Overseer echoes both or neither. Peons
without the pair retain legacy HTTP reconciliation until the first reverse
snapshot commits; the two authorities never run concurrently after cutover.

Hello carries independent catalog and delivery domains:

```json
{
  "type": "hello", "protocol": 1, "peonId": "stable-id",
  "capabilities": ["session-catalog-v1", "durable-delivery-v1"],
  "channels": { "session-catalog-v1": {
    "epoch": "catalog-epoch", "revision": 42, "earliestSeq": 10, "latestSeq": 42
  }},
  "delivery": {
    "epoch": "delivery-epoch", "earliestCursor": "opaque", "latestCursor": "opaque",
    "negotiated": false
  }
}
```

`delivery.negotiated` reports the Peon's state before the current
`hello_ack`; it is normally `false` on first contact and is never an admission
condition for the capability pair.

`hello_ack` returns accepted capabilities and, only when matching epochs are
resumable, `channels["session-catalog-v1"] = {epoch, acknowledgedSeq}` and
`delivery = {epoch, acknowledgedCursor}`. Catalog and delivery epochs are never
compared or substituted. Any stale checkpoint is omitted and causes a fresh
snapshot.

Overseer requests snapshot pages with
`session_catalog_snapshot_request {requestId, limit:100, cursor?}`. Peon returns
`session_catalog_snapshot_page {requestId, epoch, revision, barrierSeq,
sessions, nextCursor, hasMore}`. All pages retain the first page's epoch,
revision, and barrier. Overseer stages the bounded snapshot and atomically
replaces the active projection only on `hasMore:false`; cancellation, timeout,
disconnect, malformed pages, or changed barriers discard staging. Cancellation
uses `session_catalog_snapshot_cancel` / `session_catalog_snapshot_cancelled`.

Ordered changes travel inside:

```json
{
  "type": "durable_message", "epoch": "delivery-epoch", "cursor": "opaque",
  "messageId": "uuid", "priority": "normal",
  "payload": {
    "type": "session_catalog_event", "epoch": "catalog-epoch",
    "seq": 43, "revision": 43,
    "session": { "id": "session-id", "status": "running" }
  }
}
```

Deletion replaces `session` with `deletedSessionId`. Projection mutation,
authorized operator event, delivery inbox record, and both checkpoints commit
in one transaction. Only then does Overseer send independent cumulative
`durable_ack {epoch,cursor}` and `session_catalog_ack
{epoch,acknowledgedSeq}`. Replays are harmless by delivery epoch/cursor and
message ID; sequence gaps, wrong epochs, unknown payloads, or malformed frames
cannot advance acknowledgement and fence the connection.

Durable events received while a snapshot is staged retain their original
delivery order. Events newer than `barrierSeq` apply after the atomic snapshot;
events at or below the barrier are already represented by it but still commit an
idempotent inbox record and advance `durable_ack`, so covered messages cannot
remain stuck in Peon's delivery queue.

Overseer fences commits by connection generation, limits complete frames to 60
KiB, accepts at most 250 summaries per page, 1,000 pages, 10,000 summaries per
snapshot, 1,000 buffered events, and 8 MiB staged per sync. Inbound work is also
bounded per Peon and by an 8 MiB process-wide queued-byte budget. Last-known rows
remain available while stale or rebuilding. An abandoned *first* sync lease
expires after two minutes so legacy reconciliation can recover after a crash;
once migration-018 `catalog_epoch` exists, HTTP authority never resumes.

`GET /api/workspaces/:wsId/sessions` remains local, paginated, and ACL-filtered.
Its top-level `catalogs` array exposes each visible Peon's `online`,
`legacy|fallback|syncing|ready|stale|offline` state, stale flag, checkpoint
freshness timestamp, committed catalog revision, and delivery-commit presence.

### Reverse-connected project catalog

`project-catalog-v1` is an optional channel on the same authenticated control
socket and requires `session-catalog-v1` plus `durable-delivery-v1` during the
incremental rollout. It has its own catalog epoch and sequence, but shares the
single Peon-wide durable delivery epoch/cursor. Overseer therefore returns one
`hello_ack` containing the accepted capabilities and independently resumable
channel checkpoints:

```json
{
  "type": "hello_ack", "protocol": 1,
  "capabilities": ["session-catalog-v1", "durable-delivery-v1", "project-catalog-v1"],
  "channels": {
    "session-catalog-v1": { "epoch": "sessions", "acknowledgedSeq": 42 },
    "project-catalog-v1": { "epoch": "projects", "acknowledgedSeq": 8 }
  },
  "delivery": { "epoch": "delivery", "acknowledgedCursor": "opaque" }
}
```

Overseer requests bounded pages with
`project_catalog_snapshot_request {requestId,limit:100,cursor?}`. Peon returns
`project_catalog_snapshot_page {requestId,epoch,revision,barrierSeq,projects,
nextCursor,hasMore}`. Every project is the safe catalog document
`{projectId,key,name?,label?,dir?,path?,metadata?,quickLinks?}`. `quickLinks`
is the ordered Peon-owned collection of `{id,title,url,order}` absolute,
credential-free HTTP(S) links. `projectId` is immutable;
`key` is mutable routing/display metadata. File contents, directory trees,
skills, credentials, and session-derived rollups never enter this channel.

Ordered changes use the existing `durable_message` envelope with payload
`project_catalog_event {epoch,seq,revision,project}` or the deletion form
`{epoch,seq,revision,deletedProjectId}`. Overseer atomically commits the shared
inbox record, project projection/tombstone, project checkpoint, browser event,
and shared delivery checkpoint before sending `durable_ack` followed by
`project_catalog_ack`. While either negotiated catalog snapshot is incomplete,
all durable messages are buffered within the existing aggregate item/byte
limits and then drained in their original delivery order.

For a canonical Peon, project list/detail/settings reads are served from the
local projection and remain available while the Peon is offline. Create,
update, and delete remain authenticated HTTP commands during this slice; their
authoritative result returns through the project catalog. Older Peons retain
the proxied HTTP project APIs until their first project snapshot commits.

Overseer exposes workspace-scoped quick-link reads and owner-only mutations at
`/api/workspaces/:wsId/peons/:peonId/projects/:key/quick-links` and
`.../quick-links/:linkId`. Mutations write through to Peon, then refresh the
local projection from Peon's authoritative list; cached reads stay available
while the Peon is offline.

## Envelope

Every request:

| Header | Meaning |
|---|---|
| `Authorization: Bearer <token>` | shared secret = `settings.overseerToken`. Empty on the peon ⇒ whole namespace is off (`503 AGENT_API_DISABLED`). |
| `Peon-Protocol: 1` | optional; major-version check, `400 UNSUPPORTED_PROTOCOL` on mismatch. |
| `Peon-Actor: <email>` | optional; the canonical email of the human on whose behalf the command is issued. Trusted (the token is trusted) and forwarded into a session's `author`; mutable profile aliases such as a GitHub login are kept separately and never substituted here. |
| `Peon-Request-Id: <uuid>` | optional; correlation id, echoed back on the response. Doubles as the idempotency key for `POST /sessions`. |

Errors are always `{ "error": "<human message>", "code": "<STABLE_CODE>" }` —
**branch on `code`, never on the English string.** Codes: `AGENT_API_DISABLED`,
`UNAUTHENTICATED`, `UNSUPPORTED_PROTOCOL`, `BAD_REQUEST`, `UNKNOWN_SESSION`,
`SESSION_NOT_RUNNING`, `RESUME_IN_PROGRESS`, `DIR_MISSING`, `FILES_DISABLED`,
`PATH_ESCAPE`, `NOT_FOUND`, `IS_DIRECTORY`, `CHECKSUM_MISMATCH`,
`RANGE_NOT_SATISFIABLE`, `INTERNAL`.

## Endpoints

### Global Peon releases (Overseer-hosted)

These endpoints are served by Overseer rather than by an individual Peon.
Releases are global and are never scoped to a workspace.

```
PUT /api/releases/:version
  Authorization: Bearer <OVERSEER_RELEASE_TOKEN>
  Content-Type: application/octet-stream
  Peon-Content-Sha256: <optional SHA-256 hex digest>
  <raw .tar.gz bytes>

GET /api/v1/releases/latest
GET /api/v1/releases/:version/archive
  Authorization: Bearer <Peon recruitment credential>
```

Publishing returns `201 { release: { version, size, sha256, createdAt,
archiveUrl } }`. Versions are immutable; publishing an existing version returns
`409 RELEASE_EXISTS`. Archive downloads support byte ranges and return the
digest in `Peon-Content-Sha256` and `ETag`.

### Control / sessions (reuses the same stores as `/api/*`)

```
GET  /api/v1/status                     identity + live load and update availability
GET  /api/v1/models                     provider model + reasoning-effort capabilities
GET  /api/v1/sessions                   list all sessions
GET  /api/v1/sessions/:id               one session
GET  /api/v1/sessions/:id/transcript    full event transcript
POST /api/v1/sessions                   start; body { prompt, dir?, projectKey?, permissionMode?, agent?, model?, reasoningEffort? }
POST /api/v1/sessions/:id/followup      continue; body { prompt, permissionMode?, model?, reasoningEffort? }
POST /api/v1/sessions/:id/cancel        cancel the active run
POST /api/v1/control/pause | /resume    toggle settings.paused
POST /api/v1/control/check-update       run and return a fresh update check
POST /api/v1/control/update             install the available update
GET  /api/v1/sessions/:id/stream        SSE tail (events: `event`, `change`)
GET  /api/v1/sessions/:id/file          preview text/metadata; query `path`
GET  /api/v1/sessions/:id/file/raw      raw preview bytes; query `path`
GET  /api/v1/sessions/:id/file/stream   preview file-change SSE; query `path`
POST /api/v1/sessions/:id/preview       persist+broadcast preview; body { path }
GET  /api/v1/projects                   list projects            ⚠ PEON-SIDE TODO
GET  /api/v1/projects/:key/skills       discover project skills
GET  /api/v1/settings                   read the safe settings   ⚠ PEON-SIDE TODO
PATCH /api/v1/settings                  update settings (partial) ⚠ PEON-SIDE TODO
```

On an accepted follow-up, an explicitly supplied `model` and/or
`reasoningEffort` becomes that session's default for later turns. Omitting a
field retains the session's prior choice (or the Peon/provider default when the
session has none). Queued follow-ups capture their effective model and effort
when they enter the queue, so a later switch does not rewrite already queued
work.

`GET /api/v1/status` includes the update check state:

```json
{
  "updateAvailable": true,
  "updateLocalSha": "0123456789abcdef",
  "updateRemoteSha": "fedcba9876543210",
  "updateCheckedAt": 1783843200000,
  "updateCheckError": null
}
```

The SHA and check timestamp fields may be null before the first completed check.
`updateCheckError` is null after a successful check and otherwise contains the
latest check failure. Overseer uses `updateAvailable` to offer the update action,
which calls `POST /api/v1/control/update`. Its explicit "Check now" action calls
`POST /api/v1/control/check-update`; unlike `GET /api/v1/status`, that endpoint
waits for a new remote check and returns the refreshed update fields.

### Projects & settings on the agent surface — PEON-SIDE CHANGES NEEDED

> **Status:** the overseer proxies these (peon-detail page, `server.ts` `wp` block);
> **not yet implemented on the peon.** Until they land the overseer returns the
> peon's `404` and the UI shows a "not supported yet" notice. Auth = the existing
> `overseerToken` bearer, same gate as the rest of `/api/v1`.

```
GET  /api/v1/projects
  → 200 { projects: [ { key, path, sessionCount, activeCount, lastActivityMs } ] }
     (peon already tracks projectKey per session + a project store — aggregate that)

GET  /api/v1/settings
  → 200 { name, paused, fileTransferRoot, heartbeatIntervalMs }   // safe subset only

PATCH /api/v1/settings   { name?, fileTransferRoot?, heartbeatIntervalMs? }
  → 200 { ...updated subset }
     - partial body; persist atomically (reuse the local `PATCH /api/settings` logic)
     - never expose/accept `overseerToken` here

GET /api/v1/projects/:key/skills
  → 200 { skills: [ { name, description, path? } ] }
     - discovers project-local skills without caching or persisting them
     - `path`, when present, identifies the project-relative `.agents/skills/.../SKILL.md`
     - unknown projects return `404 UNKNOWN_PROJECT`
```

**Idempotency:** `POST /sessions` uses the session id — supply it via
`Peon-Request-Id` (or body `id`), and a replay of an id we already have returns
the existing record with `200` instead of spawning a second run. A dropped
response is therefore safe to retry.

### Concurrency — the control plane owns admission

The peon **runs sessions concurrently with no ceiling and no serialization**
(`sessions.ts`). It does *not* protect you from:

- **Same working directory:** two sessions on one `dir` edit the same files at
  once (an accepted footgun). Guard this in the overseer if you care.
- **Same session, two operators:** a followup to a running session
  **interrupts the current turn** and resumes with the new prompt
  (last-writer-interrupts). No corruption; the conversation keeps both prompts.
  The narrow teardown race returns `409 RESUME_IN_PROGRESS` (retryable). Track
  per-session presence / soft-locks in the overseer to avoid two operators
  chopping each other's turns.
- **Load:** unbounded concurrent starts. Read `activeSessionCount` from
  `/status` and impose your own per-peon ceiling / queue.

### File transfer

Sandboxed to `settings.fileTransferRoot`; disabled (`503 FILES_DISABLED`) until
an operator sets one. Every path is resolved against the root and rejected if it
escapes (`400 PATH_ESCAPE`). Content-addressed by sha256 from day one.

```
PUT /api/v1/files/<path>          upload; raw body streamed to disk
    Peon-Content-Sha256: <hex>      optional; mismatch ⇒ 409 CHECKSUM_MISMATCH, nothing committed
    → 201 { path, size, sha256 }    atomic rename into place on success
GET /api/v1/files/<path>          download; supports Range: (206 + Content-Range)
GET /api/v1/files/<path>?stat=1   metadata { size, mtimeMs, sha256 } or a directory listing
```

The sha256 header + Range support are what make a future **resumable / chunked**
upload a pure extension rather than a protocol break.

Project worktrees expose the same raw upload semantics under the project's own
root sandbox:

```
PUT /api/v1/projects/:key/files/<path>
    → 201 { path, size, sha256 }
PATCH /api/v1/projects/:key/files/<path>
    { "destination": "relative/new/path" }
    → 200 { path, size, sha256? }
```

The path is relative to the configured project directory. The Peon must reject
traversal and symlink escapes with `400 PATH_ESCAPE`, and unknown projects with
`404 UNKNOWN_PROJECT`, exactly as it does for project-file reads. PATCH performs
an atomic rename within the same project root and returns `409 DESTINATION_EXISTS`
rather than replacing an existing destination.

### Session artifact previews

A preview is a transcript event, not an assistant-message convention:

```json
{ "type": "preview", "path": "/absolute/path/to/artifact.pdf", "author": "alice", "createdAt": 1783673383396 }
```

`POST /sessions/:id/preview` resolves an absolute or session-relative `path`,
persists that event, and broadcasts it on the session stream. `Peon-Actor`
supplies its `author`. `GET /sessions/:id/file` returns
`{ path, size, mtimeMs, binary, truncated, content }`; text content is capped at
2 MiB and binary content is null. Use `/file/raw` for images, PDFs, unsupported
binaries, and downloads. An open preview watches `/file/stream`; `changed`
causes a `/file` refetch and `failed` carries `{ "error": "..." }`.

The transfer API above remains the upload/download transport. Uploading does
not emit a preview; callers explicitly POST `/sessions/:id/preview` once the
artifact is ready.

Overseer consumes only these normalized `preview` events; it does not infer
artifacts from assistant messages or textual directives. For an `.html` event,
Overseer mints a short-lived opaque grant and serves the HTML plus all paths
beneath its parent directory from `<token>.preview.overseer.rnm.dev`. Peon
addresses and credentials remain server-side. Non-HTML artifacts continue to
use the authenticated `/file` and `/file/raw` operator proxy.

## North-bound (peon → overseer): discovery

Implemented in `src/daemon/peonRegistrar.ts`. When `settings.overseerUrl` and
`settings.overseerToken` are both set, the peon POSTs to the **overseer**
(auth: the same shared `overseerToken` as its own bearer — symmetric secret):

```
POST {overseerUrl}/api/v1/peons/register
  { peonId, name, hostname, controlPort, protocol, capabilities, activeSessions, paused, uptimeSec }
POST {overseerUrl}/api/v1/peons/:peonId/heartbeat   (every heartbeatIntervalMs)
  { activeSessions, paused, uptimeSec }
```

- `peonId` is stable across restarts (auto-generated + persisted in settings on
  first use) so the overseer dedupes a peon across reconnects.
- The overseer learns how to reach back by combining the request's tailnet
  source address with the reported `controlPort` / `hostname`.
- A `404` on heartbeat means the overseer lost its registry (restarted) — the
  peon re-registers on the next tick. Connect failures are retried indefinitely
  (logged once, not per-tick).
- Registration/heartbeat is **discovery/liveness only** — it carries no session
  results. The overseer drives work by *calling back* into the south-bound API,
  and learns session state from the event push below.

## North-bound (peon → overseer): session events

Implemented in `src/daemon/peonEventPusher.ts`. So the overseer's aggregated
session index stays live without polling, the peon streams every session-summary
change (the same `SessionRecord` the south-bound `/sessions` returns):

```
POST {overseerUrl}/api/v1/peons/:peonId/events
  { peonId, epoch, events: [ { seq, session: <SessionRecord> }, ... ] }
```

Robustness — **push for liveness, reconcile for correctness:**

- `seq` is a **per-peon monotonic** counter; `epoch` is a **boot nonce** (new
  every process start).
- The overseer upserts each `session` (idempotent) and tracks `(epoch, seq)`. A
  `seq` **gap** (dropped/overflowed push) or an `epoch` **change** (peon
  restarted) makes it **pull `/sessions` to reconcile** — so a lossy or
  interrupted stream self-heals and never corrupts the index.
- The peon's outbound queue is bounded; on overflow it drops oldest (creating a
  gap the overseer heals) rather than growing without limit.
- Best-effort: a failed POST is retried; duplicates are harmless (idempotent
  upsert). The periodic overseer reconcile is the ultimate backstop.

## Enabling it on a peon

```
PATCH /api/settings {
  "overseerToken": "<shared secret>",         // inbound + outbound auth (empty => /agent surface off)
  "fileTransferRoot": "/path/to/sandbox",         // empty => file transfer off
  "overseerUrl": "http://overseer.ts.net:5000" // empty => this peon doesn't self-register
}
```

Leave `overseerToken` empty on a standalone peon and the entire `/agent`
surface stays off; leave `overseerUrl` empty and it never phones home.

## Recruitment (overseer-driven enrollment) — PEON-SIDE CHANGES NEEDED

> **Status:** implemented on the overseer; **not yet on the peon.** This section is
> the spec for the peon side. Until it lands, recruitment works in *manual* mode
> (an operator sets `overseerUrl` + the minted token by hand, per "Enabling it"
> above). The two changes below unlock *zero-touch* recruitment.

The overseer no longer uses one shared fleet secret. It mints a **per-peon,
workspace-scoped token** and the peon presents that as its `overseerToken`. From
the peon's side the register/heartbeat/events envelope is unchanged — it still
sends `Authorization: Bearer <overseerToken>`. Two additions:

### 1. `POST /api/v1/enroll` (new endpoint)

Lets the overseer point a peon at itself over the tailnet without an operator
touching the box. Auth: the peon's **current** `overseerToken` (the bootstrap
secret the agent surface is already gated on).

```
POST /api/v1/enroll
  Authorization: Bearer <current overseerToken>
  { "overseerUrl": "http://overseer.ts.net:5000", "overseerToken": "pn_…" }
  → 200 { "ok": true, "peonId": "<this peon's stable id>" }
```

Behavior:
- Persist `overseerUrl` and `overseerToken` atomically (same as `PATCH /api/settings`).
- Return `peonId` synchronously so the overseer can bind the peon before the first
  register arrives.
- Then trigger an **immediate re-register** with the new credentials (don't wait for
  the next registrar tick).
- **Idempotent** — re-enrolling overwrites, re-pointing a peon to a new
  overseer/workspace.
- Note the new `overseerToken` invalidates the bearer that authed *this* request;
  the overseer switches to the new token for all subsequent calls.

### 2. React to `401` on north-bound calls (de-recruit)

Today only `404` (overseer forgot me → re-register) is defined. When a credential
is **revoked**, register/heartbeat/events now return
`401 UNAUTHENTICATED`. On a `401`, treat the peon as **de-recruited**: stop phoning
home (or back off hard) and log once — do **not** hammer-retry. A later re-enroll
(new token) resumes normal operation.
