# Peon 1.0.3 preparation

Scope: `@rnm-dev/peon@1.0.3`; npm currently serves 1.0.2. This patch gives
history-dependent Codex `thread/resume`, `thread/fork`, and `thread/read` RPCs
five minutes instead of the generic 30-second timeout. Ordinary app-server RPCs
retain the shorter bound.

The abandoned Armory polling implementation is absent. Existing package and
session contracts remain compatible. Preparation does not publish npm or create
the immutable `peon-v1.0.3` tag.

Typecheck, compile, Armory-focused tests, and the Codex driver suite passed. The
full concurrent suite passed 612 tests with two expected skips; two existing
timing-sensitive tests failed under load and both passed immediately in a
focused rerun. The tarball contains 167 files and no workflow runtime, source,
or tests. SHA-256:
`8820d5d51c711ae698c1be3ed5fdf32afe5532b4608fea0cd06601612830b9fd`.
