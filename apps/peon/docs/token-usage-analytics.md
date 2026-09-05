# Canonical token-usage analytics

Peon owns provider-specific normalization. Overseer and clients consume canonical
values; they must not repeat provider arithmetic.

## Mutually exclusive buckets

Semantics version 1 retains these buckets:

- `uncachedInputTokens`: ordinary input, excluding cache reads and writes.
- `cachedInputTokens`: cache reads.
- `cacheWriteInputTokens`: cache creation, when exposed.
- `outputTokens`: all reported generated tokens, including reasoning.
- `processedTokens`: the sum of the four buckets above.

Claude reports input, cache reads and cache writes separately. Codex includes
cache reads and any exposed writes inside input: ordinary input is input minus
both cache categories, and processed usage is input plus output. Reasoning is
an output subset, never added again. Missing cache fields are not proof of zero:
`cacheBreakdownComplete` controls whether clients can show cache efficiency.

The legacy `totalTokens` alias equals processedTokens. Aggregate `inputTokens`
and `totalInputTokens` now mean canonical ordinary input; persisted
SessionUsage.inputTokens remains the provider's original convention.
Cost is not a token-equivalence score or authoritative subscription billing.

## Driver collection

### Codex app-server

Each active thread usage notification contains cumulative counters and a
`last` request snapshot. The driver accumulates cumulative deltas, not the final
request alone. The first active-turn notification contributes only `last`, so
resumed/forked history is not charged again. Repeated cumulative snapshots are
ignored. A reset or missing cumulative counter retains a conservative lower
bound and marks capture partial. Cache writes and reasoning are retained when
the installed transport exposes them.

Counters are scoped to the observed native thread. A collaboration tool call
downgrades capture to partial: inclusion of native child-thread work is not
guaranteed, and we do not guess by adding potentially overlapping counters.
Independent Peon-managed child sessions retain their own usage.

### Claude Code

Peon invokes one single-shot CLI process per invocation, including resumes.
The result's modelUsage is mapped into numeric per-model counters and summed
instead of the main-loop-only usage. The two must never be added together.
A result without modelUsage is labelled partial. Incomplete model maps are
also partial. Cost remains the CLI's estimate.

During execution, assistant message IDs deduplicate input/cache observations.
Placeholder assistant output counts and native subagent assistant messages are
excluded from this recovery path. These snapshots preserve a main-loop input
lower bound on cancellation/crash. Final modelUsage supersedes them. Zeroed
crash results or terminal results without usage retain observed partial usage.
This contract does not apply to Claude's streaming-input cumulative results;
that mode is not used by this driver.

## Durable invocation ledger and attribution

Numeric snapshots are canonical system/subtype=usage transcript events. Peon's
harness stamps usage_session_id, usage_run_id and usage_author; provider data
cannot choose these identities. Each snapshot is a replacement total for that
invocation. The harness updates the persisted summary from the invocation's
pre-run base, so neither repeated snapshots nor the final result double-count.

Analytics selects the latest snapshot/result per invocation. A branch excludes
events owned by its source session. Identified ledger events remain usable
when a summary write is missing; their totals are not capped by a stale rollup.
Legacy unowned results retain the historical summary-budget reconciliation.
Unexplained rollup amounts are attributed to the initiator at session start,
marked estimated. Historical files are never destructively rewritten.

Usage is dated at the latest invocation snapshot/result, not at every underlying
API request. This is an explicit limitation for a single long invocation that
crosses midnight. Attribution identifies the invoking author; native steering
within that invocation does not establish a separately billable user turn.

Stats and analytics now share the same UTC period boundaries and aggregation.
The web dashboard pins breakdown requests to the headline's exact from/to
window. Session counts, outcomes and wall duration still describe sessions
started in the window; token usage and invocation runtime follow the ledger.
Prompt counts describe prompt timestamps. These are distinct metrics.

Model rows follow reported per-model usage. Concurrent runtime has no trustworthy
per-model split: any unallocated duration/cost is retained in an unknown bucket,
not multiplied across models.

## Quality and presentation

- `reported`: the supported driver supplied its normal terminal counters;
  this does not promise complete account-wide billing.
- `partial`: recovery, missing counters, reset or unsupported tree scope.
- `legacy`: historical data without the new collection provenance.

`usagePartialTurns` and `usageLegacyTurns` expose capture limitations.
Attribution quality (exact/estimated/mixed/missing) is separate from capture
quality. Session coverage means sessions with any readable usage, not percentage
of all tokens successfully captured. Null cost/output fields remain unknown in
the persisted usage record.

Show processed tokens, ordinary input, cache reads/writes and output with a
scope explanation. Cache efficiency is cache reads divided by all input, only
when the breakdown is known. Model cards show provider share, composition,
reasoning subset where reported and capture quality. Account-limit probes are
separate; their availability never determines whether recorded usage exists.

## Verification and sources

Regression tests cover multi-step totals, replay, resume history, counter resets,
missing counters, Claude model maps, message-ID deduplication, cancellation,
persisted identities, branches, stale rollups, actual models, UTC windows and
headline/breakdown equality. No live paid model calls are required.

Official references checked for the implementation:

- [OpenAI app-server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)
- [Claude usage accounting](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- [Claude caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
