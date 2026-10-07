# Agent provider login APIs

Agent drivers own their login implementations and API contracts. Claude Code and
Codex share only `terminalHarness.ts` and its process supervisor. There is no
generic login-action union or common provider login state machine.

The driver model catalog advertises `capabilities.login`. The Claude driver owns
`services.claudeLogin`; the Codex driver owns `services.codexLogin`. Both participate
in `shutdownAgentDriverRuntimes()`.

## Access and paths

Local CLI and authenticated Fleet callers use the same Peon namespace:

`/api/v1/driver/{claude-code|codex}`

Overseer exposes these under:

`/api/workspaces/:wsId/peons/:id/driver/{claude-code|codex}`

All Overseer login routes, including reads, require workspace ownership. Fleet
calls require the existing bearer token and a `Peon-Actor`. Attempts are bound to
that actor; other actors cannot inspect, submit to, or cancel them. Local CLI
attempts use `local-cli` and cannot be inspected by Fleet actors. Direct browser
origins are refused on the local CLI login surface. Responses use
`Cache-Control: no-store`.

## Claude Code

| Method | Relative route | Meaning |
| --- | --- | --- |
| POST | `/login` | Start Claude subscription sign-in; empty body |
| GET | `/login` | Recover the caller's current attempt as `{attempt: ...}` or `{attempt: null}` |
| GET | `/login/:id` | Poll the attempt |
| POST | `/login/:id/code` | Submit `{code: "..."}` once Claude is waiting |
| DELETE | `/login/:id` | Cancel the attempt |
| POST | `/logout` | Sign out with the configured provider CLI; empty body |

Attempt fields are `id`, `status`, `authorizationUrl`, `expiresAt`, `pollAfterMs`,
and `error`. States are `starting`, `awaiting_code`, `verifying`, `succeeded`,
`failed`, `cancelled`, and `expired`.

The service runs the configured CLI with `auth login --claudeai` in a private
tmux session, suppressing local browser launch. `tmux` must be installed on the
Peon host and available on its PATH. Each attempt owns an isolated foreground
tmux server and socket; it never attaches to an operator’s existing sessions.
The terminal supervisor owns that server, and completion, cancellation, timeout
and daemon death tear it down. No terminal logs or credential copies are written.
It parses the CLI's URL and code prompt, including split chunks
and terminal escapes. The API accepts only a single bounded code without terminal
control characters or line breaks. After the login command succeeds, a separate
`auth status --json` check must confirm `loggedIn: true` before success is reported.
The normal Claude auth status cache is then refreshed. Console and SSO login are
not exposed by this initial API.

## Codex

| Method | Relative route | Meaning |
| --- | --- | --- |
| POST | `/login` | Start device-code sign-in; empty body |
| GET | `/login` | Recover the caller's current attempt as `{attempt: ...}` or `{attempt: null}` |
| GET | `/login/:id` | Poll the attempt |
| DELETE | `/login/:id` | Cancel the attempt |
| POST | `/logout` | Sign out with the configured provider CLI; empty body |

Attempt fields are `id`, `status`, `verificationUrl`, `userCode`, `expiresAt`,
`pollAfterMs`, and `error`. States are `starting`, `waiting_for_authorization`,
`succeeded`, `failed`, `cancelled`, and `expired`. Codex has no code-submission
endpoint: the user enters its short code on the provider's website.

A dedicated `codex app-server` starts `account/login/start` with
`type: "chatgptDeviceCode"`. Codex itself polls the provider and emits
`account/login/completed`; only a matching `loginId` completes the attempt.
An existing authenticated account or an unrelated `account/updated` notification
does not count as success. Cancellation requests `account/login/cancel` and stops
the process. This follows the [official app-server login protocol](https://learn.chatgpt.com/docs/app-server).

## Client polling and cleanup

Start returns HTTP 202 immediately. Poll the returned ID every `pollAfterMs`
(currently 1500 ms) until terminal status, where `pollAfterMs` becomes zero.
After page refresh, GET `/login` recovers the caller's current attempt. A missing
attempt ID returns 404 `LOGIN_NOT_FOUND`; after a Peon restart the client must
start again. After successful login, refresh account status and quota with their
existing refresh mechanisms. The web Stats provider cards expose login for
workspace owners when an authentication error is present and the model
catalog advertises `capabilities.login`. The compact sign-in panel is the only
authentication callout; authenticated accounts do not show it. Claude authentication errors in the web
transcript also expose the same login control, including SDK assistant messages
marked `authentication_failed`. Ordinary assistant/user text does not trigger it.
The UI recovers the current attempt on mount, polls while pending, and offers
retry after transport errors. Claude uses a link plus a password-masked code
field; Codex uses a link and device code. Successful Stats login refreshes quota
and capabilities; a failed session message can then be retried by the operator.
The Flutter client integration remains tracked in OVSR-542.

Each provider permits one pending attempt. Repeated starts by its owner return
the same attempt; another actor receives 409 `LOGIN_IN_PROGRESS`. Deadlines are
absolute, ten minutes from creation; polling never extends them. Codex startup
also has a 30-second deadline; Claude verification has a 10-second deadline.

Completion, cancellation, failure, expiration, and shutdown close processes and
clear buffered output and URLs/codes. The supervisor terminates the process group
and escalates to SIGKILL after 300 ms, including descendants. It also watches its
parent IPC connection so abrupt daemon death triggers cleanup. A new attempt is
refused with `LOGIN_CLEANING_UP` while its predecessor is still closing.

Only a sanitized terminal result is retained in memory for 60 seconds, or until a
new attempt replaces it. Peon creates no auth directories, logs, worktrees, or
credential copies. The private tmux server uses its normal temporary Unix socket.
The official CLI owns its normal credential storage. Raw
provider errors are not exposed or logged because they can contain credentials.

## Logout

The model catalog advertises `capabilities.logout` separately, so older Peons
never show an unsupported action. Signed-in web Stats cards show a compact
Log out button for workspace owners. Successful logout refreshes quota and
capabilities; authentication errors then expose the existing login panel.

Both provider namespaces accept owner-authorized POST `/logout` with an empty
body and return `{loggedOut: true}` only after their configured CLI exits
successfully: `claude auth logout` or `codex logout`. The command has a ten-second
deadline, discards stdout/stderr, and stops its supervised process on every exit.
Login and logout are mutually exclusive, including login cleanup. Errors are
sanitized; pending login or logout returns 409. Claude auth status is refreshed
after logout. No credential files are manually deleted and no agent sessions
are cancelled by this action.

## Stats inventory

Codex installed plugins are read through app-server `plugin/list` with
`forceRefetch: false`, retaining installed versions and excluding uninstalled
marketplace suggestions. The temporary runtime is stopped after success or
failure. This avoids the CLI `plugin list --json` marketplace lookup, which can
exceed the Stats probe deadline. MCP inventory still uses `mcp list --json`.

## Validation

Lifecycle and API tests use fake provider processes. `claudeTmux.test.ts` uses
a real tmux server and a fake TTY-only CLI to verify code entry, cancellation,
expiration and process cleanup, including abrupt parent death; it skips when
tmux is unavailable. Another real-process test kills the supervisor’s parent and verifies that its CLI and descendants disappear. Optional smoke
tests start and cancel real sign-ins without authorizing an account:

```sh
PEON_LOGIN_SMOKE=/path/to/claude node --import tsx --test src/daemon/__tests__/providerLogin.test.ts
PEON_CODEX_LOGIN_SMOKE=/path/to/codex node --import tsx --test src/daemon/__tests__/providerLogin.test.ts
```

Run these from `apps/peon`. They never print authorization URLs or codes.
