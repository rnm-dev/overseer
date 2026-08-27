# Context-only participant messages

`context-only-messages-v1` lets people write durable messages into one
canonical session without waking, steering or queueing the coding agent. The
normative machine-readable [schema](protocol/context-only-messages-v1/schema.json)
and [fixtures](protocol/context-only-messages-v1/fixtures.json) define the wire
shapes, bounds and lifecycle rules.

The product has two delivery lanes and one transcript:

- **Send to people** appends a `participant_message` through the dedicated
  context endpoint. It never invokes the agent.
- **Send to agent** uses the existing follow-up or queue/steer endpoint.
  Choosing the agent in the mention picker selects this lane. An agent request
  may still carry structured human mentions.

Neither Overseer nor Peon parses raw `@text` to choose a lane or recipient.
Typing text that resembles a mention without selecting a participant is plain
text and creates no notification.

## Authority split

Peon owns:

- the immutable authoritative transcript event;
- the per-session `contextSeq` order;
- pending context, claims and the delivered-through watermark;
- deterministic assembly into the next real provider turn; and
- idempotency of the context-message mutation.

Overseer owns:

- authenticated users, admitted guests and session access;
- resolving submitted principal references to authorized recipients;
- the canonical display-label snapshot relayed to Peon;
- human-mention unread state, realtime recipient scoping and push delivery; and
- the public API relay and its ACL checks.

Web and Flutter render Peon's transcript and Overseer's mention-attention
projection. They never insert an optimistic transcript row. A composer ghost
may use the authoritative event's `commandId` for exact retirement.

## Principals and mentions

A stable principal reference is `{ kind: "user" | "guest", id }`. The ID is
opaque outside Overseer's identity authority: a user ID for an authenticated
person or an authority-backed guest ID. Email addresses, display names and raw
mention text are not identities.

The public request supplies ranges plus principal references. A range is over
the raw message string and uses explicitly named UTF-16 code-unit offsets:

```json
{
  "startUtf16": 0,
  "lengthUtf16": 7,
  "principal": { "kind": "user", "id": "user-42" }
}
```

UTF-16 is deliberate: JavaScript and Dart both expose composer selection in
those units. Ranges must be ordered, non-overlapping, inside the string and
must not split a surrogate pair. A message carries at most 32 mentions.

Clients cannot submit labels. Overseer verifies that each principal is a
visible participant in this exact workspace, Peon and session, then adds its
authoritative display snapshot. The original message text is not rewritten if
the current canonical label differs from the characters that were typed; the
range and stable principal make the text interactive, while the snapshot names
the person independently.

The agent is not a principal kind. Selecting the agent changes the send lane;
an `agent` mention submitted to the people-only route is `BAD_MENTION`.

## Context-message mutation

The public route is:

```http
POST /api/workspaces/:wsId/peons/:peonId/sessions/:sid/context-messages
Peon-Request-Id: 018f06c2-1c2a-7b35-8f2d-6f2f9024ac11
```

```json
{
  "text": "@Viktor please check this",
  "attachments": [],
  "mentions": [
    {
      "startUtf16": 0,
      "lengthUtf16": 7,
      "principal": { "kind": "user", "id": "user-42" }
    }
  ]
}
```

Overseer derives the author, resolves every mention and relays the normalized
request through Fleet HTTP:

```http
POST /api/v1/sessions/:id/context-messages
```

The successful response is the committed transcript event. Repeating the same
`Peon-Request-Id` and payload returns the same event; reusing the ID for a
different payload returns `409 IDEMPOTENCY_CONFLICT`.

The context endpoint accepts zero human mentions, because a participant may
write to everyone already watching the conversation. It can never start,
resume, steer, interrupt or enqueue an agent turn regardless of message text.

## Transcript event

Peon appends a first-class event rather than overloading `user_message`:

```json
{
  "type": "participant_message",
  "eventId": "participant_12",
  "commandId": "018f06c2-1c2a-7b35-8f2d-6f2f9024ac11",
  "contextSeq": 12,
  "createdAt": 1787846400000,
  "author": { "kind": "guest", "id": "guest-7", "label": "Sam" },
  "text": "@Viktor please check this",
  "attachments": [],
  "mentions": [
    {
      "startUtf16": 0,
      "lengthUtf16": 7,
      "principal": { "kind": "user", "id": "user-42", "label": "Viktor" }
    }
  ]
}
```

The event is immutable and follows the ordinary authoritative transcript
append, pagination, live-tail, replay and attachment-lifetime rules. It does
not increment turn or prompt analytics, change session status, trigger orphan
recovery or create agent-completion `session_attention`.

V1 provides no message edit or delete operation. Session deletion removes the
associated delivery sidecar together with the transcript.

## Mentions on agent-invoking messages

The existing follow-up and queue requests may carry the same public `mentions`
array. Overseer resolves it before Fleet relay, and Peon preserves the
normalized metadata plus an `authorPrincipal` snapshot on the authoritative
`user_message`. The existing string `author` remains compatible; the structured
principal is what makes self-notification exclusion and guest attribution
stable. Absence means no human mentions. On the queue edit contract, omission
preserves mentions, an array replaces them, and `null` clears them.

Mention metadata never decides whether the request invokes the agent. The
existing route already makes that decision.

## Delivery into the next turn

Peon gives each context event a monotonically increasing `contextSeq`. Mutable
delivery state is a Peon-owned sidecar, not a field rewritten inside historical
transcript events.

When a real queued or immediate agent turn begins execution, Peon atomically
claims every unclaimed context event through the latest sequence visible at
that instant. It persists the claim against the invoking command before
starting provider setup. Context posted after this high-water boundary,
including while another turn is active, waits for the following turn.

A queued command claims context when it starts execution, not when it enters
the queue. Therefore messages posted while the current run is active are
included in the actual next queued turn.

After the provider accepts the turn, Peon advances the delivered-through
watermark for the claimed range. A permanent pre-acceptance refusal releases
the claim so a later real turn can carry it. A retry of the same logical
command reuses its claim. This promises one assignment to one accepted Peon
turn; it does not claim impossible absolute exactly-once execution after an
ambiguous external provider crash. Existing provider-turn reconciliation owns
that boundary.

Two queued turns cannot claim the same range. A context event is never silently
discarded or assigned to a later turn merely because the current provider
envelope would be too large.

## Provider envelope and bounds

The provider-neutral envelope is compact canonical UTF-8 JSON ordered by
`contextSeq`. Top-level fields are `version`, `kind`, `messages`; each message
uses `contextSeq`, `createdAt`, `author`, `text`, `attachments`, `mentions` in
that order; author fields are `kind`, `id`, `label`. No insignificant
whitespace is emitted. The golden byte shape is:

```json
{"version":1,"kind":"participant_context","messages":[{"contextSeq":12,"createdAt":1787846400000,"author":{"kind":"guest","id":"guest-7","label":"Sam"},"text":"@Viktor please check this","attachments":[],"mentions":[{"startUtf16":0,"lengthUtf16":7,"principal":{"kind":"user","id":"user-42","label":"Viktor"}}]}]}
```

The envelope is marked as untrusted participant content and inserted
immediately before the invoking operator prompt. Codex app-server and Claude
Code receive the same logical envelope; no provider-native thread or reply
primitive is used.

Admission bounds ensure the complete pending envelope always fits:

- 8,192 Unicode code points and 16 KiB UTF-8 per message;
- 32 mentions and 10 attachments per message;
- 64 pending context messages; and
- 64 KiB UTF-8 for the exact encoded pending provider envelope.

If the next message would exceed a pending count or envelope-byte bound, Peon
returns `409 CONTEXT_BACKLOG_FULL` and commits nothing. It never truncates,
summarizes or silently skips participant context.

## Branches

Branching copies visible `participant_message` events just like the rest of the
authoritative transcript. Every copied context event is considered already
delivered in the new branch, so creating a branch cannot unexpectedly inject
old conversation into its next provider turn. Pending state in the source
session remains unchanged.

## Human mention attention

After Peon commits an event, Overseer creates one idempotent mention occurrence
for each distinct mentioned recipient except the author. Repeating one
recipient in several ranges still creates one occurrence. Its identity is
`(recipientPrincipal, eventId)`. This store and its realtime event are separate
from `session_attention`, because no agent request or completion occurred.

The authenticated recipient or scoped guest receives only their own occurrence.
Opening/rendering occurrences acknowledges exact authoritative event IDs in
batches of at most 100:

```http
POST /api/workspaces/:wsId/peons/:peonId/sessions/:sid/mention-attention/read
```

```json
{ "eventIds": ["participant_12", "participant_13"] }
```

An already-read, unknown or non-owned event ID is an idempotent no-op; the
caller can never use acknowledgement to discover another principal's
occurrence.

Authenticated users may receive a generic push notification. Push payloads do
not contain message text, attachment names or recipient lists. Guest principals
receive in-session unread/realtime state but no account-device push.

Agent-invoking `user_message` events with human mentions create the same human
mention occurrences independently of the ordinary agent request lifecycle.

## Stable failures

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `BAD_CONTEXT_MESSAGE` | Text, attachments or body shape is invalid. |
| 400 | `BAD_MENTION` | A range or principal shape is invalid. |
| 400 | `BAD_MENTION_ACK` | The exact-event acknowledgement is invalid. |
| 404 | `MENTION_PRINCIPAL_NOT_FOUND` | The scoped recipient does not exist or is not visible. |
| 404 | `UNKNOWN_SESSION` | The canonical session does not exist. |
| 409 | `CONTEXT_BACKLOG_FULL` | Admission would exceed the pending envelope bounds. |
| 409 | `IDEMPOTENCY_CONFLICT` | A request ID was reused with a different payload. |
| 409 | `UNSUPPORTED_CAPABILITY` | The Peon does not support the complete contract. |

Errors, logs, diagnostics, analytics and push payloads never contain message
text, attachment names or recipient lists.

## Capability and mixed versions

Peon advertises `context-only-messages-v1` only after storage, the Fleet route,
transcript publication, delivery claims, both provider adapters and recovery
work together. The contract task alone does not advertise it.

Without the capability, clients hide people-only send and structured mention
actions while ordinary agent follow-ups continue unchanged. A legacy client
encountering `participant_message` must ignore it or render a bounded generic
transcript row without crashing. Unknown mention metadata never changes agent
routing.

## V1 non-goals

- parsing raw `@text` into identities or routing;
- editing or deleting participant messages;
- provider-native threads, replies or mentions;
- mutable delivery flags on historical transcript events;
- using human mentions as agent-completion attention;
- silently truncating or summarizing the pending context backlog; and
- promising provider execution exactly once across an ambiguous external
  provider failure.
