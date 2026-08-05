# Canonical token-usage analytics

Peon is the normalization authority for token usage. Overseer aggregates Peon's canonical
values, and web/mobile clients display them without implementing provider-specific formulas.

## Version 1 schema

Every available canonical usage value has `semanticsVersion: 1` and mutually exclusive buckets:

- `uncachedInputTokens`
- `cachedInputTokens`
- `cacheWriteInputTokens`
- `outputTokens`
- `processedTokens`

The invariant is:

```text
processedTokens =
  uncachedInputTokens +
  cachedInputTokens +
  cacheWriteInputTokens +
  outputTokens
```

Provider formulas:

- Claude Code reports uncached input, cache creation, and cache reads separately. Its processed
  total is raw input + cache creation + cache read + output.
- Codex and Codex app-server report cached input as a subset of raw input. Their processed total
  is raw input + output. Canonically, uncached input is raw input minus cached input, cache-write
  input is zero, and cached input remains visible as its own bucket.

Provider-reported raw usage and cost remain available for compatibility and diagnostics. Cost is
not a token-equivalence score: provider tokenizers and pricing differ.

## Coverage and attribution

Missing or malformed provider usage is unavailable, not zero. Peon exposes session coverage as
`sessionsWithUsage`, `sessionsMissingUsage`, and `usageCoveragePercent`, plus rejection counts
such as `missing_token_usage`, `invalid_token_usage`, and `overlapping_codex_cache`.

Historical session files are normalized when read and are never destructively rewritten.

Usage is attributed per turn. Every invocation ends with one `result` event carrying that
invocation's usage — the same payload the session record folds into its rollup — so analytics
replays the transcript, attributes each result event to the author of the user message preceding
it, and dates it by the event's Peon-stamped `createdAt`. The session record stays authoritative
and its rollup is the budget: turns are counted newest-first and only while the record can still
account for them, and whatever the rollup holds beyond the transcript's result events is
attributed as one remainder to the session initiator at `startedAt` — which is where a session
with a pruned, absent, or pre-dating transcript lands whole. The budget is what keeps a branch
honest: it inherits a verbatim copy of its source's transcript, result events included, while
starting with no usage of its own, so the inherited turns stay charged to the session that ran
them. Rows therefore sum to the period's totals, and a
follow-up sent today into a session started last week is charged to today and to its own author.

Attribution quality reads that reconciliation: `exact` when every counted token came from the
turn that spent it, `estimated` when a session-start remainder was involved, `mixed` when some
session in the aggregate has no readable usage at all, and `missing` when none has. The counts
behind it are `usageTurnsAttributed` and `usageSessionsEstimated`.

Period analytics therefore use three explicit time authorities, named in the response's
`attribution` block. `promptCount` follows the persisted `user_message.createdAt` (falling back
to the session start only for undated historical turns); tokens, cost, and provider duration
follow `transcript_result_created_at`; session count, turns, wall duration, outcomes, and storage
follow the session's `startedAt` and are still repeated per participating author when grouped by
user. `/stats` remains a session-start summary of the sessions started in its period and does not
share the per-turn window.

The analytics response carries Peon's stable `peonId`, the semantics version, canonical buckets,
processed tokens, coverage, and attribution quality. This lets Overseer ingest/replay records
idempotently without reproducing Claude or Codex arithmetic. Unknown future semantics versions
must be rejected or retained as unavailable by the consumer rather than guessed.

## Rollout and compatibility

Roll out in this order:

1. Peon emits canonical version 1 values while retaining legacy `totalTokens` as an alias for
   `processedTokens` and preserving all raw usage fields.
2. Overseer ingests the versioned values and treats older Peons as estimated or missing.
3. Web and mobile switch labels to “Processed tokens” and consume backend values only.
4. Remove compatibility aliases only in a separately versioned API change.

Golden tests cover cached and uncached Codex drivers, Claude cache reads/writes, missing and
malformed usage, historical session rollups, and equality between Peon stats and analytics.
