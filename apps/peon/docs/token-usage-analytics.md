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
Historical usage is a session rollup, so user/project/time attribution is marked `estimated`.
An aggregate containing both available and missing usage is marked `mixed`; one with no available
usage is `missing`.

Period analytics use two explicit time authorities. `promptCount` follows the persisted
`user_message.createdAt` (falling back to the session start only for undated historical turns),
while session count, turns, usage, duration, outcomes, cost, and storage follow the session's
`startedAt`. Consequently, prompts made during the requested period in an older shared session
are counted without assigning that session's entire lifetime token rollup to the period.

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
