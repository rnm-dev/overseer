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
- [releasing the server image](releasing.md) — what a version number promises,
  why the tags are immutable, and the steps from a bump to a published image.
- [0.6.0 image preparation](server-0.6.0-preparation.md) — upgrade notes, schema compatibility and verification scope.
- [configuration](configuration.md) — every environment variable with its
  default, what is deliberately not a variable, and the two values whose
  absence stops the boot. The install template is `deploy/docker-compose.yml`.
- [architecture](architecture.md) — how the code itself is organised.
- [server design notes](server-design.md) — the locked decisions, the
  robustness model and why the projections exist.
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
  switch, scrypt hashing, why every refusal is byte-identical, and the
  `setPassword` CLI that recovers a forgotten password.
- [mobile webview login](mobile-webview-login.md) — the mobile app signs in
  through a webview on the web login screen.

## Sessions

- [sessions, turns and their control plane](sessions-and-turns.md) — session
  control over Fleet HTTP, branching, queue and steering, model/effort pinning,
  usage attribution and the Codex app-server driver.
- [agent model catalog discovery](agent-model-catalog.md) — Codex app-server and
  Claude SDK model/effort discovery, caching, validation and fallback.
- [session catalog synchronization](session-list-sync.md) — the durable
  `session-catalog-v1` projection, running-state reconciliation and freshness.
- [transcript history and live tail](transcript-sync.md) — HTTP pagination plus
  Peon's committed Fleet HTTP SSE relayed through the client's existing workspace
  WebSocket; there is no transcript projection or ACK protocol.
- [composer ghost convergence](composer-ghost-convergence.md) — a sent message
  is a ghost owned by the composer, never an optimistic transcript row.
- [huge pastes become attachments](composer-pasted-text.md) — a pasted wall of
  text is captured as a `.txt` attachment instead of filling the composer.
- [transcript scrolling](transcript-scrolling.md) — follow output only while the
  operator stands at the bottom.
- [operator-scoped recent sessions](operator-recent-sessions.md) — the Fleet list
  can attach the sessions the caller created or followed up on.
- [session sharing](session-sharing.md) — capability invitations, scoped guest
  participants, limits, revocation and presence on the canonical session.
- [selected-text replies](selected-text-replies.md) — the durable `replyTo`
  object on Peon's authoritative user message.
- [context-only participant messages](context-only-participant-messages.md) —
  durable human conversation and mentions that reach the next invoked turn
  without waking the agent themselves.
- [audio focus](audio-focus.md) — session sounds play on exactly one client, the
  one the operator last picked up.
- [automation API](automation-api.md) — bearer tokens scoped to a Peon and
  optionally a project, for machine callers that start sessions, follow up,
  attach files and poll status without a browser session.

- [Session pins](session-pins.md) — personal session pinning and web list ordering.

## Peons and the fleet

- [Peon Desktop for Windows](peon-desktop.md) — the lean tray/controller,
  current implementation status, native runtime gates and installer build.
- [Peon is CLI-only](peon-cli-only.md) — no local dashboard or users; enrollment
  is `peon enroll` plus an operator-entered address and phrase.
- [daemon configuration](daemon-configuration.md) — owner-only reads and
  revision-fenced patches over Fleet HTTP.
- [Peon update channel](peon-update-channel.md) — owner-authorized check,
  apply and status over Fleet HTTP; package metadata and bytes come from npm.
- [Peon 1.2.1 preparation](peon-1.2.1-release.md) — Claude login stability,
  Codex continuation recovery and publication gates.
- [agent CLI updates](agent-cli-updates.md) — the driver-owned updater contract,
  supported installation ownership and safe refusal rules for Codex and Claude.
- [agent provider login](agent-provider-login.md) — separate Claude and Codex
  login APIs, polling, ownership, expiration, and process cleanup.
- [the account Peon runs as](peon-user-account.md) — why it is a regular login
  user, systemd linger, the macOS login caveat, and the environment the
  generated unit freezes at install time.
- [Codex rollout files are load-bearing](codex-rollout-retention.md) — a fork
  holds only what came after it, so pruning a parent kills the chain; the safe
  cleanup and the two incidents that prove it.
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
- [Peon resource usage](peon-resource-usage.md) — bounded CPU, memory and disk snapshots plus demand-scoped live monitoring.
- [project administration](project-administration.md) — creation by members,
  project administrators and scoped member access.
- [live directory updates](project-directory-watch.md) — demand-driven Peon filesystem watches relayed over the workspace WebSocket.
- [showing a file](file-viewing.md) — one `FileSource`, one renderer, and one
  authenticated byte plane over mesh.
- [Armory over Fleet HTTP](armory-reverse.md) — inventory, settings and every
  lifecycle mutation, with Peon's locks and installer still authoritative.
- [Armory profiles and project packages](armory-project-packages.md) — the next
  contract: typed profiles and immutable-project assignments.
- [Armory package runtime operations](armory-package-operations.md) — compatibility preflight, self-test, safe usage counters, restart/reload and graceful drain.
- [source-triggered workflows](armory-workflows.md) — source systems create and monitor Peon sessions through Overseer; no package polling.
- [managed plugin inquiries](managed-plugin-inquiries.md) — the
  `managed-plugin-inquiry-v1` operator confirmation flow.

## Product surfaces

- [theme catalog](themes.md) — one declarative source of truth for theme
  packages, feeding both the Flutter catalog and generated CSS.
- [voice input](voice-input.md) — pluggable speech-to-text for the composer,
  Groq first; configured in both environments, recorded natively by the mobile
  client, still without a mic in the web composer.
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

The reverse-control cutover is governed by three pages that are gates rather than
contracts: [rollout controls](reverse-rollout.md),
[callback addressing](callback-addressing.md) and the
[legacy callback retirement gate](legacy-callback-retirement.md). Nothing in
them is a default yet; read the gate before changing one.

## Not in this repository

The instructions site is a separate product in its own repository,
`git@github.com:rnm-dev/overseer-website.git`, checked out beside the monorepo
at `/rnm/overseer-website` with its own `README.md`, `DESIGN.md` and `PRD.md`.
Only the `site` dev service in `docker-compose.yml` remains here, building that
sibling checkout on 127.0.0.1:4582 behind https://dev.ovrseer.org. Production is
the apex https://ovrseer.org, live since 2026-08-20: nginx on nid-01 serving
`/var/www/ovrseer.org` behind Cloudflare, deployed by rsyncing a local
`npm run build`. Cloudflare Pages was the earlier plan and was dropped — the
deploy, the TLS decision and the headers that `public/_headers` no longer
delivers are all in that repository's `README.md`.
