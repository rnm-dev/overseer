# Operator-scoped recent sessions

The Fleet list can carry, per Peon, the sessions the calling operator personally
touched — so Overseer Mobile renders "my recent chats" from one request instead
of one request per Peon. Implemented for OVSR-209.

## Request

```http
GET /api/workspaces/:wsId/peons?includeRecentSessions=mine&recentSessionsLimit=10
```

Without `includeRecentSessions=mine` the response shape and cost are exactly what
they were — no `recentSessions` key is added. `recentSessionsLimit` is clamped to
1–10 and defaults to 5; anything unparseable falls back to the default.

Each visible Peon then carries:

```json
{
  "peonId": "peon-1",
  "sessionId": "session-1",
  "status": "running",
  "title": "Implement recent chats",
  "promptPreview": "Implement the recent chats list",
  "preview": "Done — the list renders",
  "projectId": "project-1",
  "projectKey": "overseer-mobile",
  "startedAt": 1234567000,
  "lastActivityAt": 1234567890,
  "syncedAt": 1234567891,
  "lastRequestedAt": 1234567800,
  "hasOutstandingRequest": true,
  "attentionUnread": false,
  "attentionUpdatedAt": 1234567800
}
```

Session status stays canonical (`running | completed`); `needs_human` remains an
`outcome.result`, not a state.

The display fields are the whole point of the aggregate: a client names a row
`title → promptPreview → preview` without a second request per Peon. A row that
carried only identity and attention state left every session showing as
"Untitled session" (OVSR-214). `promptPreview` is trimmed to 200 characters,
exactly like the canonical session list, so the two agree character for
character.

`syncedAt` is the index's own version of the session row — the same value
`GET /workspaces/:wsId/sessions` and the `session` events carry — so a client
merging this projection into a cache keeps last-writer-wins ordering instead of
overwriting a richer live record. `attentionUpdatedAt` is the newest of this
operator's own `requested_at`, `completed_at`, `read_at` and `resolved_at`,
matching the workspace session list's field of the same name.

## Membership and ordering

A session is in the list when `session_attention` holds an occurrence for the
authenticated user — recorded when Overseer accepted a session creation, a
follow-up or a queued command. `sessions.author` is deliberately not used: it
misses a follow-up the operator sent into somebody else's session.

Ordering per Peon: `last_activity_at DESC NULLS LAST`, then
`started_at DESC NULLS LAST`, then `session_id ASC`. Already-read sessions stay
in the list; presentation is the client's decision.

The whole fleet costs one query. It is written without window functions on
purpose — the schema's SQL is kept to the portable subset both PostgreSQL and
the tests' `pg-mem` execute identically, so the per-Peon cut is applied to the
ordered result rather than with `ROW_NUMBER()`. Workspace membership, per-Peon
access and per-project member access are all applied inside that query.

## Request lifecycle vs read acknowledgement

`session_attention.state` answers "has the operator seen the answer". It cannot
also answer "has the run finished": opening a still-running session retires its
occurrence to `read` while execution is still in flight. Migration
`023_session_attention_lifecycle` therefore adds `resolved_at`, the lifecycle
half:

- `hasOutstandingRequest` ⇔ the operator has an occurrence with `resolved_at IS
  NULL`. Never inferred from `state = 'pending'` or from `sessions.status`.
- `attentionUnread` ⇔ the operator has an occurrence in state `unread`.
- `lastRequestedAt` — the newest `requested_at` from this operator.

A completed run consumes two independent FIFO queues over the same rows: the
oldest unresolved occurrence gets `resolved_at` (whoever requested it, read or
not), and — separately — the oldest still-pending occurrence becomes `unread`
unless its requester is watching that session. Keeping them apart is what makes
early reads, several requests in one session, queued commands and several
operators in one session all attribute correctly.

Existing rows were backfilled: every non-pending occurrence was resolved, so
history cannot show as permanently outstanding.

## Real-time

`kind: "attention"` events carry the same projection and are published after an
accepted create/follow-up, after the matching execution completes, and after a
read acknowledgement. The payload is `{ userId, peonId, sessionId, unread,
hasOutstandingRequest, lastRequestedAt, completedAt, updatedAt }`. `eventVisible`
scopes attention events to `payload.userId`, so one operator's state never
reaches another's socket.

Push notifications hang off the same events but now also require `completedAt`
to be set — acceptance and read-receipt events carry the session's standing
unread flag and must not buzz a phone. See [push notifications](push-notifications.md).

Session projections remain authoritative for title, status, preview, outcome and
activity ordering; attention events only add the operator-scoped part.
