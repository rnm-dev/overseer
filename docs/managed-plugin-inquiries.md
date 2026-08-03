# Managed plugin installation inquiries

`managed-plugin-inquiry-v1` is the shared Peon/Overseer contract for an agent
request that needs an operator to install a Codex managed plugin. PostHog is the
first exercised catalog entry; the envelope has no PostHog-specific fields and
never renders plugin-defined UI.

The initial managed allowlist contains only
`posthog@openai-curated-remote`. An agent cannot turn arbitrary remote catalog
entries into an install prompt; expanding the allowlist is a reviewed backend
change.

## Authority and flow

Peon exposes `request_plugin_install` through a session-authenticated, loopback-only
MCP binding. This is deliberate: Codex Code Mode wraps native dynamic tools in
its own `exec` host, whose built-in installer returns `user_confirmed: false`
without forwarding the confirmation request to Peon. The MCP call still works
through Code Mode, but its HTTP request remains owned by Peon and waits for the
operator response. Peon validates the active Codex thread and turn, calls
an unfiltered `plugin/list` (remote curated plugins are not classified as the
`vertical` marketplace kind) and `plugin/read`, normalizes an allowlisted metadata summary,
generates a UUID `inquiryId`, persists the safe operator state, and waits. It
does not call `plugin/install` until an authenticated operator submits `action:
"install"`.

All reads and mutations use direct authenticated Fleet HTTP over mesh:

- `GET /api/v1/sessions/:sessionId/inquiries`
- `GET /api/v1/sessions/:sessionId/inquiries/:inquiryId`
- `POST /api/v1/sessions/:sessionId/inquiries/:inquiryId/respond` with
  `{ "action": "install" | "cancel" }`

Overseer exposes the same suffix below
`/api/workspaces/:workspaceId/peons/:peonId`. Its normal workspace, Peon and
session/project-access gates apply, and it derives `Peon-Actor` from the
authenticated operator. There is no reverse command or realtime mutation path.

## Public envelope

Every record is `version: "inquiry-v1"`, `kind:
"managed_plugin_install"`, and contains the Peon-generated `inquiryId`, public
session ID, normalized plugin metadata, timestamps, status, terminal code,
responding actor, and the normalized `authPolicy`/`appsNeedingAuth` install
result. Native JSON-RPC request IDs, dynamic-tool call IDs, Codex thread/turn
IDs, runtime handles, marketplace paths, provider errors, and app `installUrl`
values are private Peon state and never cross the Fleet boundary.

States are `pending`, `installing`, `installed`, `auth_required`, `cancelled`,
`expired`, and `failed`. A repeated response by the same actor returns the
stored terminal envelope without reinstalling. A different actor cannot take
over a terminal response. Clients branch on stable codes:

- `UNKNOWN_INQUIRY` and `INQUIRY_ACTOR_MISMATCH` are request errors;
- `INQUIRY_CANCELLED`, `INQUIRY_EXPIRED`, `INQUIRY_TURN_ENDED`,
  `INQUIRY_RUNTIME_LOST`, `INQUIRY_STALE_GENERATION`, and `INQUIRY_FAILED` are
  durable terminal outcomes.

## Fences and persistence

An inquiry is bound internally to its session, native thread and turn, and the
runtime generation that received the request. Install rechecks all of them.
Expiry is ten minutes. A bounded Peon timer reconciles the active session while
the native request waits. Turn completion, Stop/cancel, expiry, runtime loss,
restart, or a generation change closes the inquiry and answers the native tool
request with failure when that handle is still live. A daemon restart restores
safe history but converts any pending/installing row to
`INQUIRY_RUNTIME_LOST`; native handles are deliberately not resumable.

The Peon state file is mode `0600` and atomically replaced. It contains only the
bounded public metadata/result plus private fencing identities. Auth URLs,
tokens, provider payloads and free-form native errors are neither persisted nor
returned, logged, projected, added to transcripts/analytics, or sent through
notifications.

Peon advertises `managed-plugin-inquiry-v1` in registration capabilities and
its Fleet status. Clients must hide this flow for older Peons that do not
advertise it.
