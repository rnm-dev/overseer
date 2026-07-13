# Peon task: persist session owner and per-message sender

## Why

Multiple workspace members can interact with the same Peon session through
Overseer. Overseer already authenticates each member and sends their email in the
trusted `Peon-Actor` request header. Peon currently exposes a session-level
`initiator`, but the transcript does not reliably identify who submitted each
human message. As a result, follow-ups from different people look identical.

We need two distinct identities:

- **Session owner/initiator:** the actor who created the session. This is immutable.
- **Message sender:** the actor who submitted a particular initial prompt or
  follow-up. This is recorded on every human-authored transcript event.

## Request

Persist `Peon-Actor` on session creation and on every human-authored message.

### Session creation

For `POST /api/v1/sessions`:

1. Read the existing `Peon-Actor` header using the same normalization and trust
   rules Peon already uses.
2. Store it as the session's `initiator`.
3. Add the same value as `author` on the initial `user_message` transcript event.
4. Once set, `initiator` must not change when another actor sends a follow-up.

### Follow-ups

For `POST /api/v1/sessions/:id/followup`:

1. Read `Peon-Actor`.
2. Add it as `author` on the resulting `user_message` transcript event.
3. Do not overwrite the session's `initiator`.

Example transcript events:

```json
{ "type": "user_message", "text": "Investigate the failed build", "author": "alice@example.com" }
{ "type": "user_message", "text": "Also check the deploy logs", "author": "bob@example.com" }
```

The `author` field must be present in both:

- `GET /api/v1/sessions/:id/transcript`
- `GET /api/v1/sessions/:id/stream` events, including the immediate echo of a
  newly accepted message

Session list/detail responses must continue exposing:

```json
{ "initiator": "alice@example.com" }
```

## Compatibility

- `Peon-Actor` remains optional for direct API clients and older Overseer builds.
- If the header is absent, keep `initiator`/`author` absent or `null`; do not invent
  a shared-token identity such as `overseer` or `unknown`.
- Existing transcript rows without `author` must remain readable.
- Preserve `author` during transcript parsing, serialization, replay, session
  resume, and any transcript repair/rewrite path.
- Only genuine operator messages receive this field. Do not label assistant,
  system, tool-use, or tool-result events as though a human sent them.
- Treat the header as trusted only after normal Peon bearer-token authentication,
  consistent with the existing protocol.

## Concurrency requirement

Do not derive the sender from mutable session state. Capture the actor from each
request and write it atomically with that request's `user_message` event. Two
near-simultaneous follow-ups from different actors must retain their respective
authors even if one interrupts the other.

## Tests

Add coverage proving that:

1. Creating a session as Alice stores `initiator = Alice` and marks the initial
   `user_message.author = Alice`.
2. Bob's follow-up has `author = Bob` while `initiator` remains Alice.
3. Alice's later follow-up is attributed to Alice, preserving event order.
4. Transcript reads and live streams expose identical author values.
5. A request without `Peon-Actor` still succeeds and produces no fabricated
   identity.
6. Legacy transcript events without `author` still parse and return normally.
7. Concurrent follow-ups from two actors never swap or collapse authors.
8. Restarting Peon and resuming a session preserves both the initiator and all
   recorded message authors.

## Acceptance criteria

- Every newly persisted human `user_message` is attributable to the actor who
  submitted that request when `Peon-Actor` is supplied.
- The session `initiator` identifies its original creator and is immutable.
- Historical and unauthored API traffic remains backward compatible.
- Author identity survives restart and appears consistently in transcript and
  streaming APIs.

## Overseer follow-up

Once this ships, Overseer can extend its transcript `Item` model and user bubble
UI to render `user_message.author`. Overseer already forwards the authenticated
user's email as `Peon-Actor` for session creation and follow-ups, and already
indexes the Peon session's `initiator` as `sessions.author`; no transport change
is required.
