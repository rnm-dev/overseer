# Automation API

The automation API lets a machine caller — CI, a cron job, a bot, another
agent — drive Overseer sessions on one Peon without holding an operator browser
session. It is a narrow, bearer-authenticated surface: list and search sessions,
start one, follow up, attach files, read status and transcript. Nothing else.

It is a *second front door onto the same control plane*, not a second control
plane. Every write ends up in the same `routes/peons/sessions.ts` path the web
client uses, with the same validation, idempotency, actor attribution and
response shapes, and travels to the Peon over authenticated Fleet HTTP exactly
as described in [sessions, turns and their control plane](sessions-and-turns.md).
What differs is only who is allowed to call and what they are allowed to touch.

## The token is scoped to one Peon, optionally to one project

An automation token is minted by a signed-in operator and carries:

- `workspaceId` and `peonId` — always, and immutable for the token's life;
- `projectId` (with `projectKey` kept for display) — optional. A project-scoped
  token can only see and create sessions in that project; a Peon-scoped token
  covers every project its owner may reach on that Peon;
- the owning `userId`, a `label`, an optional `expiresAt`, and `revokedAt`.

The token string is `ovsr_at_<id>.<secret>`: a public row id and a 32-byte
secret, stored as `sha256(secret)` only, compared with `timingSafeEqual` — the
same shape and handling as a device token (`modules/auth/authDevices.ts`). It is
shown once at creation and never again.

### Authorization is the intersection of scope and the owner's live ACL

A token never grants more than its owner has *right now*. Every request
re-resolves the owner's workspace membership, Peon access and project access and
intersects it with the token's scope. Removing someone's project grant, or their
membership, immediately narrows or kills every token they minted — without
anyone having to remember which tokens exist. A token whose owner lost access
answers `404 UNKNOWN_PEON`, the same refusal an unauthorized operator gets.

Actor attribution is the owner's canonical email, so a session started by
automation is authored, billed and displayed exactly like one that person
started by hand. The token id rides along in the audit trail so an automated run
is still distinguishable from a manual one.

### The two transports never mix

Automation tokens are accepted only on `/api/automation/v1/*`, and only as
`Authorization: Bearer`. A device token or a session cookie is refused there,
and an automation token is refused on every operator route. Cookies are never
read on this surface, so its writes need no CSRF origin check — and, equally,
nothing on it can be reached by a browser that merely carries a logged-in
Overseer cookie.

Tokens are minted and revoked through the operator API and the web settings UI.
The automation API deliberately cannot mint, list, or extend tokens: a leaked
token must not be able to grow itself a longer-lived sibling.

## Where an operator manages them

Project settings carries an **Automation tokens** card. Creating one asks for a
label and an expiry (30/90/365 days, or none) and shows the secret exactly
once — there is no route that can show it again, and no column that could.

The operator routes live under the project, beside its other settings:

- `GET|POST /api/workspaces/:wsId/peons/:id/projects/:key/automation-tokens`
- `DELETE /api/workspaces/:wsId/peons/:id/projects/:key/automation-tokens/:tokenId`

Anyone with access to the project may mint a token, because a token carries
only what its owner already has. A project administrator (and the workspace
owner) sees and may revoke every token aimed at the project — that is the list
they are responsible for; everyone else sees and revokes their own.

## Endpoints

Base path `/api/automation/v1`. Every response is JSON; every error carries the
existing `{ error, code }` shape.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/sessions` | list and search |
| `POST` | `/sessions` | start a session with a message |
| `GET` | `/sessions/:id` | status and metadata |
| `POST` | `/sessions/:id/followup` | send a follow-up |
| `GET` | `/sessions/:id/transcript` | paginated history |
| `POST` | `/uploads` | commit a file, returns the path an attachment uses |
| `GET` | `/whoami` | the token's scope, owner and expiry |
| `GET` | `/openapi.json` | the machine-readable schema, no token needed |

### The schema is public

`GET /api/automation/v1/openapi.json` serves an OpenAPI 3.1 document for the
whole surface, readable without a token: it describes shapes, never anything
about a particular Peon or project, and a client generator should not need a
credential to know what it is generating. It is built in
`routes/automationOpenApi.ts` and versioned with the server.

### List and search

`GET /sessions?q=&status=&limit=&cursor=`

Answers from Overseer's durable session projection — the same index
[session catalog synchronization](session-list-sync.md) maintains — not from a
live call to the Peon, so a listing stays fast and works while the Peon is
briefly offline. Results are filtered to the token's scope before paging.

`q` is a case-insensitive substring match over the session title and its prompt
preview. It extends the existing `listSessions` options rather than introducing
a second query path; `status`, `limit` and `cursor` already exist there.

Each row carries `sessionId`, `title`, `status`, `projectKey`, `projectId`,
`author`, `promptPreview`, `startedAt`, `endedAt`, `lastActivityAt`.

### Start a session

`POST /sessions` with `{ prompt, attachments?, agent?, model?, reasoningEffort?, dir? }`.
A project-scoped token needs no `projectKey` and may not override it; a
Peon-scoped token must name one it is allowed to use.

The response is the accepted session record — `{ id, status, ... }` — so the
caller has the session id on the first hop. Admission rules are unchanged,
including the `409 AGENT_UNAVAILABLE` refusal when the Peon's agent CLI is not
signed in.

`Idempotency-Key` is required. It is passed through as `Peon-Request-Id`, so a
retried create returns the same session instead of starting a second one.

### Follow-ups

`POST /sessions/:id/followup` with `{ prompt, attachments? }` and a required
`Idempotency-Key`. Semantics are the operator route's: the Peon queues it when a
turn is running, and `model`/`reasoningEffort` named here pin the conversation.

### Attachments

Two steps, deliberately: bytes first, then a message that references them.

1. `POST /uploads?name=<filename>` with the raw bytes, `Content-Type:
   application/octet-stream` and `Peon-Content-Sha256: <hex>`. An optional
   `folder=` groups several files for one message; without it each upload gets
   its own. The bytes land under the Peon's file transfer root and the response
   is the committed receipt: `{ path, size, sha256, transferId? }`.
2. Put that `path` into `attachments: [{ type: "image" | "file", path }]` on a
   create or follow-up.

This is the path the web composer already uses, so the containment rules in
`peonFileSandbox.ts` apply unchanged: a path outside the transfer root is
refused. Inline base64 in the message body is not supported — a large image
belongs in a streamed upload, not in a JSON field.

### Status

`GET /sessions/:id` returns `{ id, status, running, title, projectKey,
projectId, agent, model, reasoningEffort, outcome, terminalReason, startedAt,
endedAt, lastActivityAt }`.

`running` is a boolean convenience over `status` so a poller does not have to
know the status vocabulary. Like the operator detail route, this read is a
reconcile point: it republishes the Peon's authoritative record, so a row left
`running` by a Peon that died mid-turn heals rather than lying to a poller
forever. `terminalReason` carries the provider-neutral stop code described in
[sessions, turns and their control plane](sessions-and-turns.md#turn-budget).

Polling this endpoint is the supported way to wait for a turn to finish. There
is no automation websocket or SSE surface in this iteration.

## Limits

`lastUsedAt` is recorded (at most once an hour per token, since the question it
answers is "is anyone still using this?") so an idle token is visible in
settings, and an expiry is honoured on every verification.

Per-token request and turn quotas are **not implemented yet**. They must be
attributed to the token id rather than to the caller's IP — an automation caller
is usually one address doing many things, which is exactly what an IP bucket
handles badly — so this is new accounting rather than a reuse of the existing
per-user quotas. Until it lands, an automation token is bounded only by the
Peon's own turn budget and by revocation.

## Implementation notes

- Migration adds `automation_tokens` (id, workspace_id, peon_id, project_id,
  project_key, user_id, label, token_hash, created_at, last_used_at, expires_at,
  revoked_at) with a lookup index on `(user_id, revoked_at)`.
- A new `modules/automation` owns the token lifecycle, verification, and the
  scope-intersection policy; it calls `modules/access` rather than re-deriving
  ACL rules, and `modules/sessions` for the projection reads.
- `routes/automation.ts` is transport only. It resolves the token into the same
  `WorkspacePeonContext` shape the operator routes use, so the session handlers
  stay single-sourced instead of being duplicated per front door.
- `listSessions` gains an optional `q` and `projectId`; no second search path.
  A project-scoped token filters on `projectId` and skips the per-row access
  join, because its one project was already authorized; a Peon-scoped token
  keeps the join, since its reach follows the owner's individual grants.
- The conformance expectations of [reverse fleet security
  threat model](reverse-fleet-security.md) apply: the abuse cases for a leaked
  automation token (scope escalation, cross-Peon reach, token self-renewal) get
  executable refusal tests, not prose.
