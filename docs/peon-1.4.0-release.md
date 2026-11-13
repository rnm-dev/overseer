# Peon 1.4.0 preparation

Scope: `@rnm-dev/peon@1.4.0`; npm currently serves 1.3.0. Preparation does not
publish npm or create the immutable `peon-v1.4.0` tag.

## Changes

- **Session sign-offs** (OVSR-610): trigger-origin sessions record decisions a
  person must make, end their turn and get the decision back as a queued
  follow-up. Peon advertises `session-signoffs-v1`, serves the sign-off Fleet
  HTTP routes, publishes `signoff-catalog-v1` and closes interrupted
  executions on restart. Sessions carry `origin`, `trigger` and
  `settledState`. The `signoffsEnabled` setting (default on) turns proposing
  off. See [session sign-offs](signoffs.md).
- **Triggers** (OVSR-611/613/614): automation sessions are trigger-origin and
  external systems can drive sessions that ask people for decisions; see
  [triggers](triggers.md).
- **Message threads**: private anchored discussion on a session event, with
  linked agent sessions, advertised as a capability.
- **Turns always end**: a silent provider is stopped after 15 minutes, harness
  interrupts escalate to SIGKILL behind a deadline, and a background process
  holding the CLI's stdout no longer keeps a crashed turn running.
- **Queue fixes** (OVSR-591, OVSR-603): a queued turn waits for the finished
  Claude process to exit before resuming; a stalled queue is retried and the
  operator told; enqueue is idempotent by `commandId`; harness stops are shown
  in the chat; a queued model/effort override is no longer finalized as
  orphaned.
- **Drivers** (OVSR-600, OVSR-598): Claude Code and Codex are swappable driver
  modules; Claude subagent events keep `parent_tool_use_id`.
- **Sync**: session catalog events are no longer coalesced (no forced
  resnapshots); the transcript cache that could hide history after a restart
  is gone.
- Dead reverse-command, session-warning and socket-pool code is removed. No
  Overseer server ever negotiated those capabilities.

The committed `dist/daemon/agents/spawnJsonAgent.js` on master was missing the
stdout-drain and kill-escalation half of the "turns always end" change; this
preparation recompiles it, so 1.4.0 ships the complete fix.

This is a compatible minor release. It adds capabilities, routes, a setting
and optional session fields. Older Overseer servers ignore capabilities they
do not negotiate. Going back to 1.3.0 keeps sessions readable; the
`signoffs/` state directory and the new session fields are simply ignored.

## Gates

Preparation passed on 2026-11-13 from a clean worktree of master `0b84711c`
plus the version bump. `npm ci`, typecheck, the architecture import guard and
compile passed. The concurrent full suite ran 660 tests: 652 passed, two
expected real-provider skips, and six tmux/TTY process tests missed their
deadlines under load. Their two files (`claudeTmux`, `providerLogin`) then
passed serially: 12 passed, two expected skips.

The exact archive `rnm-dev-peon-1.4.0.tgz` contains 178 files, is 1,320,486
bytes, bundles protocol 1.0.0, and contains neither application source nor
tests. A clean-prefix global install, installed-manifest check (1.4.0,
protocol 1.0.0) and `peon --help` smoke passed. SHA-256:
`3eeb30e3a595a7118c662f0b11760c6f994fc703fbf05cfcdff829d63763c447`.

Publication remains a separate explicit action. Before publishing, confirm npm
still serves 1.3.0, tag the clean candidate `peon-v1.4.0`, publish the exact
verified archive and verify a clean registry installation.
