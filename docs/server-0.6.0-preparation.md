# Overseer 0.6.0 preparation

This prepares the combined server/web Docker image using the
[release procedure](releasing.md). Publication and production deployment are
separate steps.

## Upgrade notes

- Pin sessions from the session-list context menu. Pins persist per account,
  appear first, and use a small filled indicator at the right of the row.
- Open project folders update from Peon filesystem notifications through the
  workspace socket. This requires a Peon advertising `project-directory-watch-v1`.
- Model choices come from the installed agent CLI catalog. Web effort selectors
  show a concrete selection and send it with the message.
- Human messages have more vertical space. Participant messages share the
  regular user-message layout and right alignment.
- The release also includes consolidated automation-token and provider-login
  work; review the [automation API](automation-api.md) and
  [provider login](agent-provider-login.md) before enabling those features.

## Schema and rollback

Compared with 0.5.0, migrations 044–046 add automation tokens and personal
session pins. Migration 045 is retained for development-history compatibility;
046 removes its temporary message-pin table. No 0.5.0 table is dropped or
changed incompatibly, so reverting to the 0.5.0 image remains possible.
Development builds that used message pins lose those temporary pins.

## Verification scope

The root verifier includes desktop Rust and Flutter workspaces beyond the
Docker image. This environment has no `cargo` or Flutter SDK. Record those
unavailable checks explicitly rather than representing full verification as
passed. The Docker image must separately pass server/web tests and compilation,
then boot against disposable PostgreSQL, return version 0.6.0 at `/healthz`,
and reject a foreign Host with 421.

## Publication — 8 October 2026

Published `rnmdev/overseer:0.6.0`, commit tag
`ca35961c1d64d1f71dd7259530729809f25e151c`, and `latest` to Docker Hub.
Registry inspection confirms 0.6.0 and latest share manifest digest
`sha256:069d6fc228d7a7b824d0e39252f7d75803d9195baea2891ff6304ed38d9f462c`.
The source tag `server-v0.6.0` is pushed.

Server (431) and web (525) tests, available workspace checks, and the Docker
build passed. The isolated PostgreSQL smoke test returned version 0.6.0,
foreign Host 421, SPA 200, and the expected migrated tables. Root verification
still exits 127 on missing Cargo; Flutter verification was not reached.

[Public release notes](https://ovrseer.org/changelog/#v0-6-0) and the install
instructions are published from website commit `0bdff29`. Deployment copied
only the changed pages and their built assets, preserving unrelated homepage
work. Both public pages were fetched and verified. The Overseer application
itself was not deployed as part of this publication.
