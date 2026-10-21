# Message threads

Message threads are first-class Peon sessions anchored to one replyable transcript event. They appear immediately in the ordinary session list and `session-catalog-v1`, with `kind: "thread"`, `threadState: "discussion"`, and `threadSource` lineage. Posting to a thread never invokes an agent and never appends to the source session's JSONL transcript.

## Ownership and storage

Peon owns the authoritative `message-threads-v1` state in the source session's artifact directory. The sidecar is schema-validated, size-bounded, written atomically with owner-only permissions, and contains bounded messages, idempotency receipts, the eventual context capsule, and the linked agent-session id. This version deliberately stops at the Peon Fleet HTTP control API; Overseer and web integration are separate work.

One thread exists per anchor event. Its thread id is also its Peon session id; there is no second session allocated on invocation. Create, post, and invoke mutations require a `Peon-Request-Id`; replaying the same request is safe, while reusing an id for different content is rejected.

## Invoking an agent

Creation persists a dormant `completed` SessionRecord without starting a provider. The first invocation activates that same record, changes `threadState` to `active`, and starts its first non-resume provider turn. Peon asynchronously reads the committed source transcript under byte, line and event limits, and fails closed when the source exceeds those limits. It builds a bounded, extractive capsule from at most 24 replyable user/assistant text events through the anchor plus as much recent thread discussion as fits. Tool payloads, service events and events after the anchor are excluded. The capsule carries a SHA-256 provenance digest.

The capsule is passed inside the new session's first private user-level provider prompt, explicitly marked as untrusted quoted history. It is never interpolated into system/developer instructions. It is omitted from public session records, retired from the session summary as soon as the provider accepts the turn, and is not appended to either transcript. Provider-native `/compact` is deliberately not used: its output is opaque provider state, whereas the thread boundary needs a deterministic, provider-neutral envelope and must work identically for Claude and Codex. The new provider conversation persists normally after that first turn.

Invocation uses a two-phase local state transition. Peon atomically persists `reserved` with the capsule and target session id before starting the session, then advances to `started`. Recovery retries the same session id, and the session service reuses an already-created record. Once invoked, the discussion is frozen; subsequent conversation belongs in the linked session.

Bounds are part of the contract: a session accepts at most 64 threads; a thread accepts at most 100 messages; each message and invocation prompt is at most 16 KiB; capsule source text is capped at 96 KiB and the complete serialized capsule at 128 KiB; the sidecar is capped at 4 MiB. Principals and persisted state use strict schemas with no unknown fields.

## HTTP surface

When `message-threads-v1` is advertised:

- `GET /api/v1/sessions/:id/message-threads`
- `POST /api/v1/sessions/:id/message-threads` with `anchorEventId`
- `POST /api/v1/sessions/:id/message-threads/:threadId/messages`
- `POST /api/v1/sessions/:id/message-threads/:threadId/invoke`

Thread responses expose only `hasCapsule`, never the capsule body or its invocation receipt.

Source transcript reads decorate the anchor message at response time with
`messageThread: { threadId, messageCount, activityStatus, updatedAt }`.
`messageCount` counts replies in the private discussion (not the anchor), and
`activityStatus` is `discussion` until invocation and `active` afterward. The
decoration is derived from the sidecar and is never written into transcript
JSONL, so creating or updating a thread does not pollute or rewrite history.

The ordinary session collection and catalog summaries expose `kind`, `threadState`, and `threadSource`, so clients can render or group threads without joining against the thread-control endpoint.
