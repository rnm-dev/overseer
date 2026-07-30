# Overseer ↔ Peon protocol (`/api/v1`)

> **Vendored snapshot.** The canonical copy is
> [`../peon/PROTOCOL.md`](../peon/PROTOCOL.md). Keep the wire contract identical
> apart from this note and the monorepo-relative links below.

The machine-facing API a **overseer** (fleet control plane) uses to drive many
peons. It shares the `/api/v1` namespace with the human dashboard surface but
has its own bearer auth, representations, and no human presence bookkeeping. Implemented in
`src/daemon/agentApi.ts`, mounted at `/api/v1` ahead of the human cookie
auth-gate in `controlServer.ts`.

The normative correlated command lifecycle and fleet-surface migration matrix are
defined in [`../peon/docs/reverse-command-protocol-v1.md`](../peon/docs/reverse-command-protocol-v1.md).
The frozen Peon-initiated enrollment and credential lifecycle is defined separately
in [`../peon/docs/peon-claim-protocol-v1.md`](../peon/docs/peon-claim-protocol-v1.md). It uses
outbound HTTPS short polling and does not inherit the tailnet reachability assumptions
of the legacy recruitment flow below. Its strict schema, lifecycle fixtures, and
executable cryptographic/security vectors live under `protocol/peon-claim-v1/`.
Remote daemon pause/resume is intentionally local-only and is not part of the
reverse command surface.

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

## Envelope

Every request:

| Header | Meaning |
|---|---|
| `Authorization: Bearer <token>` | shared secret = `settings.overseerToken`. Empty on the peon ⇒ whole namespace is off (`503 AGENT_API_DISABLED`). |
| `Peon-Protocol: 1` | optional; major-version check, `400 UNSUPPORTED_PROTOCOL` on mismatch. |
| `Peon-Actor: <username>` | optional; the human on whose behalf the command is issued. Trusted (the token is trusted) and forwarded into a session's `author`, so one shared token doesn't collapse every operator into one identity. |
| `Peon-Request-Id: <uuid>` | optional; correlation id, echoed back on the response. Doubles as the idempotency key for `POST /sessions`. |

Errors are always `{ "error": "<human message>", "code": "<STABLE_CODE>" }` —
**branch on `code`, never on the English string.** Codes: `AGENT_API_DISABLED`,
`UNAUTHENTICATED`, `UNSUPPORTED_PROTOCOL`, `BAD_REQUEST`, `BAD_CURSOR`, `UNKNOWN_SESSION`,
`SESSION_NOT_RUNNING`, `RESUME_IN_PROGRESS`, `DIR_MISSING`, `FILES_DISABLED`,
`PATH_ESCAPE`, `INVALID_PATH`, `NOT_FOUND`, `FORBIDDEN`, `IS_DIRECTORY`, `CHECKSUM_MISMATCH`,
`RANGE_NOT_SATISFIABLE`, `RATE_LIMITED`, `UNKNOWN_INTEGRATION`, `INTEGRATION_IN_USE`,
`INTEGRATION_NOT_AUTHENTICATED`, `INTEGRATION_UNAVAILABLE`,
`UNKNOWN_PROJECT`, `UNKNOWN_QUICK_LINK`, `PROJECT_EXISTS`, `UNKNOWN_ATTACHMENT_PATH`,
`ATTACHMENT_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `INTERNAL`. `FORBIDDEN`
indicates that an authenticated caller selected a host path the Peon process
cannot read, or a path a project-file policy intentionally excludes.

## Legacy recruitment (`/enroll`)

This is the mixed-version compatibility path. A `peon-claim-v1` attempt and this
legacy `/enroll` path are mutually exclusive under the downgrade and attempt-lock
rules in the normative claim contract.

How a legacy peon gets its `overseerToken` in the first place (zero-touch). The overseer
mints a per-peon, workspace-scoped credential (`pn_…`) and hands it over through
`/enroll`. That's chicken-and-egg — `/enroll` needs auth, but a never-recruited
peon holds no overseer credential yet — so a **one-time pairing phrase** bootstraps
it. Implemented in `src/daemon/pairing.ts` + `agentApi.ts`.

The pairing phrase is a short, human-carried, single-use, TTL'd bootstrap key.
Because a human carries it, it's a **memorable orcish phrase** (`lok-tar-ogar-dabu`),
not random hex. Flow:

1. A fresh peon (no `overseerToken`) arms a phrase at boot and prints it once (also
   re-armable with `peon pair` to re-point an already-recruited peon). Never logged
   again after generation.
2. The human running the peon reads the phrase + the peon's tailnet address to an
   operator, who enters both in the overseer's "Connect peon" form.
3. The overseer calls the peon:

```
POST {peonBaseUrl}/api/v1/enroll
  Authorization: Bearer <pairing phrase>     # e.g. "lok-tar-ogar-dabu"
  Peon-Protocol: 1
  { "overseerUrl": "http://overseer.<tailnet>.ts.net:5000", "overseerToken": "pn_xxxx" }
  → 200 { "ok": true, "peonId": "<stable id>", "publicUrl": "http://peon.example:4570" }
```

- **Auth is dual:** a valid *armed, unexpired* pairing phrase **or** the peon's
  *current* `overseerToken` (so an already-recruited overseer can re-point the peon).
  Unlike the rest of `/api/v1`, `/enroll` is reachable when `overseerToken` is
  still empty. Bad/expired/burned phrase ⇒ `401`.
- **Forgiving match:** the phrase is normalized (case, spaces/underscores → `-`) and
  compared in constant time, so `"Lok Tar  Ogar_Dabu"` matches `lok-tar-ogar-dabu`.
- **Single-use + TTL:** a successful enroll **burns** the phrase; it's valid ~15 min
  after arming regardless (`settings.pairingTtlMs`). `overseerToken`-authed enrolls
  aren't time-limited.
- **Rate-limited:** 5 rejected bearer credentials/min per source IP (`429
  RATE_LIMITED`) to blunt online guessing of the (lower-entropy, memorable)
  phrase. Authenticated requests with configuration errors do not consume this
  allowance or the phrase, so an operator can correct the form immediately.
- **`peonId` is returned synchronously** and equals the id the peon uses in the very
  next `register` — the overseer binds the credential to the peon from this response,
  before the first north-bound call arrives.
- **The address entered by the operator is authoritative.** A successful enroll
  must retain that exact normalized base URL. `publicUrl` is the peon's configured
  canonical callback address and may fill a missing value, but discovery must never
  replace an operator-entered domain with the registration request's source IP.
- **Validation happens before consumption.** Invalid/missing overseer URLs or tokens
  return an actionable `400 BAD_REQUEST` and leave the phrase usable. A rejected,
  expired, or already-used phrase returns an actionable `401 UNAUTHENTICATED`.
- **Idempotent:** re-enrolling overwrites `overseerUrl`/`overseerToken` (re-pointing).
  The new token invalidates the bearer that authed the request; the response is sent
  first, and every subsequent north/south call uses the new token. Enroll fires an
  immediate re-register (no waiting for the next heartbeat tick).
- **Overseer contract:** any non-2xx ⇒ the overseer revokes the minted credential
  and reports `ENROLL_FAILED`, including the safe upstream HTTP status, `code`,
  and `error` text in the operator UI. It must not collapse an actionable Peon
  response into a generic failure. A bad phrase must reject with a 4xx.

## Endpoints

### Control / sessions (reuses the same stores as the human `/api/v1/*` profile)

```
GET   /api/v1/status                     identity + live load (activeSessionCount, paused, agentAuth, …)
PATCH /api/v1/status                     change state; body { paused: boolean }
POST  /api/v1/control/check-update       run update check now; returns fresh update fields
GET   /api/v1/models                      AI providers/models/effort catalog with inline defaults
GET   /api/v1/quota                       live provider account quota; ?refresh=1 bypasses cache
GET   /api/v1/quota/:provider             independently fetch claude-code or codex quota
GET   /api/v1/capabilities                installed plugins, skills, and MCP metadata
GET   /api/v1/capabilities/:provider      independently fetch one provider's capabilities
GET   /api/v1/filesystem/<path>?stat=1    read-only host directory browser (directories only)
GET   /api/v1/armory/packages             available + installed Armory package inventory
GET   /api/v1/armory/packages/:id         one Armory package's catalog and local state
GET   /api/v1/armory/packages/:id/mcp     MCP capability, runtime state, endpoint, and live tool descriptions
GET   /api/v1/armory/packages/:id/configuration  safe field schema + configured-field metadata
POST  /api/v1/armory/packages/:id/install  start a durable catalog install
POST  /api/v1/armory/packages/:id/enable   enable and health-check package MCP
POST  /api/v1/armory/packages/:id/disable  hide and stop package MCP
DELETE /api/v1/armory/packages/:id         durable ordinary uninstall; preserves configuration
GET   /api/v1/armory/settings             registry and agent-install policy (no credentials)
GET   /api/v1/armory/operations/:id       safe asynchronous operation status
GET   /api/v1/stats                       usage/cost/outcome rollups; ?period=day|yesterday|week|month
GET   /api/v1/analytics                   flexible user/project/time session analytics
GET   /api/v1/projects/:key               project detail with docs/index.md and recursive docs tree
GET   /api/v1/projects/:key/docs          documentation index and recursive tree
GET   /api/v1/projects/:key/docs/<path>   one .md, .mdx, or .txt document beneath docs/
GET   /api/v1/projects/:key/quick-links   ordered Peon-owned project links
POST  /api/v1/projects/:key/quick-links   append; body { title, url }
PATCH /api/v1/projects/:key/quick-links/:id update title and/or URL
DELETE /api/v1/projects/:key/quick-links/:id delete one link
GET   /api/v1/sessions                   list all sessions; ?limit=&cursor= enables keyset pagination
GET   /api/v1/sessions/:id               one session
PATCH /api/v1/sessions/:id               rename; body { title: string|null } (empty/null clears)
DELETE /api/v1/sessions/:id              delete a session (record + files); 409 if running
GET   /api/v1/sessions/:id/transcript    full event transcript; `?limit=&cursor=` enables pagination
GET   /api/v1/sessions/:id/files         list a directory; ?path= relative to cwd or absolute
GET   /api/v1/sessions/:id/file          text/metadata view; ?path= required, first 2 MiB
GET   /api/v1/sessions/:id/file/raw      raw bytes for any regular file; ?path= required
GET   /api/v1/sessions/:id/file/stream   SSE watch selected file (`changed`, `failed`)
POST  /api/v1/sessions/:id/preview       persist/broadcast preview handoff; body { path }
POST  /api/v1/sessions                   start; body { prompt, dir?, projectKey?, expectsOutcome?, agent?, permissionMode?, model?, reasoningEffort?, attachments? }
POST  /api/v1/sessions/:id/followup      continue; body { prompt, permissionMode?, model?, reasoningEffort?, attachments? }
POST  /api/v1/sessions/:id/queue         enqueue; same fields plus startNow? (default false)
GET   /api/v1/sessions/:id/queue         persisted FIFO queue; response { items: QueuedFollowUp[] }
PATCH /api/v1/sessions/:id/queue/:itemId edit a waiting item's prompt; body { prompt }
POST  /api/v1/sessions/:id/queue/:itemId/send move one waiting item to the head and send it now
DELETE /api/v1/sessions/:id/queue/:itemId remove a waiting item
POST  /api/v1/sessions/:id/cancel        cancel the active run
POST  /api/v1/control/pause | /resume    toggle settings.paused
POST  /api/v1/control/update             self-update (git pull / reinstall + restart); body { force? }
GET   /api/v1/sessions/:id/stream        SSE tail (events: `event`, `change`) — see "Live tail" below
```

Project and session representations carry an immutable `projectId` alongside
the compatibility `key`/`projectKey` fields. Project keys remain mutable routing
slugs; renaming a key (including a case-only legacy rename) does not change
`projectId`. Session summaries persist the ID, so deleted-project history keeps
its original identity and recreating the same key produces a distinct project.
Ad-hoc sessions and legacy sessions whose deleted project cannot be resolved use
`projectId: null`.

Project quick links are persisted in the Peon project record and represented as
`{ id, title, url, order }`. IDs and insertion-order values remain stable across
updates and restarts; deletion does not renumber surviving links. Titles are
trimmed, bounded to 120 characters, and reject control characters. URLs are
absolute credential-free HTTP(S) URLs bounded to 2048 characters. A project may
hold at most 100 links, and the serialized collection is bounded to 32 KiB so one
project remains safe for catalog synchronization. Local agents receive the
loopback-only `/mcp/projects`
server with `list_project_quick_links`, `create_project_quick_link`,
`update_project_quick_link`, and `delete_project_quick_link` tools.

Root sessions also receive a signed, session-bound loopback `/mcp/sessions`
binding. Its `list_session_options`, `spawn_sessions`, `get_child_sessions`,
`wait_for_child_sessions`, bounded `get_child_transcript`, and unrestricted
`send_session_followup` tools allow a root to create and observe any number of
direct child sessions, selecting the project, agent, model, and reasoning effort
for each. Every child may also receive an optional short `name`, persisted as
its session title and returned by child status tools. Spawn request IDs are
parent-scoped idempotency keys, and the name participates in the idempotent
request comparison. Children
run as ordinary chat sessions with `expectsOutcome: false`, receive their
selected project's normal injected context, and do not inherit the parent
transcript. Their final response is persisted as assistant text and can be read
through `get_child_transcript`; completion polling remains status-based.

When a spawned child completes with no queued child follow-up remaining, Peon
adds a durable hidden system trigger to the parent. All triggers accumulated
during the current turn are coalesced and injected as system instructions into
the next queued user turn. If no user message is waiting, Peon starts one hidden
automation turn after the current turn. These triggers never interrupt the
running turn and are omitted from the visible queue, transcript user messages,
session API responses, and change streams. Each trigger identifies the child
and directs the parent to retrieve its result through `get_child_transcript`.
The initial spawned turn and every later turn initiated through
`send_session_followup` each enqueue exactly one automatic handoff when they
finish. A manually initiated child turn does not. Peon persists a per-turn
pending marker and the last delivered completion timestamp, so duplicate
completion events cannot create a feedback loop while distinct automated
follow-ups remain observable.

`get_child_transcript` reuses durable session-bound backward cursors. It defaults
to 10 events and 12,000 serialized characters, with hard maxima of 20 events and
30,000 characters. Oversized events are represented by typed truncated previews,
or metadata-only markers when needed to honor the total budget, and only a caller's
direct children are readable.

`send_session_followup` may target any existing session, including the caller,
a non-child, or a session in another project. It has no count cap. Model and
reasoning-effort overrides are validated against the target session's immutable
agent. A running target follows the normal steer-or-interrupt-and-resume behavior.
An optional request ID is retained as message correlation metadata; it is not an
idempotency key.

Delegation depth is hard-limited to one: spawned children do not receive the
session MCP binding, and the application service independently rejects a child
that attempts to spawn. Spawn batches and retained direct-child sets have no
count cap. See `docs/session-orchestration.md` for the full contract and threat
model.

Project documentation is filesystem-backed under `<project dir>/docs`; Peon does
not persist a parallel metadata document. `docs/index.md` is the entry point.
For project-linked sessions, its current contents are injected into the main
agent prompt on every run and follow-up. User requests to remember project
context are persisted under `docs/`; critical instructions and cross-task
processes belong directly in `docs/index.md`, while focused details belong in
focused documents.
Creating a project also attempts to start a linked documentation-onboarding
session. Its first turn inspects the repository read-only and asks 3–5 concise
questions; documentation is written only after the user's follow-up. The create
response includes `onboardingSessionId` (or `null` if the optional session could
not be started), and onboarding failure does not roll back the project.
Project detail and `GET /projects/:key/docs` return
`{ exists, indexPath: "index.md", index, tree }`, where `index` is the text page
view or null and `tree` recursively contains supported text files and directories.
Each file node carries `name`, docs-relative `path`, `size`, and `mtimeMs`.
`GET /projects/:key/docs/<path>` returns
`{ path, name, title, content, size, mtimeMs, truncated }`. Hidden entries,
unsupported extensions, and symlinks escaping `docs/` are never exposed.

`GET /api/v1/sessions` returns canonical lightweight session summaries. Full
session records are available only from `GET /api/v1/sessions/:id`, and
transcript events only from the transcript endpoint. A summary contains:

```jsonc
{
  "id": "<session id>",
  "status": "running|completed|null",
  "projectKey": "<mutable project key>|null",
  "projectId": "<stable project id>|null",
  "title": "<human title>|null",
  "promptPreview": "<whitespace-collapsed initial prompt, max 280 chars>|null",
  "lastMessagePreview": "<bounded latest message>|null",
  "initiator": "<username>|null",
  "outcome": "<session outcome>|null",
  "startedAt": 0,
  "endedAt": 0,
  "lastActivityAt": 0
}
```

`promptPreview` is null when the session has a title. Collection-facing free
text (including title, message previews, initiator, and outcome text/path) is
whitespace-normalized and capped at 280 characters. Fields not shown above are
detail-only and are not serialized into collection or pushed-event payloads.

The endpoint preserves the `{ sessions }` envelope when neither `limit` nor
`cursor` is present. Supplying either parameter enables pagination. `limit`
defaults to 50 and values above 200 are clamped to 200;
non-integer, zero, and negative values return `400 BAD_REQUEST`. A paginated
response is `{ sessions, nextCursor, hasMore }`, ordered by `lastActivityAt`
(falling back to `startedAt`, then zero) descending and session id descending
as the deterministic tie-breaker. Pass the opaque `nextCursor` unchanged on
the next request. Invalid, tampered, or daemon-restart-expired cursors return
`400 BAD_CURSOR`. `nextCursor` is null on the final page.

Overseer handoff: Peons advertising the `session-pagination-v1` registration
capability support this native contract. Overseer should retain its local-index
fallback for Peons that do not advertise the capability.

`GET /api/v1/sessions/:id/transcript` likewise preserves its legacy `{ events }`
response when neither `limit` nor `cursor` is present. Supplying either enables
pagination with the same parameter/envelope convention as the session index:
`{ events, nextCursor, hasMore }`. Pages run newest-to-oldest while retaining
chronological order within each page. Every paginated event carries `eventId`;
pass the opaque `nextCursor` unchanged as `cursor` to load the preceding page.
`limit` defaults to 50 and is clamped to 500. Invalid limits return `400
BAD_REQUEST`; malformed, cross-session, or unavailable cursors return `400
BAD_CURSOR`. Unlike session-index cursors, transcript cursors survive daemon
restart because their boundary is an immutable event identity persisted in the
JSONL row. Legacy rows receive deterministic identities from their physical row
and content; corrupt rows are skipped without renumbering later identities.
Transcript files are append-only—compaction is not currently supported.
Peons advertising `transcript-pagination-v1` in registration support this
contract; Overseer must retain the legacy full-response fallback otherwise.

### Live tail (`GET /sessions/:id/stream`)

Headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`) go out
and are flushed immediately — the client never waits on the first event, or
even on the replay below, to know the connection is live. Every `event` frame
carries an `id:` equal to the same immutable identity exposed as `eventId` in a
paginated snapshot:

```
event: event
id: 83a4e92f-b15c-4c8c-85f8-7f594596da02
data: {"type":"assistant", ...}

```

A fresh connection (no `Last-Event-ID`) replays the **full transcript** before
switching to live: the listener is registered *before* the transcript
snapshot is read, and both steps are synchronous with no `await` between
them — sessions.ts adds each event to its ordered append queue and in-memory
snapshot before emitting it, so nothing accepted in that window can land in
neither (a gap) or both (a duplicate). A client that reconnects sends `Last-Event-ID` automatically
(standard `EventSource` behavior); the peon resumes replay from that cursor,
so only what was missed arrives, once. `change` frames (session record
snapshots — status, turnCount, …) are live-only, not replayed; they don't
carry an `id:`, since a client already has current state from `GET
/sessions/:id`. A `: ping\n\n` comment heartbeat arrives at least every 15s
(`ACA_SSE_HEARTBEAT_MS` overrides the interval, used only by tests) so a
half-open connection through an idle-timing proxy gets noticed. All listeners
and the heartbeat timer are torn down the moment the request closes.

The dashboard's human-authenticated stream also accepts `afterEventId` as its
initial snapshot boundary because browser `EventSource` cannot set a custom
header on the first connection. Once connected, `Last-Event-ID` takes
precedence on automatic reconnects. Resume ids are bounded and validated before
SSE headers are sent.

Transcript and SSE `event` payloads use the same provider-neutral Peon event
contract: `user_message`, `assistant`, `user` (tool results), `system`,
`result`, `stderr`, or `preview`. Coding-agent adapters translate their native CLI JSON
before either persistence or broadcast, so switching between Claude Code and
Codex does not require consumers to understand two transcript formats. The
transcript endpoint and a live stream therefore render the same event sequence.

Every newly committed event carries `createdAt`, Peon's receive time as Unix
milliseconds. This is assigned once at the append boundary, so persisted JSONL,
transcript responses, and SSE broadcasts expose the identical value. Historical
rows written before this field was introduced may omit it. When a coding
agent's live JSON supplies a valid RFC 3339 `timestamp`, its adapter also
preserves that provider-authored value as `sourceTimestamp`; consumers should
use `createdAt` for ordering and display because Peon-authored and synthetic
events have no provider timestamp.

Transcript appends are queued asynchronously to keep agent output from blocking
the control API. Ordering is preserved and graceful shutdown flushes the queue;
an abrupt process or host failure can lose only the accepted-but-not-yet-flushed
tail. Deleting a session captures and drains any pending append before a final
unlink, so late I/O cannot resurrect its transcript.

A `preview` event is an explicit user-facing artifact handoff:

```json
{ "type": "preview", "path": "/absolute/path/to/artifact.pdf", "name": "artifact.pdf", "author": "alice", "createdAt": 1783672600000 }
```

`POST /sessions/:id/preview` validates that the path resolves to a regular file,
then persists this event in the transcript and broadcasts it through the session
SSE stream. Clients should display `name`; `path` is an internal fetch key and
must not be exposed in UI. Agent-authored `[Open preview](/absolute/path)` links, legacy preview directives,
and schema `previewPath` outcomes are normalized into this same event, so clients consume one contract and never
parse assistant text. Agent-authored handoffs are limited to directly renderable
artifacts (HTML, images, PDF, and Markdown/documents); source/config files remain
ordinary manually-openable links. Agents preview the existing primary file they edited rather
than creating a copy or redirect wrapper. Only standalone artifacts with no
natural destination go under the OS temp directory at
`peon-previews/<session-id>/`; deleting the session removes that directory. The
file routes follow the session cwd for relative paths
and also accept absolute/parent paths, matching what the coding agent can hand
off. `/file` returns UTF-8 text (or `content:null` for binary data) with size,
mtime, binary, and truncation metadata. `/file/raw` streams any regular file;
active formats such as HTML/SVG use a download-safe generic content type, while
raster images and PDF use safe inline MIME types.

`GET /models` advertises which models this peon can run a session on, for the
overseer's per-peon model picker:

```jsonc
{ "defaultAgent": "codex",
  "providers": [
    { "agent": "claude-code", "label": "Claude Code",
      "models": [ { "id": "claude-sonnet-5", "label": "Sonnet 5", "alias": "sonnet", "default": true }, … ],
      "reasoningEfforts": [ { "id": "high", "label": "High", "default": true }, … ] },
    { "agent": "codex", "label": "Codex",
      "models": [ { "id": "gpt-5.6-sol", "label": "5.6 Sol", "default": true }, … ],
      "reasoningEfforts": [ { "id": "medium", "label": "Medium", "default": true }, … ] } ] }
```

`defaultAgent` is the peon-wide backend used when session creation omits
`agent`; `providers` is the catalog the picker offers. Each `models` and
`reasoningEfforts` list has one record marked `"default": true`; the Claude
model marker reflects this peon's live `settings.ai.defaultModel`. **Model selection resolves per
turn**: an explicit `model` on the request wins, else the session's own default
(`SessionRecord.model`, chosen at create), else the configured model marked as
the catalog default, else the CLI's own
default. Validation is deliberately soft — a known alias (`opus`/`sonnet`/`haiku`)
**or any well-formed `claude-*` id** is accepted, so a freshly-released model isn't
blocked by a stale catalog; an unusable value is silently ignored on `/sessions`
and the run falls back to the default. The global default is set via `PATCH
/settings { "aiDefaultModel": "<id>" }` (strictly validated there — `400
BAD_REQUEST` on junk).

`GET /quota` returns live subscription allowances for the Codex and Claude Code
accounts authenticated on this peon. Provider entries contain `status`, `source`,
`updatedAt`, optional `accountEmail`, `windows[]`, optional `credits`, and a safe error when unavailable.
Shared session/weekly windows stay provider-level; scoped windows carry
`modelIds`. Each provider has its own 60-second cache and in-flight request, so
`GET /quota/claude-code` never waits for Codex and `GET /quota/codex` never waits
for Claude. Quota failures never block agent sessions.

Together, the overseer-facing AI data is available as:

- `GET /api/v1/quota` — connection status, signed-in account, limits, resets, and credits for all providers.
- `GET /api/v1/quota/:provider` — the same data for one independently fetched provider.
- `GET /api/v1/stats?period=...` — recorded usage/cost totals with the canonical provider id
  (`codex` or `claude-code`) in `agent` on every `byModel` row.
- `GET /api/v1/analytics?groupBy=user,project,time&timeBucket=day` — combinable session analytics dimensions, filters, explicit date ranges, prompt/turn counts, usage, duration, outcomes, cost, and attributed storage.
- `GET /api/v1/capabilities/:provider` — installed plugin, skill, and MCP names with enablement, version/origin, and transport metadata. Secrets and connection parameters are never returned.
- `GET /api/v1/armory/packages?q=&installed=&limit=&cursor=` — merged official-catalog and local installation state. Installed packages remain visible when the registry is offline; `registry` reports live, cached, or unavailable state.
- `POST /api/v1/armory/refresh` — explicitly revalidates the catalog and returns up to 100 merged package records with the same registry metadata. Failed live refreshes retain last-known-good cached data when available.
- `GET /api/v1/armory/packages/:id` — the same safe representation for one package, including its optional square `iconUrl`, requirements, versions, enablement/configuration state, and update availability. Configuration values are never returned.
- `GET /api/v1/armory/packages/:id/configuration` — package-declared field labels, types, choices, validation, host-write warnings, and boolean configured-field metadata. Values are never returned.
- `DELETE /api/v1/armory/packages/:id` — starts an asynchronous ordinary uninstall. The runtime is hidden and drained before files are removed, the pre-uninstall hook is not replayed blindly after interruption, and credentials, managed home, and ownership records are preserved. `purge: true` is rejected because ownership-safe purge is not part of this endpoint yet.
- `GET /api/v1/armory/settings` — configured/effective registry URL and the agent-install allowlist. The fleet profile is read-only; only the operator profile may change settings or submit/delete package configuration.

`GET /filesystem/<path>?stat=1` is a read-only host filesystem browser for
choosing directories outside project and file-transfer sandboxes. The path is
root-relative (`GET /filesystem?stat=1` and `/filesystem/?stat=1` address `/`),
and access is limited only by the Peon process's operating-system permissions.
Its response is `{ path: "/absolute/path", entries: [{ name, type:
"directory" }] }`: regular files and other non-directory entries are omitted,
and the endpoint never returns file metadata or content. Directory symlinks are
listed and may be traversed when their targets are accessible; broken, cyclic,
and file-targeting symlinks are omitted. A missing or non-directory
path is `404 NOT_FOUND`, an unreadable directory is `403 FORBIDDEN`, and an
invalid/cyclic path is `400 INVALID_PATH`. `?stat=1` is required. No upload,
download, or mutation method is registered for this resource.

`agent` selects the coding-agent backend for a new session: `"claude-code"`
(default) or `"codex"`. The choice is persisted on the session and its proxy
adapter is reused for every follow-up; a conversation cannot change providers
mid-session because the CLIs own incompatible conversation state. Codex model
slugs may be supplied explicitly, or omitted to use that CLI's default.
`reasoningEffort` resolves per turn in the same order (request, session default,
CLI default). Codex accepts `minimal`, `low`, `medium`, `high`, or `xhigh` via
its `model_reasoning_effort` config; Claude Code accepts `low`, `medium`, `high`,
`xhigh`, or `max` via `--effort`.

`GET /status`'s **`agentAuth`** reports whether this peon's Claude Code CLI can
actually run work — `{ authState: "ok"|"unauthenticated"|"broken"|"unknown",
available, checkedAt }`. A peon that's up but whose agent auth is `broken`/
`unauthenticated` will accept a session and then fail every run, so the overseer
routes work only to peons reporting `ok`.

The same response exposes the update check as `updateAvailable`,
`updateCurrentVersion`, `updateLatestVersion`, `updateCurrentRevision`,
`updateLatestRevision`, `updateCheckedAt`, and `updateCheckError`. Production
global installs populate the SemVer fields from the installed package and
Overseer's global release registry, with revision fields null. Source checkouts
populate `updateCurrentVersion` plus the two Git revision fields; latest version
is null because a remote commit need not be a published release. The overseer
uses `updateAvailable` for actions and chooses version fields for release installs,
falling back to short revision identifiers for development checkouts.

`POST /control/check-update` runs that check immediately and returns those same
seven fields. Concurrent requests share one in-flight check and all wait for its
result. A failed check still returns `200` with the failure in `updateCheckError`;
the daemon remains healthy. `GET /status` never starts a check and remains a fast,
cache-only read. The Overseer **Check now** action should call this endpoint and
replace its displayed update state with the response.

`GET /stats` returns session outcome counts plus token/cost/duration totals over
the period (`sessionCount`, `outcomeCounts`, `totalTokens`, `totalCostUsd`, …) —
the control plane's own cost & load view. `sessionsSizeBytes` reports the current
logical byte size of the complete persisted sessions store (including artifacts
outside the selected period and orphaned artifacts), making storage growth visible.
`400 BAD_REQUEST` on an unknown period.
It also carries a **`byModel`** array — a per-provider/model split of the same period
(`{ agent, model, sessionCount, totalTokens, totalCostUsd, … }`, cost-sorted), attributed
to the concrete model id the CLI reported for each turn. `agent` is the canonical public
provider id: both Codex runtime ids (`codex` and `codex-app-server`) are emitted and grouped
as `codex`, while Claude Code remains `claude-code`.

`GET /analytics` is the flexible counterpart and does not change `/stats`'s
stable response. It accepts either `period=day|yesterday|week|month|all` (default
`month`) or an explicit `from`/`to` ISO timestamp or epoch-millisecond range.
`groupBy` is a comma-separated combination of `user`, `project`, `time`,
`agent`, `status`, and `outcome`; when `time` is present, `timeBucket` may be
`hour`, `day` (default), `week`, or `month`. All time buckets are UTC and weeks
start Monday. Exact-match filters use repeated or comma-separated `user`,
`project`, `agent`, `status`, and `outcome` parameters; `project` matches either
the stable project id or current key, and `unknown` selects missing attribution.
Sessions are included by `startedAt`. Rows and `totals` expose session, prompt,
turn, token, provider-duration, wall-duration, outcome, reported-cost, usage
coverage, and current artifact-byte metrics. `storage.totalBytes` is the whole
session store and `storage.unattributedBytes` covers artifacts not matched to a
known session. Historical shared-session usage is attributed to the session
initiator because providers did not persist per-message usage; the response's
`attribution` object states this explicitly. Invalid combinations return `400
BAD_REQUEST`.

`POST /control/update` triggers this peon's self-update — the fleet-facing twin of
the dashboard's own update button (both call the same detached updater: `git pull`
+ tsx-watch reload on a source checkout, authenticated Overseer archive download,
size/SHA-256 verification, `npm install -g`, and restart on a systemd/global
install). The global updater packs its current installation before replacement
and uses that local archive for rollback if validation or restart fails. It refuses
with **`409 UPDATE_BLOCKED`** while a session is
running (the restart would kill it) unless `{ "force": true }`; on success it `202`s
and the peon restarts, so the overseer should expect a brief unreachability then
reconcile (changed current version/revision fields in `/status` confirm the new build).

**Idempotency:** `POST /sessions` uses the session id — supply it via
`Peon-Request-Id` (or body `id`), and a replay of an id we already have returns
the existing record with `200` instead of spawning a second run. A dropped
response is therefore safe to retry. (Attachments are resolved *after* the
idempotency check, so a replay never re-decodes an inline image.)

### Message attachments (files + images/vision)

`POST /sessions`, `POST /sessions/:id/followup`, and
`POST /sessions/:id/queue` accept an optional
`attachments` array — readable files and images the agent can *see*. It requires
a configured `fileTransferRoot` (else `503 FILES_DISABLED`); a plain-text message
never trips that.

```jsonc
{ "prompt": "review the failing test and the screenshot",
  "attachments": [
    { "type": "file",  "path": "uploads/<sid>/trace.log" },            // uploaded via PUT /files
    { "type": "image", "path": "uploads/<sid>/screenshot.png" },       // path under fileTransferRoot
    { "type": "image", "mediaType": "image/png", "dataBase64": "…" }   // inline, no pre-upload
  ] }
```

- `{ type, path }` — path **relative to `fileTransferRoot`** (same sandbox as
  `/files`); resolved + containment-checked identically. The peon hands the agent
  the resolved path.
- `{ type: "image", mediaType, dataBase64 }` — decoded and written into the
  sandbox (`.peon-inline/<uuid>.<ext>`) so the agent has a real path.
- **How images become vision:** the peon does *not* inline an image content block
  into the model turn — the Claude Code CLI has no supported path for that.
  Instead the augmented prompt instructs the agent to `Read` each attachment, and
  Claude Code's `Read` tool presents `png/jpeg/gif/webp` as **visual content the
  model sees** (the same mechanism the Claude Code IDE extensions use). Vision is
  real; it just arrives via a Read tool-call rather than the opening turn.

**Limits** (shared with the dashboard upload path): **≤ 10 attachments/message**,
**≤ 25 MB each**, image types **png/jpeg/gif/webp** (Claude Code auto-resizes
large images to the model's vision limits). Errors branch on `code`:
`503 FILES_DISABLED`, `400 PATH_ESCAPE`, `404 UNKNOWN_ATTACHMENT_PATH`,
`413 ATTACHMENT_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `400 BAD_REQUEST`.

### Projects & settings (operator views)

```
GET    /api/v1/projects                    list projects with per-project session rollups
GET    /api/v1/projects/suggest-dir        ?label= → { key, dir } the assigned path preview
POST   /api/v1/projects                    create a manual project; body { label, dir?, metadata? }
GET    /api/v1/projects/:key               full project detail (label, dir, metadata, integration binding, …)
GET    /api/v1/projects/:key/skills        valid project-scoped Codex skills from .agents/skills
GET    /api/v1/projects/:key/settings      editable settings; returns { projectId, key, name, dir, metadata }
PATCH  /api/v1/projects/:key/settings      partial edit; body { key?, name?, dir?, metadata? }
PUT    /api/v1/projects/:key/integration   bind to a visible integration project; body { integrationKey, integrationProjectKey }
DELETE /api/v1/projects/:key/integration   remove the integration-project binding
POST   /api/v1/projects/:key/archive       archive a project without deleting files or sessions
DELETE /api/v1/projects/:key/archive       restore an archived project
DELETE /api/v1/projects/:key               remove a project; 409 if a session is running against it
GET    /api/v1/projects/:key/files         list the project root; both "/files" and "/files/" address it
GET    /api/v1/projects/:key/files/<path>  list a subdirectory, or ?stat=1 for a file's metadata
GET    /api/v1/projects/:key/files/<path>?stat=1  metadata instead of a body: { path, entries } for a dir,
                                              { path, type:"file", size, mtimeMs, sha256 } for a file
PUT    /api/v1/projects/:key/files/<path>  atomically upload/replace a regular file in an existing directory
    Content-Type: application/octet-stream
    Peon-Content-Sha256: <hex>             optional integrity check
    → 201 { path, size, sha256 }
PATCH  /api/v1/projects/:key/files/<path>  atomically move a regular file within the same project
    Content-Type: application/json
    { "destination": "relative/path.txt" }
    → 200 { path, size }
DELETE /api/v1/projects/:key/files/<path>  delete a regular file (directories are never recursive)
    → 200 { path, size }
GET    /api/v1/integrations                connected integrations (no secrets) — the import picker
POST   /api/v1/integrations                connect Heroboard; body { apiKey, label?, apiUrl? }
POST   /api/v1/integrations/:key/login     verify/rotate apiKey
PATCH  /api/v1/integrations/:key           edit label/apiUrl (URL changes require apiKey)
DELETE /api/v1/integrations/:key           disconnect (409 while referenced by a project)
GET    /api/v1/integrations/:key/projects  catalog for linking, including linkedProjectKey
GET    /api/v1/settings                    the operator-editable subset of settings (no secrets)
PATCH  /api/v1/settings                    partial update of that subset
```

`GET /projects/:key` is the per-project **detail** card. `metadata`
is the sole durable project-context field and contains Markdown that an AI may
structure as needed. `scope` and
`integrationLabel` are integration-derived; `lastSyncedAt` is system-managed.
This is distinct from `GET /projects`, which is the session-rollup list.

`GET /projects/:key/skills` returns `{ "skills": [{ "name", "description",
"path", "scope": "project" }] }`, sorted by name and path. It reads valid
`SKILL.md` frontmatter from direct children of the project's `.agents/skills`
directory. Missing or malformed skills are omitted, a missing skills directory
returns an empty list, and symlinks that resolve outside the project are never
read. Unknown projects return `404 UNKNOWN_PROJECT`.

`GET /projects/:key/settings` exposes `{ "projectId": "<uuid>", "key": "app", "name": "App", "dir":
"/absolute/path", "metadata": null }`; `name` is the settings-facing name for the project detail's
existing `label`. `PATCH /projects/:key/settings` accepts any non-empty subset of
those four fields. An empty string or null clears metadata. A key must use the same lowercase slug form as manually created
project keys and must be unique. Renaming a key updates persisted session
references but leaves `integrationProjectKey` unchanged because that is the
remote integration's identity. `name` must be non-empty, and `dir` must be an
absolute path. A directory change re-points future sessions and creates the new
directory when absent; it does not move or delete the previous directory.

The project detail response has this shape (nullable fields are shown as null):

```json
{
  "projectId": "7d252d58-42dc-4ec6-8a75-d8da2f63992c",
  "key": "app",
  "label": "App",
  "scope": null,
  "dir": "/home/peon/Projects/app",
  "metadata": "## Conventions\n\nPush directly when asked.\n\n## Local setup\n\nRun `npm run dev`.",
  "integrationKey": null,
  "integrationProjectKey": null,
  "integrationLabel": null,
  "lastSyncedAt": 1783876929890
}
```

Whenever `POST /sessions` includes `projectKey` (and for Peon-created task
sessions), Peon injects the current persisted Markdown metadata into the agent's
system context on every start/resume. This metadata is
authoritative project context and replaces repository-local instruction/context
files such as `CLAUDE.md` or `AGENTS.md`; the repository remains implementation
material but cannot override the injected document. Consequently, an overseer can
change future-turn agent behavior by `PATCH`ing `metadata`
without editing files in the project checkout. Existing session transcripts are
not rewritten; the refreshed document applies on the next agent turn.

On first load after upgrading, Peon migrates legacy `info`, `setup`,
`publication`, `publicationStatus`, `publicationRoutes`, and `publicationError`
values into headed sections of the Markdown document, persists `metadata`, and
removes the old keys. Empty/default publication state is omitted.

**Project creation.** Two ways a project enters the store, mirroring the human
dashboard's two forms:

- `POST /projects` — a manual project. `key` is the slugified `label` (server-side);
  `409 PROJECT_EXISTS` on a collision. `dir` is optional — omit it and the peon
  assigns `~/Projects/<slug>` and `mkdir`s it; `GET /projects/suggest-dir?label=`
  previews that path for an operator who can't see the peon's filesystem. Returns
  the created project record (`201`).
The `dir` override accepts any absolute path — the overseer token is a full-admin
credential (see Envelope), so a caller can point a project anywhere on the box, same
as the human API. That credential may also connect, edit, re-authenticate, or remove
integrations. API keys are accepted only on writes and are never returned. Changing
`apiUrl` requires a key that verifies against the new host, so an existing secret is
never forwarded to an unverified destination.

`GET /projects` aggregates the project store with a fresh per-project session
rollup; a project a session references but the store doesn't know is still
listed. Empty ⇒ `{ "projects": [] }`, never `404`.

```
{ "projects": [ {
    "key": "webapp",                 // stable project id (the only required field)
    "path": "/home/peon/webapp",     // string|null — working dir, if known
    "sessionCount": 4,               // total sessions for this project
    "activeCount": 2,                // sessions currently status:"running"
    "lastActivityMs": 1783500000000  // number|null — epoch-ms of most recent activity
} ] }
```

**Project files** (`GET|PUT|PATCH|DELETE /projects/:key/files*`) are sandboxed to
the project's `dir` — the fleet-facing twin of the human dashboard's own
`/api/v1/projects/:key/files*`. Unlike `/sessions/:id/files*` above (which
follows a session's cwd with no containment check, since a coding agent may
legitimately work outside it), every path here is realpath-resolved and
checked for containment before any stat/read happens, so a `..`, an encoded
traversal (`%2e%2e`, `%2f`), an absolute-looking join, or a symlink pointing
outside the project root all return `400 PATH_ESCAPE` **before** anything
about the escaped target is disclosed. Without `?stat=1` the file body streams
with `Range:` support (206 + `Content-Range` + `Accept-Ranges`, exactly like
the file-transfer routes below); a directory without `?stat=1` is `400
IS_DIRECTORY` ("use ?stat=1 to list it"). `PUT` streams a raw
`application/octet-stream` body to a temporary file created relative to an
already validated open handle for the existing destination directory, computes
SHA-256, flushes it, and atomically renames it only after the optional
`Peon-Content-Sha256` matches. The writer, commit and cleanup retain that same
directory inode even if its pathname is swapped. It never creates parent
directories and uses the shared 100 MB per-file limit. Failed, oversized,
mismatched, and aborted uploads remove their temporary file. Existing regular files may be replaced;
directories, symlinks, and other non-regular destinations are rejected.
`PATCH` atomically renames one existing regular file to a relative destination
inside the same project. The destination parent must already exist, and an
existing destination returns `409 DESTINATION_EXISTS` without modifying either
file. Source and destination are independently canonicalized, so same-path,
cross-project, traversal, directory, and symlink moves are rejected. `DELETE`
removes one canonical regular file only; it never recursively removes a
directory. Mutation errors are stable JSON:
`404 UNKNOWN_PROJECT`, `404 PARENT_NOT_FOUND`, `400 PATH_ESCAPE`, `400
INVALID_PATH`, `403 FORBIDDEN`, `409 CHECKSUM_MISMATCH`, `409
DESTINATION_EXISTS`, `413 FILE_TOO_LARGE`, or `500 WRITE_FAILED`; a missing
move source or delete target is `404 NOT_FOUND`. Read errors remain `404
UNKNOWN_PROJECT`, `404 NOT_FOUND`, `400 PATH_ESCAPE`, and `400 IS_DIRECTORY`.

`GET /settings` returns **only** the safe subset — never the whole settings
object, never `overseerToken`/`pairingSecret`/bind host:

```
{ "name": "Marat",                   // string|null (empty ⇒ null)
  "paused": false,                   // boolean
  "defaultAgent": "codex",          // "claude-code" | "codex"
  "fileTransferRoot": "/srv/files",  // string|null (empty ⇒ null)
  "heartbeatIntervalMs": 5000,       // number
  "aiDefaultModel": "gpt-5.6-sol",  // string|null
  "soul": "Be candid and practical." } // string|null, Markdown
```

`PATCH /settings` is a **partial, allowlisted** update — body may carry any
subset of `name` / `defaultAgent` / `fileTransferRoot` / `heartbeatIntervalMs` /
`aiDefaultModel` / `soul` / `paused`; absent keys are
untouched and unknown keys ignored. It echoes the updated subset (the `GET`
shape). Validation (`400 BAD_REQUEST` on failure): `name` a non-empty string,
`defaultAgent` either `claude-code` or `codex`, `fileTransferRoot` a string
(empty ⇒ disables file transfer), `heartbeatIntervalMs` a number in
`1000`–`60000`, `aiDefaultModel` a valid model, `soul` a string (empty
clears it), and `paused` a boolean. Peon state
can also be changed with `PATCH /api/v1/status { "paused": true|false }`; the older
`POST /api/v1/control/pause | /resume` routes remain aliases. A `name` change shows up in the next
`register`/`status`; `fileTransferRoot` re-points the file sandbox on the next
file request; `heartbeatIntervalMs` takes effect on the next heartbeat tick.
`soul` is persisted under `ai.soul` and injected into every
future agent turn after Peon's fixed operational harness and before project
metadata. This includes follow-ups to existing sessions; persisted transcripts
are not rewritten. The GET/PATCH response normalizes an empty value to `null`.

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
- **Queued followups:** prefer `POST /sessions/:id/queue` while a session is
  running. Items are persisted on the session and dispatched FIFO, one after
  each completed turn. `{ "startNow": true }` still enqueues first, then stops
  the current turn and starts the queue head after the provider process exits.
  `PATCH /sessions/:id/queue/:itemId` replaces a waiting item's non-empty
  prompt without changing its position, attachments, attribution, model, or
  other dispatch metadata.
  `POST /sessions/:id/queue/:itemId/send` atomically moves that waiting item to
  the head, persists the reordered queue, and stops the current turn so the
  selected item runs next; all other items retain their relative order.
  Queue changes are included in the session SSE `change` frames. Use the
  explicit GET/PATCH/DELETE queue routes for reconciliation, editing, and
  removal.
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

File uploads use the shared 100 MB per-file limit.

The sha256 header + Range support are what make a future **resumable / chunked**
upload a pure extension rather than a protocol break.

## North-bound (peon → overseer): discovery

Implemented in `src/daemon/peonRegistrar.ts`. When `settings.overseerUrl` and
`settings.overseerToken` are both set, the peon POSTs to the **overseer**
(auth: the same shared `overseerToken` as its own bearer — symmetric secret):

```
POST {overseerUrl}/api/v1/peons/register
  { peonId, name, hostname, controlPort, publicUrl, protocol, capabilities, activeSessions, paused, uptimeSec }
POST {overseerUrl}/api/v1/peons/:peonId/heartbeat   (every heartbeatIntervalMs)
  { activeSessions, paused, uptimeSec }
```

- `peonId` is stable across restarts (auto-generated + persisted in settings on
  first use) so the overseer dedupes a peon across reconnects.
- `publicUrl` is the canonical, operator-configured callback address and may be a
  mesh DNS name or reverse-proxy URL. `hostname` / `controlPort` and the request's
  source IP are legacy discovery hints only. They may populate a missing address,
  but must not overwrite the URL retained during enrollment or a valid `publicUrl`.
- A `404` on heartbeat means the overseer lost its registry (restarted) — the
  peon re-registers on the next tick. Connect failures are retried indefinitely
  (logged once, not per-tick).
- A `401` on a north-bound call (register / heartbeat / events) marks the
  credential link degraded, but is not treated as definitive revocation. A
  recovering proxy or credential store can briefly answer from stale state, so
  the peon keeps probing with bounded exponential backoff and clears the degraded
  state after a successful response. Re-enrollment is only needed if rejection
  persists.
- Registration/heartbeat is **discovery/load metadata only** — it carries no session
  results. The overseer drives work by *calling back* into the south-bound API,
  and learns session state from the event push below.

## North-bound (peon → overseer): WebSocket presence

Implemented in `src/daemon/peonSocket.ts`. A configured peon maintains one
authenticated outbound connection per channel:

```
WS(S) {overseerUrl}/api/v1/peons/ws
WS(S) {overseerUrl}/api/v1/peons/transfer/ws
Authorization: Bearer <overseerToken>
Peon-Protocol: 1
```

After upgrade, Peon sends a versioned hello. Reverse-socket features are isolated
channels: each advertises a capability and contributes reconnect state under its
capability name. Overseer echoes the capabilities it accepts. An older Overseer
may omit both fields and receives presence-only behavior; capability channels
remain inactive.

```jsonc
// Peon -> Overseer
{
  "type": "hello",
  "protocol": 1,
  "peonId": "<stable Peon id>",
  "capabilities": ["session-catalog-v1", "project-catalog-v1", "transcript-sync-v1", "folder-listing-v1", "session-warning-v1", "reverse-command-v1", "durable-delivery-v1", "project-file-read-v1", "sandbox-file-read-v1"],
  "channels": {
    "session-catalog-v1": {
      "epoch": "<boot uuid>",
      "revision": 42,
      "earliestSeq": 10,
      "latestSeq": 42
    },
    "project-catalog-v1": {
      "epoch": "<persistent project catalog uuid>",
      "revision": 12,
      "earliestSeq": 8,
      "latestSeq": 12
    },
    "transcript-sync-v1": {
      "snapshotPageEvents": 100,
      "snapshotPageBytes": 786432,
      "snapshotEvents": 20000,
      "snapshotBytes": 16777216,
      "activeSnapshots": 4,
      "subscriptions": 64,
      "subscriptionTtlMs": 300000,
      "eventBytes": 196608
    },
    "folder-listing-v1": { "entryMetadata": "entry-metadata-v1" },
    "reverse-command-v1": {
      "protocol": 1,
      "operations": ["session.cancel", "project.archive", "project.unarchive", "update.check", "update.apply"]
    }
  },
  "delivery": {
    "epoch": "<durable outbox epoch>",
    "earliestCursor": "<opaque>|null",
    "latestCursor": "<opaque>|null",
    "acknowledgedCursor": "<opaque>|null",
    "pendingMessages": 3,
    "pendingBytes": 2048,
    "backpressured": false
  }
}

// Overseer -> Peon
{
  "type": "hello_ack",
  "protocol": 1,
  "capabilities": ["session-catalog-v1", "project-catalog-v1", "transcript-sync-v1", "folder-listing-v1", "session-warning-v1", "reverse-command-v1", "durable-delivery-v1"],
  "channels": {
    "session-catalog-v1": {
      "epoch": "<last accepted boot uuid>",
      "acknowledgedSeq": 40
    },
    "project-catalog-v1": {
      "epoch": "<last accepted project catalog uuid>",
      "acknowledgedSeq": 11
    },
    "folder-listing-v1": { "entryMetadata": "entry-metadata-v1" }
  },
  "delivery": {
    "epoch": "<durable outbox epoch>",
    "acknowledgedCursor": "<last committed opaque cursor>|null"
  }
}
```

The transfer connection identifies its channel and operations in its opening
frame:

```json
{ "type": "hello", "protocol": 1, "channel": "file-transfer", "peonId": "<stable Peon id>", "capabilities": ["project-file-read-v1", "sandbox-file-read-v1", "session-artifact-v1", "file-write-v1"] }
```

Each connection has an independent handshake, heartbeat, reconnect backoff, and
configuration-generation fence. The control connection owns capability channels
and the durable delivery outbox; the transfer connection is reserved for file
bytes. Endpoint plus channel identifies the role, so no extra connection ID is
required. Peon status reports the target, connected, and connecting connection
counts, making a 1/2 degraded state observable while the failed member reconnects.

A connection is not live until that acknowledgement arrives. Socket presence,
rather than HTTP heartbeat freshness, is authoritative for online/offline status.
Unknown post-handshake frame types are ignored for forward-compatible channel
rollout. Binary frames, oversized frames, and malformed opening frames terminate
the connection and enter normal reconnect recovery.

Control-socket JSON frames are limited to 1 MiB, with at most 4 MiB of aggregate
buffered output before backpressure closes the connection. The transfer socket's
byte-stream limits are independent.

### Project file reads (`project-file-read-v1`)

When the transfer socket negotiates this capability, Overseer may open a file by
immutable project ID and a strict path relative to that project's configured
root. Mutable project keys and absolute paths are never accepted on this
operation. Overseer supplies the authenticated actor for attribution; Peon's
enrolled bearer remains the authorization boundary and Peon remains
authoritative for project lookup, filesystem permissions, canonical containment,
symlinks, and file type.

```jsonc
// Overseer -> Peon
{
  "type": "file_open", "protocol": 1, "requestId": "<uuid>",
  "projectId": "<immutable uuid>", "relativePath": "dist/index.html",
  "actor": { "userId": "<stable user id>", "email": "operator@example.com" },
  "range": { "start": 0, "end": 1023 } // optional, inclusive single range
}

// Exactly one pre-body outcome from Peon
{ "type": "file_error", "requestId": "<uuid>", "status": 404, "code": "NOT_FOUND", "message": "file does not exist" }
{
  "type": "file_meta", "requestId": "<uuid>", "status": 200,
  "contentType": "application/octet-stream", "contentLength": 1234,
  "acceptRanges": "bytes", "etag": "optional", "lastModified": "optional"
}

// Status 206 additionally carries: "contentRange": "bytes 0-1023/4096"
// Overseer -> Peon flow control and cancellation
{ "type": "file_credit", "requestId": "<uuid>", "bytes": 262144 }
{ "type": "file_cancel", "requestId": "<uuid>", "reason": "TRANSFER_CANCELLED" }

// Peon -> Overseer after the advertised number of bytes
{ "type": "file_end", "requestId": "<uuid>" }
```

File bytes are binary WebSocket frames. Their 22-byte header is: byte 0 protocol
version `1`; byte 1 frame type `1` (file chunk); bytes 2–17 the request UUID as
16 network-order bytes; and bytes 18–21 an unsigned big-endian sequence starting
at zero. The remaining payload is at most 65,514 bytes, keeping the complete
frame within 64 KiB. Peon never sends more payload bytes than the cumulative
credit granted for that request, and keeps at most one bounded pending chunk
while the socket itself is backpressured. A transfer connection supports at most
32 concurrent reads and at most 1 MiB of outstanding credit per read.
Backpressure retries grow exponentially from 5 ms to 1 second, and a read with
no progress for 60 seconds expires so a stalled peer cannot retain every file
handle indefinitely.

The optional range is one inclusive `start`/`end` pair. An omitted `end` means
end-of-file; an end beyond EOF is clamped. A start at or beyond EOF returns
`RANGE_NOT_SATISFIABLE` with status 416. Cancellation and socket disconnect close
the file handle and release all request state. Peon revalidates canonical
containment and the opened file's device/inode after `open`, closing the race
where a directory is replaced by a symlink between path validation and opening.
Recently completed request IDs remain as bounded 30-second tombstones so the
credit Overseer grants after accepting the final chunk cannot tear down the
shared socket after `file_end`. File frames are ephemeral and never enter durable
delivery or the control socket.

Stable pre-body `file_error` codes across the read capabilities are
`BAD_PROTOCOL`, `DUPLICATE_REQUEST`, `TRANSFER_BUSY`, `INVALID_ACTOR`,
`INVALID_PROJECT_ID`, `INVALID_PROJECT_PATH`, `INVALID_SESSION_ID`,
`INVALID_PATH`, `INVALID_RANGE`, `UNKNOWN_PROJECT`, `UNKNOWN_SESSION`,
`FILES_DISABLED`, `PATH_ESCAPE`, `NOT_FOUND`, `FORBIDDEN`, `IS_DIRECTORY`,
`NOT_FILE`, `FILE_CHANGED`, `FILE_TOO_LARGE`, `RANGE_NOT_SATISFIABLE`, and
`INTERNAL`. Invalid request IDs, credit, binary framing, sequence, or traffic
sent before negotiation are connection-level protocol violations rather than
`file_error` refusals.

### Sandbox file reads (`sandbox-file-read-v1`)

This capability uses the same metadata, binary chunks, ranges, credit,
cancellation, limits and lifecycle as `project-file-read-v1`, but addresses a
file inside the configured `fileTransferRoot`:

```json
{
  "type": "file_open", "protocol": 1, "requestId": "<uuid>",
  "scope": "sandbox", "path": "/tmp/peon-files/uploads/session/file.png",
  "actor": { "userId": "<stable user id>", "email": "operator@example.com" }
}
```

`path` may be absolute or relative to `fileTransferRoot`. Peon resolves and
revalidates canonical containment itself; it returns `FILES_DISABLED` when no
root is configured, `PATH_ESCAPE` when the target leaves it, and `NOT_FOUND`
when the contained target does not exist. An absolute path is never trusted as
an authorization decision made by Overseer.

### Session artifact reads and base previews (`session-artifact-v1`)

Session attachments, generated artifacts, downloads and preview assets use the
same metadata-first response, binary chunks, byte credit, Range, cancellation,
idle lease, request tombstones and connection-generation fencing as
`project-file-read-v1`:

```json
{
  "type": "file_open", "protocol": 1, "requestId": "<uuid>",
  "scope": "session", "sessionId": "<stable session id>",
  "path": "dist/report.pdf",
  "actor": { "userId": "<stable user id>", "email": "operator@example.com" }
}
```

Peon resolves the authoritative session record and requires a regular file
beneath its working directory. A legacy preview event's absolute path is
accepted only as containment input and is never a new authorization decision.
Peon repeats containment and device/inode validation after opening, before
publishing `file_meta`. Unknown sessions, traversal, escaping symlinks and file
swaps therefore fail before any body byte is visible.

A single outgoing session artifact is limited to 1 GiB. Raw HTML, SVG,
JavaScript and every other active or unknown type is advertised as
`application/octet-stream`; only the allowlisted passive image formats and PDF
retain an inline MIME type on this path. The isolated preview origin may assign
asset MIME types separately when rendering an explicitly granted preview.

Overseer chooses this route exclusively after negotiation. Browser cancellation,
preview expiry, socket replacement and timeout release the handle
deterministically. Base HTML preview assets share this bounded path; advanced
revision leases and atomic multi-asset publication are separate capabilities.

The small metadata and baseline refresh operations stay on the transfer socket
but never carry file bodies in JSON:

```jsonc
{ "type": "artifact_request", "protocol": 1, "requestId": "<uuid>", "sessionId": "<id>", "operation": "view|list|preview", "path": "dist/report.pdf", "actor": { "userId": "<id>", "email": "operator@example.com" } }
{ "type": "artifact_result", "requestId": "<uuid>", "status": 200, "code": "OK", "message": null, "body": {} }
{ "type": "artifact_watch", "protocol": 1, "requestId": "<uuid>", "sessionId": "<id>", "path": "dist/report.pdf", "actor": { "userId": "<id>", "email": "operator@example.com" } }
{ "type": "artifact_watching", "requestId": "<uuid>", "path": "dist/report.pdf" }
{ "type": "artifact_changed", "requestId": "<uuid>", "path": "dist/report.pdf" }
{ "type": "artifact_cancel", "protocol": 1, "requestId": "<uuid>" }
```

At most 16 watches exist on one Peon transfer generation. They are debounced,
generation-owned and closed on browser cancellation, socket replacement,
watch failure or disconnect. Refresh notifications contain only the contained
session path; the browser refetches bytes through the credited reader.

### Attachment and project writes (`file-write-v1`)

The write capability shares the transfer connection, request correlation,
generation fencing, cancellation and bounded resource accounting of file reads.
It handles attachment/sandbox uploads, project uploads, and scoped project
renames; it never enters the control socket or durable outbox.

```jsonc
// Project upload: mutable keys never cross the wire.
{
  "type": "write_open", "protocol": 1, "requestId": "<uuid>",
  "operation": "upload", "scope": "project",
  "projectId": "<immutable uuid>", "relativePath": "dist/app.js",
  "contentLength": 1234, // optional for a chunked HTTP request
  "sha256": "<optional lowercase SHA-256>",
  "actor": { "userId": "<stable user id>", "email": "operator@example.com" }
}
// Attachment upload: path is relative to fileTransferRoot.
{
  "type": "write_open", "protocol": 1, "requestId": "<uuid>",
  "operation": "upload", "scope": "sandbox",
  "path": "uploads/<session>/<filename>",
  "contentLength": 1234, "sha256": "<optional lowercase SHA-256>",
  "actor": { "userId": "<stable user id>", "email": "operator@example.com" }
}

{ "type": "write_ready", "requestId": "<uuid>", "maxBytes": 26214400, "credit": 65514 }
{ "type": "write_credit", "requestId": "<uuid>", "bytes": 65514 }
{ "type": "write_end", "requestId": "<uuid>" }
{ "type": "write_cancel", "requestId": "<uuid>", "reason": "TRANSFER_CANCELLED" }
{ "type": "write_result", "requestId": "<uuid>", "status": 201, "path": "uploads/session/file", "size": 1234, "sha256": "<digest>" }
{ "type": "write_error", "requestId": "<uuid>", "status": 409, "code": "CHECKSUM_MISMATCH", "message": "safe detail" }
```

Upload bytes use the read frame's 22-byte header with frame type byte `2` and a
per-request sequence starting at zero. A frame remains at most 64 KiB and cannot
exceed credit Peon granted after the preceding chunk reached its temporary file.
Peon admits at most 16 writes across admitted, opening, active and move work.
Every admission is leased and fenced by socket generation plus a unique
incarnation. Cancellation or replacement cleans cancellable upload work and a
late open cannot become ready. A dispatched project move is not cancellable:
its capacity token and request-ID tombstone remain until the native operation
settles. Peon expires idle/opening work after 60 seconds, limits
attachment paths under `uploads/` to 25 MiB, and limits other
sandbox/project uploads to 100 MiB. Session validation still enforces at most
ten attachments per message.

Peon opens and validates the destination parent first, then creates the
exclusive temporary file relative to that anchored directory handle. The
streaming temp fd, commit and cleanup all retain the same directory inode;
none reopen the mutable parent pathname. Peon hashes while streaming, flushes
and closes the temporary file, verifies the optional checksum and declared
length, revalidates the canonical parent device/inode and destination type, and
only then atomically replaces the regular-file destination. Cancellation, limit
failure, checksum mismatch, disconnect and process error remove the temporary
file through that same anchor. Project and sandbox parents are independently
contained; traversals, absolute paths, escaping symlinks and parent swaps cannot
select another root. Platforms without the required fd-relative primitives
fail closed.

Project rename is the no-body form:

```json
{
  "type": "write_open", "protocol": 1, "requestId": "<uuid>",
  "operation": "move", "scope": "project",
  "projectId": "<immutable uuid>", "relativePath": "old/name.txt",
  "destination": "new/name.txt",
  "actor": { "userId": "<stable user id>", "email": "operator@example.com" }
}
```

Source and destination are contained in the same immutable project. The move
resolves, opens and device/inode-validates the immutable project root exactly
once. Source preflight, destination preflight and commit then resolve only
relative to that one root handle, and independently verify that their opened
parents remain descendants of its exact identity. The commit uses a native
atomic no-replace rename (`renameat2` on Linux or `renameatx_np` on macOS), so a
destination race returns `DESTINATION_EXISTS` without changing either
pre-existing file. The shared root handle, descendant checks and expected
source inode fence project-root, parent and source swaps; platforms without
the required contained/open-at or rename primitive fail closed. Terminal
results and refusals are retained in a bounded five-minute, 512-entry
process-local replay cache. Reopening the same request ID with equivalent
admission data replays the outcome; different data returns `REQUEST_ID_REUSE`.
An active duplicate returns `DUPLICATE_REQUEST`. Cancel, lease expiry,
disconnect, and socket-generation replacement suppress publication to the
stale caller but do not release a move's request ownership or discard its
authoritative terminal result. Until settlement, identical retries remain
duplicates and changed input remains request-ID reuse; afterward the result is
replayed from the bounded cache.

Stable `write_error` refusals include `BAD_PROTOCOL`, `BAD_REQUEST`,
`INVALID_ACTOR`, `INVALID_CHECKSUM`, `INVALID_LENGTH`, `INVALID_PATH`,
`INVALID_PROJECT_ID`, `UNKNOWN_PROJECT`, `FILES_DISABLED`, `PATH_ESCAPE`,
`NOT_FOUND`, `PARENT_NOT_FOUND`, `FORBIDDEN`, `FILE_TOO_LARGE`,
`CHECKSUM_MISMATCH`, `LENGTH_MISMATCH`, `DESTINATION_EXISTS`,
`SOURCE_CHANGED`, `TRANSFER_CLOSED`, `DUPLICATE_REQUEST`,
`REQUEST_ID_REUSE`, `TRANSFER_BUSY`, `TRANSFER_TIMEOUT`,
`UNSUPPORTED_PLATFORM`, and `WRITE_FAILED`.
Once Overseer selects this negotiated capability, socket errors are final for
that public request and never fall through to the legacy HTTP mutation.

Peon reconnects indefinitely after transient DNS, TCP, TLS, upgrade, handshake,
heartbeat, and close failures using exponential backoff with jitter (250 ms up
to 30 s). A connection must remain stable before the backoff resets, preventing
rapid connect/drop loops. Ping/pong lease checks detect half-open connections.
Credential or URL changes replace the current generation immediately; stale
callbacks are identity-fenced and cannot disturb the replacement. A 401 enters
the normal bounded reconnect backoff instead of permanently parking the
connector, allowing transient authentication-state failures to self-heal. An
independent maintenance watchdog repairs missed configuration
notifications or socket/retry lifecycle transitions, so one lost callback cannot
leave presence permanently disconnected. The bearer credential is never included
in status or logs.

### Durable delivery (`durable-delivery-v1`)

When negotiated, Peon persists durable outbound messages before they are
eligible for WebSocket transmission. The outbox epoch, message ID, and opaque
monotonic cursor survive Peon daemon restarts. A socket `send()` callback is only
transport progress and never removes a message.

```jsonc
// Peon -> Overseer; payload is the typed channel frame
{
  "type": "durable_message",
  "epoch": "<durable epoch>",
  "cursor": "<opaque ordered cursor>",
  "messageId": "<uuid>",
  "priority": "critical|control|normal|bulk",
  "capability": "session-catalog-v1",
  "payload": { "type": "session_catalog_event", "...": "..." }
}

// Overseer -> Peon, only after committing every effect through cursor
{ "type": "durable_ack", "epoch": "<durable epoch>", "cursor": "<cumulative cursor>" }
```

Unacknowledged messages replay in original cursor order after reconnect. Lost
acknowledgements therefore cause harmless duplicate delivery; Overseer dedupes by
`(peonId, epoch, cursor)` or `messageId` before committing the payload. A valid
cumulative acknowledgement atomically compacts every message through its cursor.
Stale duplicate acknowledgements are harmless; wrong epochs, malformed cursors,
and future cursors never delete data.

Feature-owned durable messages persist their required `capability`. Peon sends a
pending cursor only when that capability was accepted on the current connection.
An unsupported head cursor remains durable and explicitly blocks later cursors;
Peon never leaks the payload, silently drops it, or reorders around it. A later
reconnect can resume when the capability is accepted again.

The store uses a checksum-protected, fsynced append journal plus two atomic
checkpoint generations under Peon's state directory
(`overseer-socket-outbox.{journal,a.json,b.json}`, mode `0600`). Enqueue,
coalescing, acknowledgement, and negotiation append one small mutation before
changing accepted in-memory state. Periodic compaction file-fsyncs an atomic
checkpoint, then atomically replaces and directory-fsyncs the journal. Startup
chooses the newest valid checkpoint and replays its valid journal suffix; a torn
final mutation is ignored so acknowledgement crashes cause duplicate replay,
never deletion. Corrupt files are quarantined before beginning a visible new
epoch. Payloads and credentials are never logged.

The outbox is bound to a one-way hash of the configured Overseer destination,
credential, and Peon identity. Re-enrollment or re-pointing never forwards old
pending payloads to a different authority: pending generations are quarantined
for operator recovery and a new destination-bound epoch begins.

Retention defaults to 5,000 messages and 32 MiB of actual serialized message
data. Limits reject new non-coalescible messages with explicit `OUTBOX_FULL`
backpressure; they never evict an accepted durable cursor. Session summaries are
explicitly replaceable projections and may coalesce by session only before their
cursor is sent. Once sent, cursor bytes are immutable. The hello/status outbox
state exposes pending counts/bytes, limits, recovery, errors, and backpressure so
Overseer can request a fenced catalog snapshot when a replaceable projection
could not be retained.

The 1 MiB socket-frame limit is checked against the complete durable envelope
before persistence. An oversized message is rejected as `INVALID_MESSAGE`, so it
can never become an unsendable head cursor. Outbox acknowledgements are accepted
only on a connection that negotiated `durable-delivery-v1`.

Durable cursor order is never changed by priority. Critical/control ephemeral
frames (acknowledgements, cancellation, heartbeat) can bypass bulk replay on the
socket; durable messages themselves remain strictly ordered. If an acknowledgement
does not arrive, Peon retries unacknowledged cursors after 10 seconds.

### Transcript snapshots and live events (`transcript-sync-v1`)

This control-socket capability requires `durable-delivery-v1`. It publishes only
the canonical Peon JSONL transcript; provider state is never used to reconstruct
history. A transcript event becomes eligible for publication only after its
JSONL row has appended successfully.

Overseer starts a bounded, session-owned snapshot:

```jsonc
// subscribe:true atomically arms demand before the barrier is captured.
{ "type": "transcript_snapshot_request", "requestId": "uuid", "sessionId": "session-id", "limit": 50, "cursor": "optional", "subscribe": true }
{
  "type": "transcript_snapshot_page",
  "requestId": "uuid", "sessionId": "session-id",
  "epoch": "stable transcript epoch", "revision": 42, "barrierSeq": 42,
  "events": [{
    "sessionId": "session-id", "epoch": "stable transcript epoch",
    "revision": 42, "seq": 42, "eventId": "canonical event id",
    "createdAt": 1785400000000, "eventType": "result", "author": null,
    "usage": { "input_tokens": 10 }, "event": { "type": "result" },
    "artifactRefs": []
  }],
  "nextCursor": "opaque-or-null", "hasMore": false
}
```

Every page for one request freezes the same epoch, revision, barrier, event
identities and order. Cursors are opaque, request- and session-bound, and expire
with the snapshot after 30 seconds. In-flight requests reserve one of the four
snapshot slots before canonical I/O begins; cancellation, lease expiry, and
socket-generation replacement fence any late completion. Lease validity is
checked synchronously before every continuation page and after repository load;
the maintenance timer is cleanup, not the correctness boundary.
`transcript_snapshot_cancel` releases it. A missing,
cross-session, or expired cursor returns `CURSOR_UNAVAILABLE`/`BAD_CURSOR`; the
caller starts a fresh snapshot rather than asking Peon to infer history.

With `subscribe:true`, commits through `barrierSeq` are covered by the frozen
snapshot and commits after it are buffered or published in exact sequence as
durable payloads:

```jsonc
{
  "type": "durable_message", "capability": "transcript-sync-v1",
  "priority": "normal|control|critical",
  "payload": {
    "type": "transcript_live_event",
    "sessionId": "session-id", "epoch": "stable transcript epoch",
    "revision": 43, "seq": 43, "eventId": "canonical event id",
    "createdAt": 1785400000123, "eventType": "assistant",
    "author": null, "usage": null, "event": { "type": "assistant" },
    "artifactRefs": []
  }
}
```

`result` events and `transcript_deleted` use critical priority; warnings use
control priority. Priority never changes durable cursor order. Dedupe identity is
the transcript epoch, session, sequence and canonical event ID. Cumulative
`durable_ack` is the only live-event acknowledgement.

A reconnect may renew demand without a full snapshot using
`transcript_subscribe {requestId,sessionId,epoch,afterSeq}`. Peon replays at most
64 events / 4 MiB from canonical history, then answers
`transcript_subscribed`; a wrong epoch, future sequence or larger catch-up
returns `CURSOR_UNAVAILABLE`. `transcript_unsubscribe` releases demand.
Subscriptions expire after five minutes unless renewed, and a Peon process
restart intentionally forgets them; Overseer resubscribes or snapshots after
each new process or configuration authority.

Limits are 100 events and 768 KiB per page, 20,000 events / 16 MiB per snapshot,
four concurrent snapshots / 32 MiB aggregate staging, 64 subscriptions, and
192 KiB for the complete durable event envelope, including delivery metadata,
usage, author and artifact references. Canonical JSONL snapshot reads use fixed
buffers and stop at 64 MiB of source, 16 MiB per physical row, or 20,000 valid
events before a whole unbounded transcript can be materialized. Oversized
canonical events remain intact locally; the wire copy carries complete-envelope
original/retained byte counts plus the canonical session/event artifact
identity. Snapshot and event bodies, prompts, credentials and sensitive paths
are never written to routine logs or metrics.

If `transcript_deleted` cannot enter the durable outbox because it is full or
temporarily cannot persist, Peon retains the bounded subscription and snapshot
state and retries on durable acknowledgement, reconnect, and its maintenance
timer. State is released only after the deletion frame is durably admitted, so
a transient outbox failure cannot silently lose deletion convergence.

At most 64 unacknowledged transcript events are admitted per session and 1,024
across the channel. A noisy session that crosses its bound loses only its own
demand and receives `RESYNC_REQUIRED`; other sessions and critical control
frames remain serviceable. Stable errors include `BAD_REQUEST`, `BAD_CURSOR`,
`UNKNOWN_SESSION`, `TRANSCRIPT_UNAVAILABLE`, `CURSOR_UNAVAILABLE`,
`SNAPSHOT_LIMIT`, `SUBSCRIPTION_LIMIT`, `SNAPSHOT_TOO_LARGE`,
`RESYNC_REQUIRED`, and `INTERNAL`.

### Reverse commands (`reverse-command-v1`)

Peon advertises this capability only on the control socket alongside
`durable-delivery-v1`. Its complete envelope, hashing, lifecycle, status
reconciliation, retention, and `session.cancel` result contract are normative in
[`../peon/docs/reverse-command-protocol-v1.md`](../peon/docs/reverse-command-protocol-v1.md).

The Peon dispatcher rejects command traffic before exact capability negotiation,
strictly validates the 60 KiB command frame and authenticated Peon target, and
fsyncs admission before sending `command_accepted`. A checksum-protected,
dual-generation ledger under Peon's state directory retains the canonical
request hash, complete validated work item, actor/target fence, lifecycle, and
terminal result. Same-ID/same-body delivery replays the stored lifecycle;
same-ID/different-body returns `COMMAND_ID_REUSED` without an effect.

An accepted record is resumed after restart. A record already marked `running`
is never executed again after a crash; Peon records a safe terminal `INTERNAL`
outcome and relies on operation-specific state reconciliation rather than risk a
second effect. Terminal results enter the ordinary durable outbox with critical
priority and capability fencing. The ledger marks results acknowledged from the
cumulative durable cursor and compacts them only after acknowledgement plus the
minimum seven-day retention, retaining command-ID/hash tombstones for another
seven days.

Update commands reuse that lifecycle. Overseer admits at most one active
`update.*` command per Peon, selects reverse command or legacy HTTP exclusively,
and leaves an accepted apply pending through the expected disconnect. The
launching process never attests a pre-restart receipt; only the replacement
daemon may complete `update.apply` after comparing its running
version/revision/SHA-256 with the persisted expectation. Overseer binds those
three immutable release fields into the canonical command before admission;
the Peon returns `RELEASE_CHANGED` if its pre-download metadata differs.
Source-checkout applies are rejected because
changing files without proving process replacement cannot satisfy attestation.
Update results use strict operation-specific status/code/detail tuples; arbitrary
detail and contradictory tuples are protocol errors.

### Session catalog channel (`session-catalog-v1`)

When negotiated, this channel is the sole authority for the Overseer session
index. It requires `durable-delivery-v1`; accepting the catalog capability
without durable delivery is a protocol error and Peon disconnects. If either
capability is absent from `hello_ack`, remote session-index synchronization is
inactive. Peon does not fall back to HTTP event pushes or run a second sync
authority.

The hello state lets Overseer resume without a snapshot when its stored epoch and
acknowledged sequence remain available. After capability negotiation, Peon puts
retained events newer than `acknowledgedSeq` through durable delivery. Dedupe keys
make this safe when an event was already persisted during a transient disconnect.
An invalid, future, or evicted sequence produces
`{ "type": "session_catalog_error", "code": "CURSOR_UNAVAILABLE", "epoch": "..." }`;
Overseer then requests a snapshot.

Snapshot request and response frames are correlated by a bounded `requestId`:

```jsonc
// first page; limit defaults to 50 and is clamped to 200
{ "type": "session_catalog_snapshot_request", "requestId": "...", "limit": 100 }

// subsequent page; cursor is opaque and scoped to requestId
{ "type": "session_catalog_snapshot_request", "requestId": "...", "limit": 100, "cursor": "..." }

// Peon response
{
  "type": "session_catalog_snapshot_page",
  "requestId": "...",
  "epoch": "<boot uuid>",
  "revision": 42,
  "barrierSeq": 42,
  "sessions": ["<canonical SessionSummary>"] ,
  "nextCursor": "<opaque>|null",
  "hasMore": true
}

// release a partial snapshot early
{ "type": "session_catalog_snapshot_cancel", "requestId": "..." }
{ "type": "session_catalog_snapshot_cancelled", "requestId": "..." }
```

The first request freezes one in-memory summary snapshot and captures its
`revision` and `barrierSeq` in the same synchronous turn. Every page carries the
same fence. Overseer stages pages, replaces/deletes rows only after the final
page, then applies `session_catalog_event` frames with `seq > barrierSeq`. Thus a
change concurrent with pagination cannot be overwritten by stale snapshot data.
Only one snapshot may be active per Peon; another request receives
`SYNC_IN_PROGRESS`. Snapshots expire after 30 seconds, pages are count- and
byte-bounded, cursors are opaque, and cancellation releases memory. Snapshot
staging is capped at 20,000 summaries or 16 MiB; exceeding either bound returns
`SNAPSHOT_TOO_LARGE` without sending an incomplete snapshot.

Committed changes are ordered and idempotent:

```jsonc
{ "type": "session_catalog_event", "epoch": "...", "seq": 43, "revision": 43, "session": "<SessionSummary>" }
{ "type": "session_catalog_event", "epoch": "...", "seq": 44, "revision": 44, "deletedSessionId": "..." }
{ "type": "session_catalog_ack", "epoch": "...", "acknowledgedSeq": 44 }
```

Overseer acknowledges only events committed to its local projection. Peon drops
acknowledged journal entries; invalid epochs and future cursors receive
`BAD_CURSOR`. Peon otherwise retains the newest 1,000 catalog events. Socket output frames are limited to
1 MiB and aggregate buffered output to 4 MiB; exceeding either bound closes
the connection so reconnect negotiation can resume or snapshot safely instead of
growing memory without bound.

### Project catalog channel (`project-catalog-v1`)

Peon advertises this channel only when the control socket also owns
`durable-delivery-v1`. Overseer must accept both capabilities. The project
channel has an independent persistent epoch, revision, and sequence cursor; its
acknowledgements do not acknowledge or compact the global durable-delivery
cursor, and global `durable_ack` does not compact project history.

Snapshot exchange uses the same bounded paging and barrier rules as the session
catalog, with project-specific frame names:

```jsonc
{ "type": "project_catalog_snapshot_request", "requestId": "...", "limit": 100 }
{ "type": "project_catalog_snapshot_request", "requestId": "...", "limit": 100, "cursor": "..." }
{
  "type": "project_catalog_snapshot_page",
  "requestId": "...",
  "epoch": "<persistent project catalog uuid>",
  "revision": 12,
  "barrierSeq": 12,
  "projects": [
    { "projectId": "<immutable uuid>", "key": "mutable-key", "label": "Display name", "dir": "/safe/local/path" }
  ],
  "nextCursor": "<opaque>|null",
  "hasMore": false
}
{ "type": "project_catalog_snapshot_cancel", "requestId": "..." }
{ "type": "project_catalog_snapshot_cancelled", "requestId": "..." }
```

Every page in one request carries the same epoch, revision, and `barrierSeq`.
Limits default to 50 and clamp to 200; each page is bounded to 48 KiB, one
snapshot to 20,000 projects or 16 MiB, and its lease to 30 seconds. Only one
snapshot is active. Invalid cursors, competing snapshots, and oversized
snapshots use the project catalog error frame with `BAD_CURSOR`,
`SYNC_IN_PROGRESS`, or `SNAPSHOT_TOO_LARGE` respectively.

Project mutations publish ordered, durable upserts or stable-ID tombstones:

```jsonc
{ "type": "project_catalog_event", "epoch": "...", "seq": 13, "revision": 13, "project": { "projectId": "...", "key": "renamed", "label": "Renamed", "dir": "/path", "quickLinks": [{ "id": "...", "title": "Docs", "url": "https://example.com/docs", "order": 0 }] } }
{ "type": "project_catalog_event", "epoch": "...", "seq": 14, "revision": 14, "deletedProjectId": "..." }
{ "type": "project_catalog_ack", "epoch": "...", "acknowledgedSeq": 14 }
```

`projectId` is immutable; renaming `key` is an upsert of the same identity, and
deleting then recreating a key allocates a new identity. The wire payload is an
explicit allowlist (`projectId`, `key`, `label`, `dir`). It excludes docs and
file contents, directory trees, skills, secrets, timestamps, and session-derived
rollups.

The project record and its unacknowledged catalog event are written together in
one atomic, fsynced `projects.json` replacement before local mutation events are
emitted. After capability negotiation the channel drains that persisted journal
into the shared durable outbox without coalescing, preserving global order with
interleaved session, warning, and configuration messages. A crash before outbox
enqueue therefore replays the project journal after restart; a lost channel or
delivery acknowledgement causes idempotent duplicate delivery, never a lost
mutation. The journal accepts at most 5,000 unacknowledged mutations and rejects
another project mutation rather than evicting history. Invalid/future project
acknowledgements return `BAD_CURSOR`; an unavailable resume point returns
`CURSOR_UNAVAILABLE` and requires a fresh snapshot.

When an older Overseer does not negotiate `project-catalog-v1`, this channel is
inactive and the existing authenticated HTTP project APIs remain unchanged.

### Folder listing (`folder-listing-v1`)

This ephemeral control-socket channel lists one directory's immediate children.
It never enters durable delivery and does not recursively walk the tree.

```jsonc
// Absolute path, or omit path and select a project directory by immutable ID.
{ "type": "folder_list_request", "requestId": "...", "path": "/absolute/path", "projectId": "optional", "limit": 200 }
{ "type": "folder_list_request", "requestId": "...", "projectId": "<uuid>", "relativePath": "src/lib", "limit": 200 }
{ "type": "folder_list_request", "requestId": "...", "cursor": "<opaque>", "limit": 200 }
{
  "type": "folder_list_page",
  "requestId": "...",
  "path": "/resolved/absolute/path",
  "projectId": "<uuid>|null",
  "entries": [
    { "name": "src", "type": "directory", "size": null, "mtimeMs": 1785400000000 },
    { "name": "package.json", "type": "file", "size": 1832, "mtimeMs": 1785400000123 },
    { "name": "outside-link", "type": "other", "size": null, "mtimeMs": null }
  ],
  "nextCursor": "<opaque>|null",
  "hasMore": false
}
{ "type": "folder_list_cancel", "requestId": "..." }
{ "type": "folder_list_cancelled", "requestId": "..." }
{ "type": "folder_list_error", "requestId": "...|null", "code": "BAD_REQUEST", "error": "..." }
```

An absolute `path` is authoritative even when `projectId` is also present and
produces `projectId: null`; it cannot be combined with `relativePath`. With no
path, Peon resolves the immutable project ID and lists its configured root or
the supplied project-relative child. Project-relative selector traversal that
resolves outside the project is rejected with `PATH_ESCAPE`. The selected
directory and project root are anchored by open handles. Enumeration and child
opens use Linux `/proc/self/fd/<fd>` handle-relative paths, never the mutable
selected pathname. A platform without the required `O_DIRECTORY`,
`O_NOFOLLOW`, and traversable handle path fails closed with
`UNSUPPORTED_PLATFORM`; it does not use pathname enumeration. Requests with
neither selector are rejected. Absolute browsing is limited by the Peon
process's OS permissions, not by project or transfer roots. Hidden entries are
included. A symlink whose opened target remains inside the anchored project
root is reported as its target `directory`/`file` with metadata. Escaping,
broken/cyclic, inaccessible, changed, and special entries are returned as
inert `other` rows with null metadata.
Directories sort before files, then `other`, then by name. A file carries its
byte `size`; directories carry `size: null`; both carry target `mtimeMs`.

Entry metadata is an additive, explicitly negotiated extension of
`folder-listing-v1`. Peon advertises
`channels.folder-listing-v1.entryMetadata: "entry-metadata-v1"` and includes
`size`/`mtimeMs` and inert `other` rows only when Overseer echoes that value in
`hello_ack`. A new Peon therefore omits `other` and keeps sending legacy
`{ name, type }` entries to an older Overseer, while a new Overseer accepts
legacy entries from an older Peon.

`limit` defaults to 200 and clamps to 500. A first request freezes the sorted
listing for cursor-stable pages. Only one listing is active per control
connection; it expires after 30 seconds and is released on completion,
cancellation, or disconnect. Metadata traversal runs in batches of at most 64.
Cancellation aborts further batches, waits with all-settled semantics for every
sibling in the current batch, then sends `folder_list_cancelled` and releases
the slot, so a restarted listing cannot overlap the cancelled scan. One
snapshot is limited to 20,000 entries and 16 MiB, and each complete page to 900
KiB. Stable errors include `BAD_REQUEST`,
`BAD_CURSOR`, `SYNC_IN_PROGRESS`, `UNKNOWN_PROJECT`, `NOT_FOUND`,
`NOT_DIRECTORY`, `FORBIDDEN`, `INVALID_PATH`, `PATH_ESCAPE`,
`UNSUPPORTED_PLATFORM`, `LISTING_TOO_LARGE`, and `INTERNAL`.

### Session warnings (`session-warning-v1`)

When negotiated, Peon publishes small durable warnings through the socket
outbox. The warning is also a first-class local transcript event, so the Peon
dashboard remains authoritative when an older Overseer does not accept this
capability. Context and transport pressure use separate codes and units:

```jsonc
{
  "type": "session_warning",
  "sessionId": "23a0ff18-0bff-455a-8496-e9f24ee6802b",
  "code": "payload_near_limit",
  "source": "command_output",
  "currentBytes": 3670016,
  "limitBytes": 4194304,
  "message": "Command output is approaching the 4 MiB transport limit."
}

{
  "type": "session_warning",
  "sessionId": "23a0ff18-0bff-455a-8496-e9f24ee6802b",
  "code": "context_near_limit",
  "source": "model_context",
  "currentTokens": 180000,
  "limitTokens": 200000,
  "action": "compact",
  "message": "Session context is approaching the model limit. Run compact after the active task finishes."
}
```

`payload_near_limit` is emitted at 70% of the serialized transport limit.
Generated command/tool output reaching 85% is shortened to a safe target no
higher than 70%; the full UTF-8 output is atomically retained under the session
artifact directory. The resulting `payload_truncated` frame carries
`currentBytes`, `retainedBytes`, `limitBytes`, and, when persistence succeeded,
`logPath`. Peon never silently truncates user prompts or control requests.

`context_near_limit` uses provider-reported tokens and model context window, not
transcript bytes or lifetime token totals. Peon recommends compacting but never
starts compaction while a task is active. Repeated near-limit warnings are
throttled per session/code/source; truncation notices are retained individually
because each can reference a different full-output artifact.

## Enabling it on a peon

```
PATCH /api/v1/settings {
  "overseerToken": "<shared secret>",         // inbound + outbound auth (empty => fleet profile off)
  "fileTransferRoot": "/path/to/sandbox",         // empty => file transfer off
  "overseerUrl": "http://overseer.ts.net:5000" // empty => this peon doesn't self-register
}
```

Leave `overseerToken` empty on a standalone peon and bearer-authenticated fleet
requests stay off; leave `overseerUrl` empty and it never phones home.
