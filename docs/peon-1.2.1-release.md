# Peon 1.2.1 preparation

Scope: `@rnm-dev/peon@1.2.1`; npm currently serves 1.2.0. Preparation does not
publish npm or create the immutable `peon-v1.2.1` tag.

## Changes

- Claude login confirmation now tolerates a briefly stale credential store by
  retrying `auth status --json` within the existing bounded verification window.
  A genuine failed sign-in still terminates after four probes or ten seconds.
- When Codex cannot project a paginated fork because its durable rollout shrank,
  Peon resumes the native thread with its existing MCP bindings. This recovery
  applies only to the internal fork used to refresh bindings; an explicit user
  branch still requires a real provider fork.
- Web and Flutter recognize the same newer Codex thread-store failure when an
  older Peon returns it, so the operator can continue in a new session.

This is a compatible patch release. It changes bounded failure recovery only;
wire contracts and persisted Peon state are unchanged.

## Gates

Preparation passed on 2026-10-08. Peon typecheck and compile passed. The
concurrent release suite passed 637 tests with two expected real-provider login
skips; five process/socket timing tests missed their deadlines under load, then
all three affected files passed serially (32 passed, two expected skips).
Focused provider-login and Codex driver coverage passed 26 tests with the same
two skips. Web verification passed all 525 tests and its production build;
the focused Flutter continuation tests passed 2/2.

The exact archive contains 172 files, is 1,309,044 bytes, bundles protocol
1.0.0, and contains neither application source nor tests. A clean-prefix global
install, installed-manifest check and `peon --help` smoke passed. SHA-256:
`510b329b495288a86837216e1b2c70cf57b3ed394e7f41d85af08db827a30ba5`.

Publication remains a separate explicit action. Before publishing, confirm npm
still serves 1.2.0, tag the clean candidate `peon-v1.2.1`, publish the exact
verified archive, and verify a clean registry installation.
