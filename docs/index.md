## How to use this index

This page is injected into every session, so it stays a map, not a manual: one
line per topic, pointing at the page that owns it. Read the linked page before
working on that area — the details, bounds and reasons live there, and a
summary here would only drift from them.

Two rules apply to every task, so they are stated here rather than linked:

**Task tracking.** Use Heroboard for non-trivial implementation, fixes, design,
refactors, migrations, publishing and deployments. Reuse a matching task or
create one before work begins. Do not create tasks for read-only checks,
diagnostics without requested changes, or genuinely trivial edits. Do not create
tasks for preparing a working environment either — pulling or cleaning a
checkout, restarting a dev process, installing dependencies. That is part of
doing the work; if it matters to whoever picks it up, note it in the task that
needs it.

**Documentation.** Keep durable project knowledge in `docs/`, in the page that
owns the topic. There are no `CLAUDE.md` or `AGENTS.md` files in this
repository — that content lives here.

## Working on this codebase

- [the dev box](dev-box.md) — the checkout, the compose services, ports, nginx,
  secrets, everyday commands, and how the dev origin is served.
- [deploy runbook](deploy-runbook.md) — Kamal preparation, current production
  deployment, persistent-volume rules, cutover state and rollback.
- [architecture](architecture.md) — how the code itself is organised.
- [server design notes](server-design.md) — settled decisions, the robustness
  model and the roadmap.
- [monorepo](monorepo.md) — why Peon, server, web and the Flutter client share
  one repository, the layout and naming, and what is still to move.
- [client documentation](client/index.md) — the cross-platform Flutter client in
  `apps/client` (iOS, Android, macOS, Windows, Linux).
- [protocol contracts](protocol/index.md) — machine-readable wire contracts
  shared by more than one application.

## Sign-in and operators

- [sign-in methods](sign-in-methods.md) — GitHub OAuth, email/password and
  generic OIDC; every door is resolved once from the environment into
  `config.auth`, where a method is its settings or `null`.
- [email and password sign-in](password-auth.md) — the `OVERSEER_PASSWORD_AUTH`
  switch, scrypt hashing, and why every refusal is byte-identical.
- [mobile webview login](mobile-webview-login.md) — the mobile app signs in
  through a webview on the web login screen.

## Sessions

- [sessions, turns and their control plane](sessions-and-turns.md) — session
  control over Fleet HTTP, branching, queue and steering, model/effort pinning,
  usage attribution and the Codex app-server driver.
- [session catalog synchronization](session-list-sync.md) — the durable
  `session-catalog-v1` projection, running-state reconciliation and freshness.
- [transcript synchronization](transcript-sync.md) — history pages over Fleet
  HTTP and the `transcript-sync-v1` live tail.
- [composer ghost convergence](composer-ghost-convergence.md) — a sent message
  is a ghost owned by the composer, never an optimistic transcript row.
- [transcript scrolling](transcript-scrolling.md) — follow output only while the
  operator stands at the bottom.
- [operator-scoped recent sessions](operator-recent-sessions.md) — the Fleet list
  can attach the sessions the caller created or followed up on.
- [selected-text replies](selected-text-replies.md) — the durable `replyTo`
  object on Peon's authoritative user message.
- [audio focus](audio-focus.md) — session sounds play on exactly one client, the
  one the operator last picked up.

## Peons and the fleet

- [Peon is CLI-only](peon-cli-only.md) — no local dashboard or users; enrollment
  is `peon enroll` plus an operator-entered address and phrase.
- [daemon configuration](daemon-configuration.md) — owner-only reads and
  revision-fenced patches over Fleet HTTP.
- [Peon update channel](peon-update-channel.md) — checks, apply admission,
  approved release metadata and archive bytes.
- [Peon restart recovery](peon-restart-recovery.md) — the checklist when a Peon
  does not come back.
- [reverse runtime capabilities](runtime-capabilities.md) — the `runtime-state-v1`
  projection, and the bounded reads that go over Fleet HTTP instead.
- [reverse command gateway](reverse-command-gateway.md) — the one durable
  gateway for `reverse-command-v1`, and what deliberately bypasses it.
- [resource synchronization](resource-synchronization.md) — one identity,
  version, fencing and freshness model across catalog-like state.
- [remaining Peon HTTP control plane](remaining-peon-http-control-plane.md) — the
  2026-07-30 census of what is still direct HTTP/SSE, and where it is going.

## Projects, files and packages

- [project Fleet HTTP control plane](project-reverse-commands.md) — catalog,
  create, settings, documentation, quick links, update and delete.
- [showing a file](file-viewing.md) — one `FileSource`, one renderer, and one
  authenticated byte plane over mesh.
- [Armory over Fleet HTTP](armory-reverse.md) — inventory, settings and every
  lifecycle mutation, with Peon's locks and installer still authoritative.
- [Armory profiles and project packages](armory-project-packages.md) — the next
  contract: typed profiles and immutable-project assignments.
- [managed plugin inquiries](managed-plugin-inquiries.md) — the
  `managed-plugin-inquiry-v1` operator confirmation flow.

## Product surfaces

- [theme catalog](themes.md) — one declarative source of truth for theme
  packages, feeding both the Flutter catalog and generated CSS.
- [voice input](voice-input.md) — pluggable speech-to-text for the composer,
  Groq first; configured in both environments, no client records audio yet.
- [push notifications](push-notifications.md) — one signal, Expo and FCM HTTP v1
  delivery, and the dormant iOS Live Activity surface.

## Security and conformance

- [trusted client IPs](proxy-trust.md) — abuse limits and device attribution use
  the socket peer unless every hop is trusted; includes the unresolved
  production ingress finding.
- [reverse fleet security threat model](reverse-fleet-security.md) — assets,
  abuse cases, the stable executable suite and open findings gating the cutover.
- [protocol conformance and failure-injection harness](protocol-conformance-harness.md) —
  golden frames, the capability matrix and deterministic fault injection.

The reverse-control cutover is governed by four pages that are gates rather than
contracts: [rollout controls](reverse-rollout.md),
[reverse-only fleet mode](reverse-only-peon.md),
[callback addressing](callback-addressing.md) and the
[legacy callback retirement gate](legacy-callback-retirement.md). Nothing in
them is a default yet; read the gate before changing one.

## Not in this repository

The instructions site is a separate product in its own repository,
`git@github.com:rnm-dev/overseer-website.git`, checked out beside the monorepo
at `/rnm/overseer-website` with its own `README.md`, `DESIGN.md` and `PRD.md`.
Only the `site` dev service in `docker-compose.yml` remains here, building that
sibling checkout on 127.0.0.1:4582 behind https://dev.ovrseer.org. Production is
the apex `ovrseer.org` on Cloudflare Pages (project `ovrseer-site`, direct
upload); as of 2026-08-12 the artifact and the DNS decision are ready but the
Pages project does not exist yet — see OVSR-454.
