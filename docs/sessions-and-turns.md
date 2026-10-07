# Sessions, turns and their control plane

What a session *is* to Overseer, who owns each decision inside it, and the
behaviours that have no page of their own. The realtime projection that carries
session summaries is in [session catalog synchronization](session-list-sync.md);
the transcript itself is in [transcript synchronization](transcript-sync.md).

## Control travels over Fleet HTTP, not reverse commands

The session catalog, rename, delete, new session starts, provider-native
branching, follow-ups, cancel, and queue operations (`add`, `list`, `edit`,
`remove`, `steer`, plus the deprecated `send-now` compatibility alias) travel
from Overseer to Peon over the direct authenticated Fleet HTTP API through mesh.
None of them exists in `reverse-command-v1`. `session-catalog-v1` remains only
the realtime projection/event channel and is never selected as request authority
for a browser or mobile catalog read or mutation. The browser/mobile API,
validation, actor attribution, idempotency and response shapes are unchanged by
that routing.

Stop keeps the Peon's HTTP response semantics and heals the indexed session
after `409 SESSION_NOT_RUNNING` — see [reverse command
gateway](reverse-command-gateway.md) for what does still use the gateway.

Stop is a desired-state command: once a known session is terminal, repeated
Stop requests succeed, including a retry whose earlier `2xx` response was lost.
Before answering, Peon reconciles both directions of run state. A durable
`running` summary without a live registry is finalized as orphaned; a live or
pending registry attached to a terminal/missing summary is fenced, interrupted
and removed. Thus fleet `activeSessions`, session status and Stop converge
without requiring a daemon restart.

## Branching

Branching calls Codex app-server `thread/fork` or Claude Code
`--resume ... --fork-session`, creates a new durable completed Peon session with
a copied authoritative transcript, source lineage and inherited project/runtime
defaults, and accepts an optional native `lastTurnId` only for Codex. Peon
single-flights the caller-owned branch UUID across the asynchronous provider
fork.

On web, a small menu under the last assistant message exposes Branch and
navigates to the accepted session. A transcript-leading, non-transcript lineage
notice links branches through `branchedFromSessionId` and delegated
sub-sessions through `parentSessionId`.

### Recovering when Codex cannot prepare a continuation

An error result containing either `thread/fork timed out after <n>ms` or
`invalid paginated history lineage ... missing source rollout` is not presented
as an ordinary failed agent turn. The web transcript explains that the request
never ran and offers **Continue in a new session**. That action starts an
independent session through the ordinary new-session endpoint, preserving the
project, working directory, agent, model and reasoning effort. Its opening
prompt names and links the source Peon session and includes the last unexecuted
user request; it explicitly tells the new agent not to fork or resume the old
provider thread.

This recovery is always an operator choice. A fork timeout may be transient,
while a missing rollout is terminal, but neither case may silently discard
provider-native history.

## Queue and steering

Queue items expose a stable `type: "queue" | "steer"`; steering preserves the
item ID while changing its type and dispatch priority.

The selected item remains durable until provider acceptance or replacement-run
start. Peon then retains a bounded durable receipt for its item ID, so duplicate
Steer delivery after a lost HTTP response returns success without sending the
prompt twice. A refusal before either boundary leaves the item visible and
retryable.

- **Codex** — a queued Steer remains durable until native `turn/steer`
  acknowledges the exact active turn; rejection retains the item and falls back
  to interrupt-and-resume.
- **Claude Code** — the current one-shot CLI has no native in-flight steer
  request, so a queued Steer interrupts the process, waits for its conversation
  state to be released, then resumes the same Claude conversation with the
  selected item. The item remains durable until the replacement run starts.

### Editing a queued message is a pull, not a patch

The web client edits a queued follow-up by taking it out of the queue and
putting it in the composer — text and attachments together — where the ordinary
composer actions apply to it again. Peon's `PATCH .../queue/:itemId` is
deliberately unused for this: it carries a prompt and a `replyTo` and nothing
else, so it cannot express an attachment change, and a row left standing in the
queue while it is being rewritten can be popped mid-edit and delivered as it
stood. The price is that an edited message loses its place and is queued again
at the back — a visible consequence, unlike a silent double delivery.

Attachments ride back by path. They are already committed under the peon's file
transfer root, so the composer carries them as paths (chips beside the picked
files, dropped one by one) instead of downloading and re-uploading bytes it
already sent. `resolveAttachments` therefore accepts either form of a path
inside the root: the root-relative one an upload receipt returns, or the
absolute one a stored message keeps. Containment in the root is still what
decides — an absolute path outside it is refused exactly as before.

A message that Peon starts between the click and the request cannot be pulled:
the delete is answered `UNKNOWN_QUEUE_ITEM`, the composer says so and stays
empty rather than inviting a second copy of a turn already running.

## Model and reasoning effort are pinned to the conversation

A model or effort named on a follow-up is a choice about the conversation, not
about one message: the Peon pins it onto the session record
(`SessionRecord.model`/`reasoningEffort`), so the composer, the run indicator
and a reloaded page all keep naming what actually ran, and a later follow-up
that names nothing inherits it. Only an explicit selection is pinned — a session
that named none keeps following the daemon-wide default as that default changes.

The record also keeps `createdModel`/`createdReasoningEffort`, the immutable
selection it was created with, so replaying an MCP spawn request still compares
like with like.

The clients keep unfinished choices in their drafts and inherit accepted
values from Peon. Selecting a named option is explicit; resetting a draft
override means inherit, not unpin the session. See the shared web and Flutter
[model selection contract](client/model-selection.md).

On the Codex app-server path a resumed thread answers with the model it was
created with, and that answer **must never rename a turn whose `turn/start`
carried an override** — otherwise the turn is reported, and billed in
`usageByModel`, against the old model.

Thread preparation grows with stored history. `thread/resume`, `thread/fork`,
and history-bearing `thread/read` calls therefore have a five-minute RPC
timeout; ordinary app-server control calls retain the 30-second default.

A Peon also carries a default reasoning effort next to its default model,
settable from Peon Settings → Agent. The Peon owns it (`ai.defaultReasoningEffort`,
flat on the wire as `aiDefaultReasoningEffort` on `GET`/`PATCH /settings` in
both the fleet and human profiles); `null` means the agent applies its own
default. It is validated against the **effective model**, not just the agent —
`PATCH` fails with `aiDefaultReasoningEffort is not valid for model <id>` — and
when a change of `defaultAgent` or default model strands a saved effort, the
Peon substitutes that model's own default rather than clearing it. Overseer only
ever submits an effort the effective model still advertises, and sends an
explicit `null` to reset (the settings form otherwise strips nulls to keep the
`PATCH` partial, which would make "reset" a no-op). Effort options come from the
per-model `reasoningEfforts` list a current Peon publishes on `/api/v1/models`,
falling back to the provider-wide list for older Peons; a model advertising no
efforts hides the selector entirely.

The lists themselves are no longer release-maintained constants. At daemon
startup each driver discovers them from its installed CLI; the current cache,
fallback and diagnostics contract is defined in [agent model catalog
discovery](agent-model-catalog.md). A configured model/effort is validated
against that same effective catalog, so UI discovery and turn admission cannot
silently disagree.

## Turn budget

Peon grants each logical invocation a bounded turn budget in addition to its
wall-clock and optional monetary limits. The 1.0.2 default is 1,000 turns,
raised from 300 so tool-heavy runs do not hit an artificial cap before the
30-minute task timeout. An upgrade migrates the exact old default once;
operator values that differed from 300 remain unchanged, and choices written
after the migration marker are always preserved.

Each accepted follow-up grants a fresh portion rather than sharing the first
invocation's remainder. A zero-turn provider retry does not grant another
portion. An owner may change `maxTurns`, `taskTimeoutMs`, and `maxBudgetUsd`
through the revision-fenced Peon settings control API; the new values apply to
the next provider invocation.

A harness-enforced stop is not inferred from free-form failure text. The
durable session summary and detail carry `terminalReason` with a stable
provider-neutral `code`, a bounded human `message`, `canResume`, and the exact
limit/usage numbers. Turn exhaustion uses `turn_limit_exceeded`; wall-clock
expiry uses `task_timeout`. Peon also appends a durable transcript warning with
the same code and `action: "continue"` before interrupting the provider. A
follow-up clears the old terminal reason as soon as the session starts running
again.

## A failed turn explains itself, and a transient one is replayed

The provider's terminal `result` event carries the human-readable reason in
`errors[]`, then `result`, then its `subtype`. Both transcripts render that
reason as its own error notice rather than folding a red duration onto the
previous assistant bubble — a bare red `10s` is indistinguishable from a turn
that simply took ten seconds.

Peon replays a failed logical turn at most twice (after 1.5s, then 5s) and only
when all of these hold:

- the provider gave an explicit reason and it names a provider 5xx/overload or a
  transport fault. Auth, billing, rate limits, invalid requests, context overflow
  and an unresumable conversation are reported, never retried — they fail
  identically on a replay, and a silent retry only delays telling the operator;
- the turn produced no non-synthetic assistant output. A turn that already spoke
  or called a tool has side effects in the world, and replaying its prompt would
  repeat them;
- the harness itself did not stop the run. `turn_limit_exceeded` and
  `task_timeout` stay authoritative (see [Turn budget](#turn-budget)).

The replay is announced on the failure that caused it: Peon stamps
`retry_scheduled`/`retry_max` on the result event before persisting it, so the
transcript reads as one prompt, one explained failure, and the answer the replay
produced. Claude Code's zero-turn synthetic result shares this path but is
replayed immediately and without an announcement, because nothing was attempted.
A replay shares the turn's budget portion rather than granting another, and holds
the same dispatch barrier a queued respawn uses, so orphan reconciliation and the
queue both leave the gap between the two processes alone.

## Usage is attributed to the turn that spent it

Peon persists invocation-scoped numeric usage snapshots before completion.
The latest snapshot/result replaces prior snapshots with the same harness-owned
run identity. Session identity excludes copied branch history; identified
ledger events are not capped by a stale summary. This retains observed partial
usage on cancellation and restart. Historical unowned events retain the older
summary-budget reconciliation and estimated session-start remainder.

Both `/stats` and `/analytics` now use the same UTC invocation-usage window.
Usage follows the latest snapshot/result timestamp and invoking author, while
session counts, wall duration, outcomes and storage still follow session start.
This is invocation-time accounting, not an exact per-request timeline for a
single invocation crossing midnight. Native steering is not separately billed.

Before this, a follow-up sent today into yesterday's session showed prompts with
zero tokens, while a session started inside the period credited its whole rollup
to every author who wrote in it. Peon's own
`apps/peon/docs/token-usage-analytics.md` holds the canonical buckets and the
`exact`/`estimated`/`mixed`/`missing` attribution rule, separate
`reported`/`partial`/`legacy` capture provenance, and driver-specific limitations.

## Codex runs only on the app-server driver

Codex execution uses only the native `codex-app-server` driver. The former
`codex exec --json` runtime and its selectable provider were removed. Persisted
`agent: "codex"` transcripts remain readable but **cannot be resumed**, because
their conversation identity is not compatible with app-server threads.
