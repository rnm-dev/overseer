# Shared session invitations

Session sharing admits another person to one existing canonical session. It
never branches, copies or creates a second conversation. The session remains
owned by Peon's normal session/transcript/stream APIs; Overseer owns the
invitation, participant, credential, limit, revocation and presence state.

## Contract and trust boundary

An invitation is a random capability whose SHA-256 digest is stored in
Overseer. The raw value is returned only when a manager creates an invitation
and is used in the public capability endpoint; it is never an invitation ID and
is never recoverable from the database. Guest names are normalized, control
characters are removed or converted to spacing, bounded to 80 Unicode code
points and rendered with an explicit `Guest` label. Names are not identity
proofs.

Anonymous acceptance creates a durable guest principal and an HttpOnly,
Secure, `__Host-` participant cookie. The cookie is scoped by the server to
the admitted workspace, Peon and session, and expires with participant access.
Writes using a cookie also require the existing trusted-origin CSRF check.
WebSocket access uses a separate single-use ticket that expires after 30
seconds. Credentials and tickets are hashed at rest and are deleted or
revoked when participant access is revoked.

An authenticated person is attributed to their authenticated user, even when
they arrived through an invitation. The suggested guest name is never used to
rename an authenticated actor. A user who already has ordinary access is sent
to the normal session directly and does not consume an invitation or its
limits.

## Limits and accounting

The defaults are 10 turns, 24 hours of participant duration and a 7-day
invitation lifetime. Hard maxima are 100 turns, 30 days of participant
duration, 5,000,000 tokens and 100 USD (stored as integer micro-dollars).
Managers may choose lower values. Limits are bounded and validated before
storage.

Turn admission locks the participant row and inserts a unique
`(participant_id, command_id)` reservation before the canonical follow-up or
queue request is forwarded. A repeated request ID is therefore idempotent and
does not spend another turn; a newly admitted turn is counted conservatively,
even if the downstream Peon request later fails. Duration and turn checks are
hard enforcement.

Peon admission responses are not authoritative token or cost accounting. The
current implementation does not infer usage from them: token and cost columns
remain `unknown` until an authoritative transcript/result usage source can be
reconciled, and they do not block a turn. The UI and roster describe these
figures as reported/soft rather than promising hard token or cost enforcement.

## Routes

All paths below are under `/api` unless stated otherwise:

- Manager collection: `GET` and `POST`
  `/workspaces/:wsId/peons/:peonId/sessions/:sid/invitations`.
- Manager item: `GET`, `PATCH` and `DELETE`
  `/workspaces/:wsId/peons/:peonId/sessions/:sid/invitations/:invitationId`.
- Public capability preview/accept: `GET` and `POST`
  `/session-invitations/:token`.
- Web entry: `/join/session/:token`.
- Manager roster/revocation: `GET`
  `/workspaces/:wsId/peons/:peonId/sessions/:sid/participants` and `DELETE`
  `/workspaces/:wsId/peons/:peonId/sessions/:sid/participants/:participantId`.

After acceptance, the browser uses the existing canonical session, transcript,
live-stream, follow-up, queue, file, attachment, tool and confirmation routes.
There is no public-session API. A participant credential is accepted only on a
request whose session can be proven from the canonical `:sid` or the shared
session upload/attachment path; it cannot be used to inspect another session
on the same Peon or another workspace. Read invitations expose only transcript
history and the live tail. Participate invitations retain the
ordinary session behavior, including edits, follow-ups, attachments, tools and
confirmations. Branch, delete and management-only routes are not participant
actions; the canonical session edit route remains part of participate access.

Session managers are workspace owners or the indexed author of that session.
They can edit/revoke invitations and revoke invited participants. Direct
ordinary participants are deliberately not individually revocable through this
roster endpoint; their existing workspace/Peon ACL remains authoritative.

## Durable schema ownership

Migration `040_session_sharing` adds normalized rows:

- `session_invitations` stores the hashed capability, suggested name, access
  mode, bounded limits, expiry, creator and revocation state.
- `session_participants` stores one authenticated or guest principal per
  session, provenance, access, timestamps, participant limit snapshots and
  usage quality/counters.
- `session_participant_credentials` stores scoped browser credential digests.
- `session_participant_ws_tickets` stores short-lived single-use WebSocket
  ticket digests.
- `session_participant_turn_reservations` stores atomic command idempotency and
  admission state.

Workspace, creator, user, invitation and participant relationships use foreign
keys where those records share Overseer's authority. `peon_id` and `session_id`
intentionally do not have foreign keys: Peon owns execution and the session
catalog is a synchronized projection that can be reconciled or removed
independently of an invitation. The participant-to-invitation foreign key also
includes the full workspace/Peon/session scope, preventing an invitation from
being attached to a row for a different canonical session. Every query still
scopes both values together with the workspace, and invitation creation
requires the canonical projected session to exist.

## Revocation and presence

Revoking an invitation blocks new admissions but does not revoke participants
already admitted from it. An admitted participant can continue through their
scoped credential until its own duration expires or a manager revokes that
participant. Participant revocation preserves the historical row and its
message attribution, immediately revokes credentials, removes outstanding
WebSocket tickets and emits a revocation event. Connected streams converge
immediately within the process and through the existing bounded WebSocket
reconciliation loop across processes; new HTTP actions are rejected at the
database-backed authorization check.

Presence is ephemeral and separate from durable access. The existing realtime
connection heartbeat reports `online` or `away` plus `lastSeenAt`; an expired
heartbeat is shown as `offline`. Heartbeats are TTL-based, reconnect-safe and
scoped to the same session before being merged into the durable participant
roster. Losing presence never revokes access, and revoking access does not
delete historical participant data.

The web share panel creates and manages links, shows the warning that messages
permanently affect the shared conversation, lists invited/authenticated/guest
participants with access, provenance, usage and presence, and offers revoke
actions. The public join page pre-fills the suggested guest name, permits an
anonymous visitor to edit it, redirects already-authorized users to the normal
session, and shows explicit invalid, expired, revoked and exhausted states.
