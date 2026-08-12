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

## Queue and steering

Queue items expose a stable `type: "queue" | "steer"`; steering preserves the
item ID while changing its type and dispatch priority.

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

On the Codex app-server path a resumed thread answers with the model it was
created with, and that answer **must never rename a turn whose `turn/start`
carried an override** — otherwise the turn is reported, and billed in
`usageByModel`, against the old model.

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

## Usage is attributed to the turn that spent it

Analytics usage is attributed to the turn that spent it, not to the session that
started first. Peon replays a session's transcript, charges each `result`
event's tokens, cost and provider duration to the author of the user message
preceding it, and dates them by that event's stamped `createdAt`. The session
record stays authoritative, so whatever its rollup holds beyond the transcript's
result events is charged to the initiator at session start — which is where a
session with a pruned or pre-dating transcript lands whole.

Session counts, wall duration, outcomes and storage still follow session start,
and `/stats` remains a session-start summary that does not share the per-turn
window.

Before this, a follow-up sent today into yesterday's session showed prompts with
zero tokens, while a session started inside the period credited its whole rollup
to every author who wrote in it. Peon's own
`apps/peon/docs/token-usage-analytics.md` holds the canonical buckets and the
`exact`/`estimated`/`mixed`/`missing` quality rule.

## Codex runs only on the app-server driver

Codex execution uses only the native `codex-app-server` driver. The former
`codex exec --json` runtime and its selectable provider were removed. Persisted
`agent: "codex"` transcripts remain readable but **cannot be resumed**, because
their conversation identity is not compatible with app-server threads.
