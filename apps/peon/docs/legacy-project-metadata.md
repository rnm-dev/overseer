## Overview

Peon is a local Node.js/TypeScript service that runs and supervises unattended Claude Code and Codex sessions. It provides a daemon/control API, browser dashboard, CLI, durable transcripts, projects/integrations, Overseer fleet support, and Armory MCP packages. Sessions are created explicitly; Heroboard polling only refreshes project catalogs.

## Code map

- `src/daemon/`: control API (port 4570), sessions, settings, auth, integrations, MCP, Armory, updates, and Overseer.
- `src/dashboard/server.ts`, `src/dashboard/public/`: dashboard (port 4571); public JSX is browser-compiled and served directly.
- `src/cli/`: CLI, lifecycle/configuration, systemd generation, and updates.
- `src/daemon/agents/`: provider-specific adapters; other code consumes normalized events.
- `src/daemon/plugins/`: integrations, including built-in Heroboard.
- `src/daemon/armory/`: optional MCP package lifecycle/runtime.
- `dist/`: committed production output used by global installs; never edit it manually.

## Critical behavior

Sessions have durable summaries and JSONL transcripts. Project documentation under `docs/` is the durable project context; repository instruction files must not duplicate it. Before restarting or killing the daemon, check the sessions endpoint for `running` sessions—daemon `idle`/`paused` is not sufficient.

MCP access is scoped per session and loopback-only under `/mcp`. Armory bindings appear only when healthy and enabled. For Armory contract/storage changes, read `docs/armory-v1-contracts.md` and relevant `armory*.test.ts` tests.

For Overseer/fleet API changes, read `PROTOCOL.md` and preserve HTTP error codes, idempotency, enrollment, SSE, and event sequencing. File transfer remains disabled unless `fileTransferRoot` is configured and paths stay beneath it.

## Security and state

Servers bind to `127.0.0.1` by default. Loopback, including SSH/VPN forwarding, is trusted as admin traffic. Remote dashboard auth requires matching hostnames for `publicControlUrl` and `publicDashboardUrl`; bind changes require restart. Never print or commit tokens, credentials, pairing phrases, or auth-session data.

There is no database, Docker, or accessory service. Config defaults to `~/.config/.peon`; state to `~/.local/state/.peon` (respecting XDG overrides). Prefer API/CLI updates; direct file edits may require restart.

## Development and delivery

Repository: `/Users/viktorten/Projects/peon`, branch `main`, remote `git@github.com:rnm-dev/peon.git`. Development runs via `npm run dev`; do not start another instance on ports 4570/4571 or against the same state. Daemon source edits and source-checkout deployments do not auto-restart the dev daemon. After completing work that changes daemon code, check that no sessions are `running`, then stop and rerun `npm run dev` for the changes to take effect. Dashboard server changes auto-restart; dashboard public files only require browser reload. This macOS checkout has no `systemctl`.

Checks: `npm run typecheck`, `npm test`, `npm run compile`. After any `src/` change, run `npm run compile` and include regenerated `dist/`. Keep the script named `compile`; never add npm `prepare`, `prepack`, install lifecycle, or `build` scripts. Global installs rely on committed JavaScript.

Preserve unrelated worktree changes. Never reset or overwrite them. Ordinary commits stay task-scoped. If asked to push without narrower scope, commit the entire worktree and push the current branch directly; do not open a PR unless requested.

## Task tracking

Track substantive Peon work in Heroboard project `OVSR`: create a task before starting, choose the appropriate type (`feature`, `bug`, or `chore`), assign it to yourself, move it through appropriate statuses, and finish in a done status when fully complete. Small tasks and routine chores such as log checks do not require a task.

## Deployment shorthand

When the user says `деплой`, perform the complete release flow: bump the project version; update the changelog when there are user-visible or noteworthy changes (recommended); commit and push the current branch; create the matching git tag and push it; then deploy. Treat `деплой` as authorization for all of these release steps.
