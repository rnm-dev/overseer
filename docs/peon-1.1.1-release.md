# Peon 1.1.1 preparation

Scope: `@rnm-dev/peon@1.1.1`; npm currently serves 1.1.0. Preparation does not
publish npm or create the immutable `peon-v1.1.1` tag.

## Change

Claude Code emits content-free `system:thinking_tokens` heartbeats every few
seconds while the model thinks. Peon no longer persists or returns those rows,
so they cannot crowd useful conversation out of the newest transcript page.
Existing Claude transcripts are cleaned on read. Transcript index version 2
forces an old index to rebuild once so its heartbeat event IDs do not survive.

This is a compatible patch. It changes transcript normalization and derived
indexes only; session, Fleet and client wire contracts are unchanged.

## Gates

Preparation passed on 2026-09-25. Typecheck and compile passed. The concurrent
suite passed 614 tests with two expected provider-login skips; two existing
terminal-harness timing tests failed under load and both passed in the focused
serial rerun (7 passed, 2 expected skips). The Claude normalization and
transcript-index regression tests passed.

The exact archive contains 167 files, is 1,301,538 bytes, bundles protocol
1.0.0, and contains neither source, tests nor the retired workflow runtime. A
clean-prefix global install and `peon --help` smoke passed. SHA-256:
`38bbe0050efa3cc3f969f6c1ce8bd0de466ac5dbb951e0b4a11904ad25b8c76e`.

The release candidate also removes an accidentally committed absolute
`apps/peon/node_modules` symlink from the preceding fix commit. Dependencies
remain declared by the manifest; prepack stages the bundled protocol into its
normal ignored working directory.

Publication remains a separate explicit action. Before publishing, confirm npm
still serves 1.1.0, tag the clean candidate `peon-v1.1.1`, publish the exact
archive above, and verify a registry installation.
