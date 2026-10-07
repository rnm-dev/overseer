# Changelog

Notable changes to `@rnm-dev/peon` are recorded here. Versions follow Semantic
Versioning, and release tags use the `peon-v<version>` form.

## [0.12.11] - 2026-09-01

### Fixed

- Make Stop idempotent and reconcile stale live-run registries attached to
  terminal sessions, so activity counts and cancellation converge without a
  daemon restart.
- Preserve bounded durable Steer receipts, allowing a request whose response
  was lost to be retried without delivering the queued prompt twice.
- Retry one ambiguous Overseer-to-Peon gateway failure for Stop and Steer.

## [0.12.10] - 2026-08-25

### Added

- Support structured selected-text replies with the optional `replyTo` object.
  Peon validates the source event and selected text, persists the metadata on
  the authoritative user message, and advertises the
  `selected-text-replies-v1` capability.
- Preserve selected-text reply metadata through follow-ups, queueing, queue
  edits, steering, retries, restart recovery, branching, pagination and live
  transcript publication.
- Assemble provider-neutral quoted context for both Codex app-server and
  Claude Code while keeping the operator's prompt separate in the transcript.

### Compatibility

- Requests without `replyTo` and transcripts created by older Peon versions
  remain supported. Older clients hide the reply action until the capability
  is advertised.

## [0.12.9] - 2026-08-20

### Fixed

- Route delegated work through child sessions so agent delegation keeps the
  correct session ownership and prompt context.
- Preserve provider-specific default models in the model catalog and inherit a
  saved reasoning effort only when it belongs to the active provider and model.
- Handle an explicit `null` default model correctly when validating a daemon's
  default reasoning effort.

### Changed

- Simplify transcript synchronization around Fleet HTTP history and SSE tails,
  removing the retired transcript WebSocket channel, publication pipeline,
  acknowledgements, and observability code.
- Remove the unused repository URL runtime helper and its obsolete test-suite
  entry.

[0.12.11]: https://github.com/rnm-dev/overseer/compare/peon-v0.12.10...peon-v0.12.11
[0.12.10]: https://github.com/rnm-dev/overseer/compare/peon-v0.12.9...peon-v0.12.10
[0.12.9]: https://github.com/rnm-dev/overseer/compare/peon-v0.12.8...peon-v0.12.9
