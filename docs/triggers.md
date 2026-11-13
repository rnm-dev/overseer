# Trigger sources and stints

Status: built (OVSR-614), design in OVSR-612. The Telegram sidecar is not built.

An external system — a helpdesk, a chat bot, a CRM — hands work to Peon by
posting each **event** of one **source** (a chat, a ticket thread) to the
automation API as it happens. Overseer buffers them and delivers a **stint**
once the source has been quiet for a while: the first stint starts a
trigger-origin session, every later one is a follow-up into the same session.
The agent therefore keeps the conversation's memory and sees its own open
[sign-offs](signoffs.md), so it revises or withdraws instead of proposing again.

The caller stays dumb — it never batches, debounces or remembers sessions —
and Peon is unchanged except for one prompt rule. All of it lives in Overseer,
because the buffer and the timer must survive restarts and an offline Peon.

## API

Both routes are on the [automation API](automation-api.md) and need a
project-scoped key (a Peon-scoped key is refused: a source must belong to one
project).

- `POST /api/automation/v1/sources/{sourceId}/events` with
  `{ externalId, text, author?, at?, quietMs?, maxMs? }` → `202` with the
  source's status plus `duplicate` and `eventId`.
  - `sourceId` is the caller's key, 1–200 characters of letters, digits and
    `._:@/-`, unique within the project (`telegram:-1009900001`).
  - `externalId` is the caller's id for the event; a repeat is a no-op
    (`duplicate: true`), so retries are safe.
  - `at` is when it happened (ms); it orders the stint. Defaults to receipt.
  - `quietMs` (default 12 min) and `maxMs` (default 1 h, never below
    `quietMs`, both at most 24 h). The latest event's values apply.
- `GET /api/automation/v1/sources/{sourceId}` → `{ state: idle|buffering,
  pendingEvents, deadlineAt, quietMs, maxMs, sessionId, lastRequestId,
  lastFiredAt, lastError }`. `lastRequestId` is the stint's request: poll it
  with `GET /sessions/{sessionId}/requests/{lastRequestId}`.

## The stint

- Every event moves the deadline to `now + quietMs`, never past `first event of
  the stint + maxMs`. A single event followed by silence is a stint of one;
  `quietMs: 0` delivers on the next pass.
- A worker in Overseer (`modules/triggers/triggerSources.ts`, every 2 s, under
  an advisory lock) takes due sources. The deadline is a database column, so a
  restart only delays delivery.
- Delivery re-checks the key live (`resolveAutomationTokenById`): revoked,
  expired, or an owner who lost access stops the source with `lastError`, and
  the events are kept. A Peon that is offline, or a refused call, is retried
  every 30 s. A deleted session is forgotten and the next try starts a new one.
- The turn's text is `New messages from source … (n):` followed by
  `[time] author: text` for each event, in order. **Nothing is truncated and
  there is no buffer limit.** A very large stint is still sent inline; turning
  one into an attachment, as [huge pastes](composer-pasted-text.md) are, is
  the open follow-up.
- The stint's id is the request id (and the session id, for the first), so a
  retried delivery cannot produce a second turn.
- Events that arrive while a stint is being delivered open the next stint at
  once.

## The pre-execution check

Before Overseer forwards a person's **approve** or **comment** on a sign-off,
it delivers whatever that session's source has buffered since, as
[context-only messages](context-only-participant-messages.md): they join the
session without waking the agent and reach the turn the decision starts. Those
events are marked delivered and do not fire again as a stint. They go out as
the person deciding, not with the source's key: an expired or revoked key must
not be able to skip this check. If delivery fails, the decision is refused with
`502 SOURCE_FLUSH_FAILED` rather than forwarded blind.

Peon's prompt for trigger sessions (`sessions/runtime.ts`) tells the agent to
read everything that arrived after it proposed before executing, and to revise
or withdraw — saying why — when it changes the picture: the request was added
to, withdrawn, or already handled. No MCP tool is involved.

## Storage

- `trigger_sources` — one row per (Peon + project, `sourceId`): the latest
  key, windows, the source's session, the current stint's start and deadline,
  the last request, last error.
- `trigger_source_events` — every event, unique by (source, `externalId`), with
  the stint it went into and whether it was delivered as a `stint` or as
  `context`. Events are kept; retention is not decided yet.

## Not built yet

- The Telegram sidecar: long-poll the bot, `POST` each group message as an
  event (`sourceId` = chat id), and offer `telegram_reply` / `telegram_search`
  to the agent through Armory.
- Session rotation (a new session after N days, carrying a summary and the
  open sign-offs), large stints as attachments, event retention, and a sources
  view in project settings.
