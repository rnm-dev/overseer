# Changelog

Notable changes to `@rnm-dev/peon` are recorded here. Versions follow Semantic
Versioning, and release tags use the `peon-v<version>` form.

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

[0.12.9]: https://github.com/rnm-dev/overseer/compare/peon-v0.12.8...peon-v0.12.9
