# Push notifications

Overseer delivers operator alerts through a durable outbox: `enqueuePushForEvent`
writes one `push_outbox` row per eligible subscription, and a worker drains it
every five seconds under an advisory lock, with exponential backoff per message.
Server code lives in `src/push.ts`; the provider seam is
`src/infrastructure/push/`.

## What triggers a notification

Exactly one thing: a `session_attention` occurrence turning **unread** — a turn
the user initiated (session create, follow-up, or a queued command) that
finished while they were not watching it. Nothing else notifies. `session`,
`peon` and `project` events stay on the live socket; a running session emits a
`session` event per activity tick, so notifying on those would be a metronome
rather than an alert.

Hanging off attention buys three properties without extra machinery:

- **One recipient.** The alert goes to the requester recorded on the occurrence,
  not to the workspace.
- **Silent when they are already looking.** `completeNextSessionAttention` asks
  `isUserViewingSession` first; a requester in front of that session on any
  connected device gets the occurrence retired as `read`, so no unread
  transition happens and nothing is enqueued.
- **Silent when they read it elsewhere first.** `markSessionAttentionRead`
  deletes the still-undelivered outbox rows for that user and session
  (`cancelPendingPush`). The worker's five-second drain and its backoff leave a
  real window where this matters, and it reads committed state rather than a
  socket's liveness.

The attention event carries only bookkeeping, so the title and body are read
back from the session index when the message is queued:

- **Title** — `<project> — <session title>`, e.g. `Billing API — Ship the
  deploy`. The project leads because a notification arrives with no context
  around it, and a phone truncating the tail still shows which project woke the
  user. The name comes from the `projects` catalog and falls back to the session's
  `project_key` (what the dashboard shows), then to a bare title when the session
  has no project. Empty title → "Session finished".
- **Body** — `sessions.preview`, else "Your run has finished".
- **`data`** — `workspaceId`, `peonId`, `sessionId`, `kind: "attention"`,
  `cursor`.

Both halves are flattened out of Markdown (`infrastructure/push/plainText.ts`) —
a lock screen is plain text, while a title and a preview are the model's and the
user's own prose. It is a flattener, not a parser: it removes emphasis,
headings, quotes, list markers, link URLs and code fences, and leaves every
ambiguity alone (`snake_case`, `3 * 4`, `2 < 3`, `#123`). Fenced blocks keep
their contents, since the first line of a snippet is often all a preview has,
and heading markers are matched mid-sentence because the index stores previews
already collapsed to one line. Access is re-checked at enqueue time — membership, `canAccessPeon`,
and `canAccessProject` against the session's project — because a notification
can outlive the grant that allowed the request.

`push_preferences.session_events` gates this alert; `peon_events` currently
gates nothing, since Peon-level events no longer notify. Both columns and their
API stay as they are — a Peon alert, if it is ever wanted, deserves its own
trigger rather than the firehose.

## Providers

| Provider | Credential | Status |
| --- | --- | --- |
| `expo` | none — `exp.host` authenticates the push token itself | delivering since the outbox was built |
| `fcm` | a Firebase service account (FCM HTTP v1) | configured on dev and production, 2026-07-27 |
| `apns` | — | accepted by the subscription API, not delivered |

A provider with no credential is neither enqueued nor selected for delivery, so
an instance without a service account behaves exactly as it did before FCM
existed — no backlog of messages nothing can send.

An unregistered device is distinguished from a transient failure: FCM
`UNREGISTERED` / `NOT_FOUND` / `INVALID_ARGUMENT` and Expo `DeviceNotRegistered`
retire the subscription (`push_subscriptions.disabled_at`) instead of retrying
it hourly forever. Quota, auth and upstream faults stay retryable.

## Configuration

One variable, on both environments:

```
OVERSEER_PUSH_FCM_CREDENTIALS   the Firebase service account JSON
```

It accepts three encodings, distinguished by the first character: `{` is the raw
JSON, a leading `/`, `./` or `~` is a path to read, anything else is base64 of
the JSON. Deploys use base64 — a Docker env file is line-oriented and a service
account key is not. A credential that cannot be read is a boot **warning**, not
a boot failure; Expo delivery is unaffected.

Both instances hold **different Firebase projects**. A device token is only
valid in the project that minted it, so unlike the shared Groq key in
[voice input](voice-input.md) there is no budget to split here — dev tokens
simply do not exist in production and vice versa.

| | Firebase project | Credential file (nid-dev, mode 600) | Wired through |
| --- | --- | --- | --- |
| dev | `overseer-dev-f24fe` | `/rnm/overseer/secrets/fcm-dev.json` | `/rnm/overseer/.env.overseer-dev`, base64 |
| production | `overseer-9fe46` | `/rnm/overseer/secrets/fcm-prod.json` | `.kamal/secrets` → `config/deploy.yml` secret list, base64 |

`/rnm/overseer/secrets/` sits outside the app git repository. The service
account JSON is never committed; `.kamal/secrets` reads it at deploy time with
`base64 -w0`.

## iOS Live Activities

A separate surface from notifications, with its own tokens and its own rules
(`src/liveActivity.ts`, routes in `src/routes/push.ts`, payload builder in
`src/infrastructure/push/liveActivity.ts`). The whole contract is **one activity
per operator per device connection** — an aggregate of everything that operator
has running, never one activity per session.

- The identity is `(user, device, connectionId)`. User and device come from the
  bearer token; `connectionId` is the client's Overseer-connection hash. **No
  registration takes a `workspaceId`, `peonId` or `sessionId`** — an aggregate
  spans workspaces, so a session identity would be meaningless here.
  - `PUT /api/push/live-activities/start-token` — `{connectionId, token, appId?}`,
    the iOS 17.2+ push-to-start token. Without it there is no remote start and
    the client reconciles at launch instead.
  - `PUT /api/push/live-activities` — `{connectionId, activityId, token, appId?}`,
    the ActivityKit update token; it binds to the existing claim rather than
    creating a second activity. `activityId` is `overseer:<connectionId>`.
  - `DELETE` on either path releases that registration; `GET
    /api/push/live-activities` returns the aggregate plus per-connection
    registration state. No token is ever echoed back.
- Content state is `{runningCount, completedCount, oldestStartedAt, updatedAt}`.
  `running` = the operator has a `pending` occurrence on a session the index
  still calls `running`; `completed` = an occurrence they have not read.
  Timestamps inside `content-state` are **seconds since 2001-01-01** (Swift's
  reference date), while `aps.timestamp`/`stale-date`/`dismissal-date` are UNIX
  seconds.
- **Delivery needs two tokens, not one.** FCM v1 requires a recipient on every
  message, and an ActivityKit token is not one: a message carrying only
  `apns.live_activity_token` is refused with `400 INVALID_ARGUMENT — Recipient
  of the message is not set`, which is how every Live Activity push failed
  silently until 2026-07-27 (`live_activity_claims.last_error` on production
  held exactly that string). The message therefore carries `token` = that
  device's ordinary FCM registration (`push_subscriptions`, same
  `user_id`+`device_id`, `provider='fcm'`) to name the app instance, plus
  `apns.live_activity_token` for the activity itself. Confirmed against
  `messages:send?validate_only=true`: activity token alone → 400, activity token
  + registration token → 200. A device with no live FCM subscription therefore
  has **no** Live Activity delivery path — the server skips it and leaves the
  claim idle rather than burning a start.
- The aggregate is always **recomputed from committed state**, never
  incremented, and the `live_activity_claims` row is a conditional
  `UPDATE … WHERE state='idle'` — that is what makes two events arriving
  together produce one start and one update instead of two activities. An end is
  sent only when `runningCount` reaches 0; the update token dies with the
  activity, so the next run goes through push-to-start again.
- Covered end to end by `src/liveActivity.test.ts` (start/update/end across
  parallel sessions and two workspaces, with FCM faked at the fetch boundary).
  Behaviour on a real iOS handset — foreground reconciliation and background
  APNs updates — is still unverified; no iOS client has registered a token.

## State (2026-07-27)

- **Both environments are live.** Production runs
  `vibze/overseer:6e7510ed92339429f82b64c8478b0430bc38871b`, deployed
  2026-07-27, resolving `overseer-9fe46` with no config warnings; dev resolves
  `overseer-dev-f24fe`.
- Both service accounts were verified against `fcm.googleapis.com/v1` end to
  end: the JWT is signed, the token exchange succeeds and `messages:send` is
  reached in both projects.
- **Real devices are registered in production** — one Android and one iOS token
  confirmed by a `validate_only` send (which validates the credential and the
  token against the project without delivering anything) as belonging to
  `overseer-9fe46`. A third, older Android token answers `UNREGISTERED` and will
  retire itself the first time delivery is attempted.
- Devices subscribe through `PUT /api/push/subscriptions` with
  `{provider, platform, token, appId}`. No notification has been delivered to a
  real handset yet: nothing has been queued, because the outbox fills only when
  a user-initiated turn completes unwatched.
- **Expo is being retired as the transport** (OVSR-206): the mobile client
  registers native FCM tokens instead, each build flavor pointing at its own
  Firebase project, and iOS needs an APNs auth key uploaded to both projects
  first. Once no `expo` subscriptions remain in either database, the Expo sender
  in `src/push.ts` can be deleted. Because of that direction, the service
  account is deliberately **not** being uploaded to Expo/EAS credentials — that
  upload is only needed for the Expo-relayed Android path this replaces.

Per-workspace delivery preferences (`enabled`, `sessionEvents`, `peonEvents`)
live under `GET`/`PUT /api/workspaces/:wsId/push/preferences` and apply to every
provider.
