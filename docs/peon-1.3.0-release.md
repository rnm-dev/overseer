# Peon 1.3.0 preparation

Scope: `@rnm-dev/peon@1.3.0`; npm currently serves 1.2.1. Preparation does not
publish npm or create the immutable `peon-v1.3.0` tag.

## Changes

- Peon advertises `armory-package-operations-v1` and exposes package
  compatibility preflight, bounded self-diagnosis and safe process-lifetime
  usage counters.
- Armory packages can be explicitly drained or restarted, and project package
  assignments can be reloaded through durable, package-locked operations.
- Graceful drain now refuses new turn bindings before waiting for existing
  immutable turn leases and MCP calls, preventing new work from extending an
  update, uninstall, restart or reload indefinitely.
- Overseer proxies the new Fleet HTTP routes and reconstructs only bounded,
  allowlisted responses across the trust boundary.

This is a compatible minor release. It adds a capability and routes without
changing existing capability contracts or persisted Peon state. Usage counters
are deliberately process-lifetime telemetry and reset on daemon restart.

## Gates

Preparation passed on 2026-10-09. Typecheck, the architecture import guard,
compile and 13 focused capability/runtime/protocol tests passed. The concurrent
full suite passed 642 tests with two expected real-provider skips; five tmux/TTY
process tests missed their deadlines under load. Those affected files plus the
focused Armory set then passed serially: 25 passed, two expected skips.

The exact archive contains 174 files, is 1,312,931 bytes, bundles protocol
1.0.0, and contains neither application source nor tests. A clean-prefix global
install, installed-manifest check and `peon --help` smoke passed. SHA-256:
`38e329072af095c741f1e83e06b735fb8d3776f78609d8dadd90ad3246daaffe`.

Publication remains a separate explicit action. Before publishing, confirm npm
still serves 1.2.1, tag the clean candidate `peon-v1.3.0`, publish the exact
verified archive and verify a clean registry installation.
