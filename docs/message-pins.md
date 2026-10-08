# Message pins

Web session transcripts expose a pin action for committed human and assistant
messages. The pinned-messages panel renders their saved message snapshots.
Pins are shared within a session, not personal bookmarks, and never enter the
agent prompt or mutate Peon's transcript.

Overseer stores pins in `session_message_pins` (migration 045), keyed by
workspace, Peon, session and authoritative event ID. Pin creation fetches the
canonical transcript from Peon and enriches its author metadata; clients send
only the event ID. Repeating a pin preserves the original snapshot and author.
Unpinning is idempotent. There are at most 50 pins per session, enforced under a
transactional advisory lock, and a snapshot is limited to 128 KiB. Session
deletion removes its pins. Branches start with no pins.

Routes below the ordinary workspace/Peon/session path are `GET /pins`,
`PUT /pins/:eventId`, and `DELETE /pins/:eventId`. Existing session ACLs apply;
read-only invitations can list pins but cannot change them. Revoked invitations
lose access through the normal participant authorization boundary.

The web reloads pins on opening the panel, window focus, and every 15 seconds
while visible. Requests from a previous session cannot replace current state.
Mutations serialize in the client; failures are shown without optimistic state.
Pin creation requires Peon online and currently fetches the full canonical
transcript through the existing API. Reading and removing saved pins do not
require a transcript fetch. Pinned snapshots remain as captured at pin time.
Native Flutter controls are outside this feature's scope.
