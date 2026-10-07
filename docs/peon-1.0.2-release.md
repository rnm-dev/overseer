# Peon 1.0.2 preparation

Scope: `@rnm-dev/peon@1.0.2`. The server/web remain 0.4.0 and the Flutter
client keeps its own release version. Preparing this release does not publish
to npm, create a release tag, deploy the server, or restart active daemons.

## Operator-facing changes

- Codex usage accumulates model requests rather than retaining only the final
  request. Duplicate cumulative updates and resumed/forked history are excluded.
- Claude accounting uses whole-tree per-model results when available. Input
  snapshots preserve a partial lower bound if the process is interrupted.
- Durable invocation identities keep partial usage through cancellation and
  transcript replay, without charging copied branch history again.
- Headline/provider stats and user/project analytics use the same UTC usage
  windows. Canonical input/cache categories no longer overlap.
- Web model cards show token composition, provider share, supported cache
  efficiency, reasoning subsets and capture-quality labels. Period controls
  wrap into separate touch targets on narrow screens.
- Provider-specific login APIs, polling and bounded terminal-session cleanup
  are included, along with driver-owned CLI updates and model discovery.
- Execution-limit settings and structured, resumable stop reasons are included.

The commit also includes the existing companion server/web/client changes in
the working tree, as requested. Installing only Peon does not deploy those UIs.

## Accuracy and compatibility

See the token accounting contract in `apps/peon/docs/token-usage-analytics.md`
for the full rules. Historical totals are not reconstructed or silently rewritten. They
may remain understated and are labelled legacy/partial. Native Codex child
thread inclusion is not guaranteed; collaboration downgrades capture to partial.
An invocation crossing midnight is dated at its latest snapshot/result, not
split into individual API requests. Reported tokens are not account-wide quota
or authoritative billing.

No database migration is introduced by the accounting change. Numeric
provenance fields are additive, and `totalTokens` remains the processed-total
alias. Aggregate input fields now represent ordinary input excluding cache.
Consumers that previously re-added Codex cache to input must use the canonical
buckets. Older daemons remain displayable, with unsupported details unavailable.

## Release gates

Preparation validation: the monorepo verification completed successfully,
including 607 Peon tests (605 passed, 2 existing skips), 12 serial Peon tests,
407 server tests, 477 web tests, protocol checks and 435 Flutter tests. Flutter
analysis reported no issues. The local Flutter SDK resolved several SDK-pinned
test dependencies differently from the incoming lockfile; that incidental
lockfile churn was reverted, preserving the upstream desktop OAuth/tooling
commits rather than shipping an unrelated dependency downgrade. Mobile release
validation must use the release toolchain and its committed dependency lock.

The npm dry-run contains 164 files, approximately 1.30 MB packed, and includes
the new accounting modules, login terminal worker and bundled protocol 1.0.0.
No npm publication or release tag was performed.

1. Run `npm run verify` on the combined tree: lint, architecture, workspace
   tests/builds and Flutter analysis/tests. Generated Peon `dist` is committed.
2. Run `npm pack --dry-run -w @rnm-dev/peon` and inspect the file manifest,
   including the bundled protocol and the new driver modules.
3. Commit and push the complete reviewed working tree. The public registry was
   checked during preparation and still listed 1.0.1.
4. Before publication, visually inspect stats at narrow and desktop widths.
   The browser connector was unavailable during preparation; component-render
   tests do not substitute for that visual sign-off.
5. On explicit publication approval, verify the tree is clean and the commit is
   intended, create the immutable `peon-v1.0.2` tag, and publish the package from
   that commit. Never replace an existing npm version or tag. Check the npm
   package/version and install smoke test before announcing availability.

The project requests Heroboard tracking, but no Heroboard connector was
available in this session. This page records the preparation and remaining
publication gates; it is not the public changelog.
