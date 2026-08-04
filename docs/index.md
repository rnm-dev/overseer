## Project information

Theme packages have one declarative source of truth on the Overseer server.
The public `/api/v1/themes` catalog feeds Flutter's validated cached ThemeData,
while `/api/v1/themes.css` is deterministically generated from the same
manifests for web; both clients retain only bounded fallbacks. The contract and
security limits are in [theme catalog](themes.md).

Peon is now a CLI-only managed daemon: its local dashboard, magic-link users
and login sessions have been removed, and all operator authentication and UI
belong to Overseer. The remaining local API is loopback-only for CLI use;
reverse sockets and authenticated legacy Fleet HTTP remain machine-facing.
The boundary and upgrade note are in [Peon is CLI-only](peon-cli-only.md).

Codex execution now uses only the native `codex-app-server` driver. The former
`codex exec --json` runtime and its selectable provider were removed; persisted
`agent: "codex"` transcripts remain readable but cannot be resumed because
their conversation identity is not compatible with app-server threads.

Managed Codex plugins use the durable `managed-plugin-inquiry-v1` operator
confirmation flow. Peon normalizes native plugin metadata, fences the inquiry
to the active session/turn/runtime generation, and invokes `plugin/install`
only after an authenticated explicit Install response; PostHog is the first
covered plugin, with no plugin-specific UI contract. The Fleet HTTP routes,
states, stable failures and redaction boundary are in [managed plugin
inquiries](managed-plugin-inquiries.md).

The cross-platform Flutter operator client now lives in `apps/client` (iOS,
Android, macOS, Windows and Linux). Its development and feature documentation
starts at [client documentation](client/index.md).

The mobile app signs in through a webview on the web login screen — see [mobile webview login](mobile-webview-login.md).

Sign-in is GitHub OAuth plus, where an instance asks for it, email and password. `OVERSEER_PASSWORD_AUTH=1` opens registration and sign-in together; it is on for dev and explicitly off in production, and clients read `GET /api/auth/methods` rather than assuming which doors exist. Passwords are scrypt-hashed in a nullable `users.password_hash` — NULL is every GitHub-created account, not an error — and the two identities converge on one row through the email `ensureUserFromGithub` already matches on. Every sign-in refusal is byte-identical whether the address is unknown, the password wrong, or the account GitHub-only. The switch, the routes and the hashing parameters are in [email and password sign-in](password-auth.md).

Runtime status, capacity, daemon revision, provider availability, models and
reasoning modes converge through the durable `runtime-state-v1` projection.
All explicit request/response runtime reads — including status/models, quota,
provider capability probes, fixed-period stats and filtered analytics — use
the direct authenticated Fleet HTTP API through mesh with no reverse-command
fallback. The projection, heartbeat and invalidation/events remain on the
control WebSocket; stored projection state is explicitly fresh, stale or
offline. The field classification, redaction and query bounds are in
[reverse runtime capabilities](runtime-capabilities.md).

Pluggable speech-to-text for the composer (Groq first, provider seam for open source): the server side is implemented — `POST /api/v1/voice/transcriptions` plus `GET /api/v1/voice/capabilities` — and stays disabled until `OVERSEER_VOICE` and a key are configured. Both dev and production are configured with the same Groq key and verified end to end (565 ms warm on dev, 775 ms through the public origin). They share a free-tier budget of 1000 requests/day and cannot see each other's spend, so it is split by `OVERSEER_VOICE_REQUESTS_PER_DAY`: 800 in production (`apps/server/config/deploy.yml`), 200 on dev. No client records audio yet. Configuration reference and the measured latencies are in [voice input](voice-input.md).

Push notifications fire on exactly one signal — a `session_attention` occurrence turning unread, meaning a turn the user initiated finished while they were not watching it — and deliver through Expo and, since 2026-07-27, FCM HTTP v1. Dev and production hold different Firebase projects (`overseer-dev-f24fe` and `overseer-9fe46`); both are live and verified against Google, and production has real Android and iOS device tokens registered. Expo is being retired as the transport in favour of native FCM tokens (OVSR-206). Credentials, encodings and the retirement rules for dead device tokens are in [push notifications](push-notifications.md).

Session sounds play on exactly one of an operator's open clients: the one they last picked up. The live socket keeps a per-user stack of clients (`hello` now carries a per-tab `clientId`), promotes a client that arrives or regains focus, drops it back when it disconnects or hides, and tells each client `{ "type": "audio", "primary": boolean }`. Playing is the default, and a client that sends no `clientId` stays out of the stack entirely — it neither goes quiet nor silences anyone, which is where the mobile app sits until it adopts the three-step contract (`clientId`, `audio:claim`/`audio:release` on foreground/background, gate on the last `audio` message). The signals, the wire format and what is deliberately left out are in [audio focus](audio-focus.md).

The Fleet list can attach the sessions the calling operator personally created or followed up on, per Peon, behind `GET /api/workspaces/:wsId/peons?includeRecentSessions=mine` — one query for the whole fleet, with `hasOutstandingRequest` now driven by a dedicated `session_attention.resolved_at` lifecycle column rather than by read state. Each row carries the canonical display fields (`title`, `promptPreview`, `preview`) plus `peonId`, `syncedAt` and `attentionUpdatedAt`, so a client names and merges a session without a second per-Peon request. The contract, the ordering rules and the attention event payload are in [operator-scoped recent sessions](operator-recent-sessions.md).

A Peon can leave a session record at `status: "running"` with no process behind it — it only finalises such orphans when the daemon restarts (`restoreFromDisk` in the Peon's `sessions.ts`), so until then every reader, Overseer included, is told the run is live. A cancel refused with `409 SESSION_NOT_RUNNING` is the Peon's more specific statement and the session view now trusts it over the record until live work resumes; other surfaces that read the record (project "active" counts, list rows after a reload, mobile) keep showing the run until the owning daemon restarts. Overseer must not rewrite session state to paper over this — the fix belongs in the Peon.

Session run state heals itself rather than waiting for the periodic reconcile: reading a session (`GET .../sessions/:sid`) and a Stop refused with `409 SESSION_NOT_RUNNING` both republish the Peon's authoritative record into the index, so every open and every client-side run-watchdog poll corrects a stale "running" row for the whole fleet. The projection's monotonicity and fingerprint guards keep repeated reads silent. A Peon that dies mid-run cannot report the ending, so the session view stops claiming live work while its control channel is down — the index still holds the Peon's last word, which is why a list can show a run as live until that Peon answers again.

Every rendered transcript row is Peon's own: no surface inserts a message into the transcript optimistically. A sent message is instead shown as a **ghost** — one dimmed, breathing placeholder rendered *after* the transcript, owned by the composer, on both the web dashboard and the Flutter client. It retires as soon as the transcript shows more user messages than it counted when the send started (plus a 60 s backstop, and immediately if the send is refused); a queued follow-up gets none, because the queue widget already shows it. The Send button spins until the browser's/client's `POST .../sessions/:sid/followup` settles. The session catalog, rename, delete, new session starts, provider-native branching, follow-ups, cancel, and queue operations (`add`, `list`, `edit`, `remove`, `steer`, plus the deprecated `send-now` compatibility alias) travel from Overseer to Peon over the direct authenticated Fleet HTTP API through mesh; none exists in `reverse-command-v1`. Branching calls Codex app-server `thread/fork` or Claude Code `--resume ... --fork-session`, creates a new durable completed Peon session with a copied authoritative transcript, source lineage and inherited project/runtime defaults, and accepts an optional native `lastTurnId` only for Codex. Peon single-flights the caller-owned branch UUID across the asynchronous provider fork. On web, a small menu under the last assistant message exposes Branch and navigates to the accepted session; a transcript-leading, non-transcript lineage notice links branches through `branchedFromSessionId` and delegated sub-sessions through `parentSessionId`. Queue items expose a stable `type: "queue" | "steer"`; steering preserves the item ID while changing its type and dispatch priority. A queued Codex Steer remains durable until native `turn/steer` acknowledges the exact active turn; rejection retains the item and falls back to interrupt-and-resume. The current one-shot Claude Code CLI has no native in-flight steer request, so its queued Steer interrupts the process, waits for its conversation state to be released, then resumes the same Claude conversation with the selected item, which remains durable until the replacement run starts. `session-catalog-v1` remains only the realtime projection/event channel and is never selected as request authority for a browser/mobile catalog read or mutation. Their browser/mobile API, validation, actor attribution, idempotency and response shapes remain unchanged.

Counting, rather than matching, is the point. A client cannot depend on transport-specific command identity to recognise its own authoritative transcript row. Every attempt to reconcile a local echo against that row by payload was a guess, and one of them left every follow-up on screen twice. A ghost is not a transcript row, so it cannot duplicate one; at worst two operators send at once and a ghost retires on the other's row, one beat before its own arrives. A follow-up's `Peon-Request-Id` is stable while the payload is unchanged: a 5xx or a lost connection keeps it so Overseer's HTTP idempotency record prevents a second post, while a stated refusal (4xx) mints a fresh one.

A Peon carries a default reasoning effort next to its default model, settable from the Peon Settings → Agent tab. The Peon owns this setting (`ai.defaultReasoningEffort`, flat on the wire as `aiDefaultReasoningEffort` on `GET`/`PATCH /settings` in both the fleet and human profiles); `null` means the agent applies its own default. It validates an effort against the **effective model**, not just the agent — `PATCH` fails with `aiDefaultReasoningEffort is not valid for model <id>` — and when a change of `defaultAgent` or default model strands a saved effort, the Peon substitutes that model's own default rather than clearing it. Overseer only ever submits an effort the effective model still advertises, and sends an explicit `null` to reset (the settings form otherwise strips nulls to keep the `PATCH` partial, which would make "reset" a no-op). Effort options come from the per-model `reasoningEfforts` list a current Peon publishes on `/api/v1/models`, falling back to the provider-wide list for older Peons; a model advertising no efforts hides the selector entirely.

A model or effort named on a follow-up is a choice about the conversation, not about one message: the Peon pins it onto the session record (`SessionRecord.model`/`reasoningEffort`), so the composer, the run indicator and a reloaded page all keep naming what actually ran, and a later follow-up that names nothing inherits it. Only an explicit selection is pinned — a session that named none keeps following the daemon-wide default as that default changes. The record also keeps `createdModel`/`createdReasoningEffort`, the immutable selection it was created with, so replaying an MCP spawn request still compares like with like. On the Codex app-server path a resumed thread answers with the model it was created with, and that answer must never rename a turn whose `turn/start` carried an override — otherwise the turn is reported, and billed in `usageByModel`, against the old model.

All file traffic uses one authenticated Overseer→Peon Fleet HTTP path over mesh. This includes directory listings, file bodies and Range downloads, uploads and mutations, session artifacts/previews/watches, and approved update archive bytes. The public browser/mobile API is unchanged. The new-project picker still proxies to Peon's host-wide filesystem listing and the project tree still strips only Overseer's private `directory=1` hint. Peon retains path normalization, containment, symlink classification, size/checksum limits, atomic writes and stable errors. The former transfer WebSocket and its capabilities were removed; there is no selector, fallback or second byte authority.

Overseer has one durable [reverse command gateway](reverse-command-gateway.md) for `reverse-command-v1`: it persists the canonical request and server-derived authenticated actor before send, fences acceptance/status/result by workspace, Peon and socket generation, reconciles the same Peon-scoped command ID after reconnect/restart, and commits an allowlisted terminal result + shared durable inbox/checkpoint + safe projection + audit + operator browser event before ACK. The status surface for a bounded HTTP wait is `GET /api/workspaces/:wsId/peons/:peonId/commands/:commandId`. Session catalog reads, rename, delete, start, follow-up, and Stop deliberately bypass this gateway and use the direct Fleet HTTP API through mesh; Stop retains the Peon's HTTP response semantics and heals the indexed session after `409 SESSION_NOT_RUNNING`.

Armory inventory, settings, package/configuration/MCP/operation reads and every
lifecycle mutation use the direct authenticated Fleet HTTP API through mesh.
There is no reverse-command path or fallback. Results remain bounded and
redacted, while Peon's package locks, transactional installer, durable
operation store and restart recovery remain authoritative — see
[Armory over Fleet HTTP](armory-reverse.md).

Project administration and resources use one direct authenticated Fleet HTTP
authority through mesh: catalog, suggest/create, stable-ID detail/settings,
documentation, skill discovery, quick-link CRUD, update and delete. Selected
projects travel as immutable `projectId`; mutations retain request idempotency
and canonical digest fences. `project-catalog-v1` remains only the realtime
WebSocket projection/event/invalidation channel. There are no `project.*`
reverse commands, selector, fallback or second authority. The routes and
invariants are in [project Fleet HTTP control plane](project-reverse-commands.md).

Peon daemon settings use one authority: [daemon configuration over Fleet HTTP](daemon-configuration.md). Owner-only reads and revision-fenced patches go directly to the authenticated Peon `/api/v1/settings` route through mesh; the control WebSocket carries only the resulting realtime invalidation.

If a Peon does not return after a restart, follow the short
[Peon restart recovery](peon-restart-recovery.md) checklist. Preserve its
config/state, inspect the native service's first startup error, and do not
restore connectivity by exposing the local listener or re-enabling VPN
callbacks.

Update checks, apply admission, approved release metadata and archive bytes use
the single authenticated Fleet HTTP path over mesh. SHA-256 verification,
rollback and replacement-process attestation remain local to the Peon; see
[Peon update channel](peon-update-channel.md).

The remaining direct Peon HTTP/SSE control plane is inventoried and assigned in
[remaining Peon HTTP control plane](remaining-peon-http-control-plane.md).
The independent second-pass 2026-07-30 census finds 79 production call sites
including legacy-only
fallback branches; the design separates projections, bounded queries, durable
commands and Fleet HTTP byte streams. OVSR-292 supersedes the former
transfer-socket tasks and restores one file authority.

The public reverse-control cutover is gated by the durable
[reverse fleet security threat model](reverse-fleet-security.md): it records
assets and trust boundaries, prioritized abuse cases, the stable executable
security suite, open findings and the tests deliberately blocked on unfinished
command/enrollment semantics. A green stable suite is characterization, not
approval of OVSR-129/130/210/145/147.

Public abuse limits and device attribution use the socket peer unless every
forwarding hop is in `OVERSEER_TRUSTED_PROXIES`. nginx accepts
`CF-Connecting-IP` only from Cloudflare's published CIDRs, discards inbound XFF
and emits one canonical XFF value; the application never reads the CF header
directly. Production still has a second ingress until an approved shared-proxy
reboot. During OVSR-248 review, the production Kamal listeners were wildcard
host-bound on both 8080 and 8443 (`0.0.0.0/[::]`). An independent external
request to 8080 returned HTTP 200; the 8443 probe timed out with no HTTP
response (possibly filtered), so only 8080 was demonstrated Internet-reachable.
The source fix models Kamal's appended-peer XFF behavior, while
`proxy.run.bind_ips` pins the fail-safe target for both ports to `127.0.0.1`.
Do not call that target deployed until exact loopback bindings and both external
negative probes are verified. Exact behavior and the preflight/reboot checks
are in [trusted client IPs](proxy-trust.md).

The reusable [protocol conformance and failure-injection harness](protocol-conformance-harness.md) lives in the private `@rnm-dev/protocol-conformance` workspace. Its stable slice executes shared socket/catalog/file-read golden frames, a 3×3 Peon/Overseer capability and exclusive-downgrade matrix, deterministic drop/duplicate/reorder/reconnect/restart faults, bounded redacted diagnostics, and a topology assertion that permits only the two intentional Fleet HTTP directory-listing surfaces over mesh. Reverse commands, enrollment, transcripts, writes and rollout remain explicit blocked extension cells until their contracts, adapters and acceptance coverage are complete.

Transcript history pages and authoritative one-session detail use the direct
authenticated Peon Fleet HTTP API through the mesh. Page reads preserve
`transcript-pagination-v1` limit/cursor semantics and never create reverse
snapshot demand. The [`transcript-sync-v1` snapshot/projection/relay](transcript-sync.md)
remains for live tails: Peon publishes post-barrier commits through the shared
durable outbox; Overseer commits projection + inbox cursor + ACL-scoped browser
event before ACK, shares one realtime demand per Peon/session and fences socket
generations.

Deleting a project unregisters it and nothing more: the Peon drops its record (refusing with `409 PROJECT_RUNNING` while a session is running against it, and leaving already-recorded sessions with the project key they carry), while the directory and its files stay on disk. The owner-only Settings action needs the Peon online because the Peon owns the record. After a confirmed Fleet HTTP deletion, Overseer immediately evicts its cached project and access grants through `forgetIndexedProject` instead of waiting for the following catalog event; that event then becomes an idempotent no-op.

Every file the web client shows — a message attachment, project file, documentation page or session artifact — is named by one `FileSource` and read by one renderer. Message attachments retain their dedicated public route because transcript paths may be absolute; Overseer safely maps them into `fileTransferRoot`. File bodies, Range/download, uploads/mutations, session artifacts/preview/watch and update archive bytes all stream through the direct authenticated Fleet HTTP API over mesh. Details are in [showing a file](file-viewing.md).

An iOS Live Activity server surface shipped on 2026-07-27 (`/api/push/live-activities*`, tables `live_activity_tokens` and `live_activity_claims`): one aggregate per operator per device connection, keyed by (user, device, connection). Registration takes a `connectionId` and never a `workspaceId`/`peonId`/`sessionId`, and the content state is `runningCount`/`completedCount`/`oldestStartedAt`/`updatedAt` — the contract is in [push notifications](push-notifications.md#ios-live-activities), and `apps/server/src/liveActivity.test.ts` holds start/update/end to it. It is dormant in production until an iOS client registers ActivityKit tokens — no tokens, no pushes, and behaviour on a real handset is still unverified.

A separate product — the instructions site — lives in `site/` (Vite + Tailwind v4 + Motion/Lenis), runs on 127.0.0.1:4582, is published for dev at https://dev.ovrseer.org and is destined for Cloudflare Pages — see [instructions site](static-site.md). It is not under version control at all yet; OVSR-237 gives it a repository and detaches it from this tree, and it does not join the monorepo.

Peon, the Overseer server, the web dashboard and the Flutter client are being brought into one repository — the existing `rnm-dev/overseer`, so the remote and the deploy paths survive. The reason is that a single wire contract currently lives in four hand-synced places (the canonical `peon/PROTOCOL.md`, its self-described "vendored snapshot" here, the vendored `reverse-command-v1` schema and fixtures, and the client's hand-written Dart models), plus two `docs/` trees covering the same topics. Directories name the role (`apps/server`, `apps/web`, `apps/client`, `apps/peon`, `packages/protocol`) and package manifests name the product (`@rnm-dev/overseer-server`, `@rnm-dev/overseer-web`, `@rnm-dev/peon`, `@rnm-dev/protocol`), so "overseer" stops meaning three things at once. GitHub Actions are not used — the only workflow in the picture is the client's, it goes away, and a root `npm run verify` covering every workspace plus `flutter analyze`/`flutter test` takes its place.

The work is epic **Монорепо**. OVSR-238 is **released to production**: the checkout root was flattened from `/rnm/overseer/app` to `/rnm/overseer`, the server and the dashboard became `apps/server` and `apps/web`, and `docs/`, `infra/` and compose came under version control with them. Peon now lives in `apps/peon` as the `@rnm-dev/peon` workspace. The npm organisation is `rnm-dev` (`@rnm` was unavailable), so every Node package uses `@rnm-dev/*`. OVSR-240 is released: `@rnm-dev/peon@0.11.3` is public on npm and verified by clean install plus installed-package rollback packing. npm remains the installation channel, while enrolled fleet updates stay on Overseer's authenticated, size- and SHA-256-verified registry. The updater derives and preserves the existing global npm prefix and packs rollback archives with lifecycle scripts disabled, which is required by the compiled-only npm distribution. On 2026-07-30 nid-dev (`94.247.128.101`, user `peon`) was migrated in place from unscoped `peon@0.11.1` to `@rnm-dev/peon@0.11.3`: its Peon ID and all 556 sessions were preserved, both reverse sockets reconnected with an empty outbox, the old package remains for rollback, and the verified pre-migration archive remains on that host at `/root/peon-migration-backups/20260730T183400Z/`. Remaining monorepo work: OVSR-237 (give the instructions site its own repository and detach it), OVSR-239 (`packages/protocol`) and OVSR-241 (Flutter client). The layout and measured constraints are in [monorepo](monorepo.md).

Peon enrollment has one path: the local operator runs `peon enroll` to arm a
single-use, 15-minute pairing phrase, enters the Peon's reachable address and
phrase in Overseer, and Overseer mints the workspace credential and sends it to
the Peon's authenticated `POST /api/v1/enroll` route. `peon pair` remains a CLI
alias. The retired outbound `peon-claim-v1` service, operator-code page,
credential rotation, recovery and dual-mode locks have been removed.

Pages this index does not otherwise reach: [server design notes](server-design.md) holds the settled decisions, the robustness model and the roadmap; [architecture](architecture.md) holds the rules for organising the code itself; [the dev box](dev-box.md) holds how the stack is served and operated on nid-dev; [deploy runbook](deploy-runbook.md) holds the Kamal preparation, the persistent-volume rules and rollback; [public website PRD](public-website-prd.md) belongs to the instructions site and leaves with it (OVSR-237). There are no `CLAUDE.md` files in this repository — that content lives in the two pages above, and this index is what every session is given.

Project workflow: use Heroboard task tracking for non-trivial implementation, fixes, design, refactors, migrations, publishing, and deployments. Reuse a matching task or create one before work begins. Do not create tasks for read-only checks, diagnostics without requested changes, or genuinely trivial edits. Do not create tasks for preparing a working environment either — pulling or cleaning a checkout, restarting a dev process, installing dependencies. That is part of doing the work; if it matters to whoever picks the work up, note it in the task that needs it.

## Local setup

repo: /rnm/overseer (git repo, remote origin git@github.com:rnm-dev/overseer.git, branch master; push after committing before deploying). It is a monorepo: `apps/server` (Express API, `@rnm-dev/overseer-server`) and `apps/web` (React SPA, `@rnm-dev/overseer-web`) are npm workspaces sharing one root lockfile, and `docs/`, `infra/`, `scripts/` and `docker-compose.yml` are versioned with them. `site/`, `backups/`, `secrets/`, `postgres/` and the env files are gitignored. `npm run verify` at the root runs lint plus every workspace's own verify.
sibling repos: git@github.com:rnm-dev/peon.git and git@github.com:rnm-dev/overseer-app.git (the Flutter client, branch main)
github: plain git over SSH is the only interface to GitHub here. The `gh` CLI is not used — its stored credentials were removed on 2026-07-29 (they could not see the rnm-dev organisation anyway: every `gh api repos/rnm-dev/*` answered 404). Do not reintroduce it or plan work around the GitHub API; the apt package `gh` is still installed and awaits removal by root
compose: postgres (compose-net only, 5432 unpublished), app: 127.0.0.1:4580, web: 127.0.0.1:4581 — all three up, postgres healthy
postgres: postgres:5432/overseer overseer/1701e037ee97028cc925d2925e7ec7b0 (not host-published; use docker compose exec postgres psql)
seed: no seed script; schema self-migrates on boot (initDb/MIGRATIONS in apps/server/src/db.ts). No env-seeded admin — auth is GitHub OAuth with open sign-up (ensureUserFromGithub in apps/server/src/auth.ts; OVERSEER_ADMIN_EMAIL no longer used anywhere) plus email/password where `OVERSEER_PASSWORD_AUTH=1` (on for dev, off in production — see [email and password sign-in](password-auth.md)), access gated by workspace membership

Dev public origin is https://overseer-dev.rnm.dev. Cloudflare A record remains proxied to 94.247.128.101. Dev app configuration uses OVERSEER_PUBLIC_URL and OVERSEER_PEON_CALLBACK_URL = https://overseer-dev.rnm.dev. Native OAuth accepts both `overseer-dev://oauth/github` and `overseer://oauth/github` through OVERSEER_GITHUB_NATIVE_CALLBACKS so dev and prod mobile builds can be tested against the dev server. The dev database intentionally contains only Nova and its history; shared users/workspaces/devices remain available for login. The empty RNM workspace (1313b906-590b-4b07-b7a3-c37b0e9f14d0) was deleted from dev on 2026-07-20; production RNM was not changed. Its pre-delete dump (SHA-256 761057b1aebb1d7df7734d276bb0cc8340e459e2a9d0960009f0e58443dd1bcd) was the only copy and was deleted on 2026-07-29 with the rest of the dev box's `backups/`; that workspace was empty, so nothing recoverable was in it.

## Production deployment

host: root@94.247.128.103 (nid-01 / nid-prod-coloc.mesh.rnm / Tailscale 100.64.0.5)
tailnet: hs.rnm.dev, MagicDNS suffix mesh.rnm; the production app container resolves and reaches Peons at peon-*.mesh.rnm:4570
deploy: Kamal 2 config /rnm/overseer/apps/server/config/deploy.yml; service overseer; registry image vibze/overseer
current image: vibze/overseer:b9dae10f7d502fb0f1a121155c33b00416388335 (clean commit, deployed 2026-08-03 — the transcript's plugin-request placeholder is gone, the composer fade no longer follows queued messages up the transcript, and the project page queries its own sessions with `?projectKey=`)
app container pattern: overseer-web-<version>, port 5000 on the kamal network, health check /healthz
primary proxy path: Cloudflare → host nginx :80 → shared kamal-proxy 127.0.0.1:8080 → Overseer :5000. During OVSR-248 review, the production Kamal listeners were wildcard host-bound on both 8080 and 8443 (`0.0.0.0/[::]`). An independent external request to 8080 returned HTTP 200; the 8443 probe timed out with no HTTP response (possibly filtered), so only 8080 was demonstrated Internet-reachable. The checked-in Kamal 2.12+ run config targets both listeners at 127.0.0.1, but that requires a separately approved shared-proxy reboot and has not been applied
host nginx config: /etc/nginx/sites-available/overseer.rnm.dev, enabled in sites-enabled
public origin: https://overseer.rnm.dev
Cloudflare: proxied A overseer.rnm.dev → 94.247.128.103; proxied A overseer-dev.rnm.dev → 94.247.128.101
production env: OVERSEER_PUBLIC_URL and OVERSEER_PEON_CALLBACK_URL = https://overseer.rnm.dev; production uses its own GitHub OAuth app
database: accessory container overseer-postgres, PostgreSQL 16, internal DNS overseer-postgres:5432/overseer; schema migrations self-apply on app boot under an advisory lock

Persistent Docker volumes on nid-01:
- overseer-postgres-data → /var/lib/postgresql/data
- overseer-postgres-backups → /backups
- overseer-releases → /data/releases

Never remove/recreate these volumes during deploy or rollback. Kamal app deploys do not replace the Postgres accessory.

## Cutover state (2026-07-20)

The production database contains Kanat, Marat, Neo, Thor and the historical Smoke record with their sessions/events/follow-up history. Nova and Nova's credential/history are excluded from production. The dev database contains only Nova with 150 sessions, 14,236 events and 416 follow-up commands.

The final pre-cutover database dump lives on nid-01 in the `overseer-postgres-backups` volume, twice: `/backups/overseer-final-20260720T1301Z.dump` and `/backups/overseer-final.dump`, both SHA-256 de40548406eb652706a36dad7e127f749a0f11d1204c4e74708ecdbdb9181231. The earlier aborted attempt is beside them as `/backups/overseer-final-20260720T1255Z.dump`. Read them with `docker run --rm -v overseer-postgres-backups:/b alpine:3 ls -la /b`.

The dev box's copies of those dumps were deleted on 2026-07-29 after verifying the remote ones byte for byte; the volume is the only place they live now, and the deploy runbook already forbids removing it. The pre-cutover release archive (SHA-256 c53182c095e194883d859448d3956499708a362f50f398191d73e66c884d2c6d) went with them — it was a 127-byte tarball.

Kanat is verified registered and heartbeating to production after cutover. During the first aborted split, an active Peon received 401 from the Nova-only dev DB and entered the Peon daemon's durable-in-memory derecruited state. Kanat was safely re-pointed without a daemon restart and recovered. Marat may need re-enrollment or daemon restart if it also observed that transient 401. Offline Neo/Thor will use the canonical production URL when they return.

Nova was offline during cutover. Before starting its daemon, re-point its local Peon setting overseerUrl to https://overseer-dev.rnm.dev while retaining its existing dev credential. Otherwise it will call the production origin, where its credential is intentionally absent, receive 401, and de-recruit.

## Deploy and rollback

Deploy from /rnm/overseer/apps/server after validation, using the ignored .kamal/secrets file there. The Docker build context is the repository root (`builder.context: ../..` in config/deploy.yml) because npm workspaces keep a single lockfile there:
- kamal config
- kamal deploy
- verify app health, proxy routes, DB migration count and persistent volume mounts

Do not put secrets into metadata or commits. DATABASE_URL must target overseer-postgres.

Application rollback: kamal rollback <version>.
Traffic rollback: update Cloudflare overseer.rnm.dev A record back to 94.247.128.101.
Data rollback: stop the target app and pg_restore the verified custom-format dump from the backup volume. Do not overwrite the source or delete either host's volumes.
Shared-proxy loopback rollback is different: before cutover, create the
gitignored, checksummed, off-host bundle in [the deploy
runbook](deploy-runbook.md#approved-shared-proxy-loopback-cutover). Its
`rollback.yml` intentionally removes `bind_ips`; using it reopens the verified
direct 8080 boundary and is separately approved outage recovery only.

## Known limitation

The production DNS record *.preview.overseer.rnm.dev points to 94.247.128.103 and nginx/app routing is prepared, but HTTPS currently fails during the Cloudflare TLS handshake because the nested wildcard hostname is not covered by the available edge certificate. Do not consider tokenized web previews production-ready until Cloudflare issues/configures suitable nested-host certificates or the preview hostname design is flattened. Dev preview.overseer-dev.rnm.dev is configured in the app but does not yet have working wildcard DNS/nginx/TLS routing.
