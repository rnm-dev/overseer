# Codex rollout files are load-bearing

Every Codex conversation on a Peon box is a **chain of rollout files** under
`~/.codex/sessions/YYYY/MM/DD/`. Deleting any link kills the conversation
permanently. This page exists because a well-meaning disk cleanup did exactly
that on 2026-08-17 and again on 2026-09-10, taking 81 Peon sessions with it.

## Why the chain exists

Peon's Codex driver forks the native thread on **every resumed turn that
carries MCP config** — see the comment above the `thread/fork` call in
`apps/peon/src/daemon/agents/codexAppServer.ts`. MCP bindings are immutable
turn leases, so a fork is how a follow-up gets this turn's exact MCP snapshot
while keeping the conversation. One long chat is therefore dozens of threads,
each with its own rollout file, linked by `forked_from_id`.

## Why a fork does not contain its parent

With `history_mode = 'paginated'` (the default in Codex 0.153.4) a fork rollout
starts at `forked_from_ordinal_exclusive` and holds **only the ordinals
produced after the fork point**. The parent file remains the sole copy of
everything before it. File size proves nothing about containment: in the
incident, child `01a085e2` was 19 MB and the parent `01a085da` it could not
live without was 1 MB.

`~/.codex/state_5.sqlite` (`threads.rollout_path`) and
`~/.codex/thread_history_1.sqlite` only record byte offsets into those files.
They keep the last turn's items, not the transcript — they cannot rebuild a
deleted rollout.

## What breaks, and how it looks

Remove an ancestor and every later turn fails in ~20 ms with:

```
Codex app-server thread/fork failed: invalid paginated history lineage
for <thread-id>: missing source rollout
```

In Overseer this reads as a hung session: messages send, nothing happens. The
session is not hung, it is unresumable. **There is no recovery** — the deleted
transcript is gone. Peon's own `~/.local/state/.peon/sessions/<id>.jsonl` still
holds the readable conversation for a human, but Codex cannot resume from it.
The only way forward is a new session in the same directory; work on disk is
untouched.

## Safe cleanup

`~/bin/prune-codex-forks.py` is the script that caused the incident. It is
disabled in place and must not be revived — its "a larger descendant contains
the parent" premise is false.

Use `~/bin/prune-codex-rollouts.py` instead. It deletes a rollout only when it
is a chain leaf no file forked from, is neither the `backendSessionId` of a
Peon session nor an ancestor of one, and is older than `--days` (default 30).
Dry run by default; `--apply` deletes. As of 2026-09-10 it frees almost
nothing, because `~/.codex` is 2.7 GB — when the dev box fills up, the space is
somewhere else. Look there before touching agent state; see
[the dev box](dev-box.md).

Deleting rollouts to reclaim disk is never worth it: the whole tree is a couple
of gigabytes and every file in it is someone's unfinished conversation.

Tracking: OVSR-552 covers the Peon side — a session whose chain is broken must
say so instead of accepting messages that die in 20 ms.
