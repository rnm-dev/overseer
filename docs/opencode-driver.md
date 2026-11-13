# The opencode driver

Peon's third agent driver runs [opencode](https://opencode.ai) with models from
OpenRouter. It is an ordinary `AgentDriver` (see
[sessions and turns](sessions-and-turns.md#agent-drivers-are-the-only-harness-specific-code)):
the agent id and service name are both `opencode`, and every model id is an
OpenRouter model id such as `anthropic/claude-sonnet-4.5`.

The code is in `apps/peon/src/daemon/agents/`: `opencodeDriver.ts` (the driver),
`opencode.ts` (turns, events, catalog, fork), `opencodeServer.ts` (the process),
`openrouter.ts` (key, auth state, quota) and `opencodeLoginRoutes.ts`.

## One `opencode serve` per turn

Each turn starts its own `opencode serve` on `127.0.0.1` with a random port and
a random `OPENCODE_SERVER_PASSWORD`. Peon talks to it over HTTP and reads the
turn from its SSE stream, then stops the process and its process group. This
mirrors the Claude driver's process-per-turn model:

- the turn's MCP servers, permissions and settings come from
  `OPENCODE_CONFIG_CONTENT` and cannot leak into another session;
- conversations persist in opencode's own store, so the next turn's process
  continues the same session by id;
- a crashed or hung turn takes nothing else down.

The cost is opencode's startup time (a few seconds) on every turn. Model
discovery, fork, and storing or removing the API key each run a short-lived
server the same way.

Turn configuration: MCP servers from Peon's per-turn config become `remote`
entries; every permission is `allow` (the session is unattended); sharing and
autoupdate are off. `permissionMode: "plan"` selects opencode's read-only `plan`
agent. The Peon system prompt goes in the prompt's `system` field, and the
reasoning effort is the model's opencode `variant`. Image and PDF attachments
are sent as `file://` parts.

## Events, usage and outcomes

opencode events are normalized into the canonical Claude-shaped events:

- a text part is emitted once, when it completes;
- a completed or failed tool part becomes `tool_use` + `tool_result`. opencode's
  `bash`/`read`/`edit`/`write` become `Bash`/`Read`/`Edit`/`Write` with
  `file_path`/`old_string`/`new_string` inputs, so clients render them like
  Claude's. MCP tools keep opencode's `<server>_<tool>` name;
- each completed assistant message contributes its tokens and cost. opencode's
  cache reads and writes are disjoint from input, so the driver declares
  `tokenUsage.cacheIncludedInInput: false`. Reasoning tokens are folded into
  output and also reported as `reasoning_output_tokens`. The turn's
  `total_cost_usd` is opencode's cost, computed from model pricing;
- the turn ends at `session.idle`, after a 300 ms settle window, because the
  final `message.updated` can arrive just after idle;
- `maxBudgetUsd` aborts the turn once the summed cost exceeds it.

Structured outcomes are requested through the system prompt and parsed from the
final text, accepting plain or fenced JSON. opencode 1.19 has a native
`format: json_schema`, but it cannot read back a message stored with one:
listing that session's messages fails. A fork in the same session also returned
500, though that wasn't confirmed to be the same cause. Do not switch to the
native format until that is fixed upstream.

Cancellation sends `POST /session/:id/abort`, then stops the server if the
session does not go idle within 5 s. Steering is not supported, because opencode
queues a prompt sent mid-turn rather than steering it. Branching uses
`POST /session/:id/fork`; `branchAtTurn` is not supported.

## Models

The catalog comes from opencode's `GET /config/providers`. The driver keeps
OpenRouter models that support tool calls and are not deprecated, newest first.
The default is the first match for `anthropic/claude-sonnet`, `openai/gpt-5` or
`google/gemini-3-pro`. A model's opencode `variants` become its reasoning
efforts. Context limits from the catalog drive the context-usage gauge.

## The OpenRouter key

The key is never stored by Peon. It is read from, in order:

1. `OPENROUTER_API_KEY` in Peon's environment (opencode reads it too);
2. opencode's own credential store, `$XDG_DATA_HOME/opencode/auth.json`
   (default `~/.local/share/opencode/auth.json`).

Signing in is `POST /driver/opencode/login {apiKey}`. Peon validates the key
against OpenRouter's `GET /api/v1/key`, then stores it through opencode's own
`PUT /auth/openrouter`. The response reports `{loggedIn, keySource, keyHint,
authState}`, where `keyHint` is a masked key that is never the key itself.
`POST /logout` removes the stored key, and refuses with `KEY_FROM_ENVIRONMENT`
if the key comes from the environment. The driver advertises
`capabilities.loginKind: "api-key"`, and the web client shows a key form instead
of the browser/device-code flow.

Auth state is `unauthenticated` without a key, and `broken` after OpenRouter or
a run rejects it. Peon checks the key at startup and every 15 minutes. That
state feeds `agentAuthByAgent.opencode` on `/status`, which Overseer uses to
refuse new opencode sessions on a Peon that would fail them.

Quota is OpenRouter's view of the key: its credit limit (as a usage window when
the key has one), used credit and remaining balance in USD.

## Installation and updates

`opencodeCommand` (default `opencode`) selects the binary. Install it with
`npm i -g opencode-ai`. The CLI updater treats an npm global install of
`opencode-ai` as updatable and runs `opencode upgrade`. Peon sets
`OPENCODE_DISABLE_AUTOUPDATE=1` so that opencode never updates itself mid-turn.

## Tests

`apps/peon/src/daemon/__tests__/opencodeDriver.test.ts` drives `runOpencode`
against a scripted server, and runs one end-to-end test against the real CLI
and a fake OpenRouter endpoint when a binary is available (`opencode` on `PATH`,
or `OPENCODE_TEST_COMMAND`). Without one, that test is skipped. It was verified
against opencode 1.19.4.

## Not yet done

The Flutter client's stats, login and CLI-update screens still list only Claude
Code and Codex, so OpenCode is managed from the web client.
