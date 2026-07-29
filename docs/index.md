## Project information

The mobile app signs in through a webview on the web login screen — see [mobile webview login](mobile-webview-login.md).

Pluggable speech-to-text for the composer (Groq first, provider seam for open source): the server side is implemented — `POST /api/v1/voice/transcriptions` plus `GET /api/v1/voice/capabilities` — and stays disabled until `OVERSEER_VOICE` and a key are configured. Both dev and production are configured with the same Groq key and verified end to end (565 ms warm on dev, 775 ms through the public origin). They share a free-tier budget of 1000 requests/day and cannot see each other's spend, so it is split by `OVERSEER_VOICE_REQUESTS_PER_DAY`: 800 in production (`apps/server/config/deploy.yml`), 200 on dev. No client records audio yet. Configuration reference and the measured latencies are in [voice input](voice-input.md).

Push notifications fire on exactly one signal — a `session_attention` occurrence turning unread, meaning a turn the user initiated finished while they were not watching it — and deliver through Expo and, since 2026-07-27, FCM HTTP v1. Dev and production hold different Firebase projects (`overseer-dev-f24fe` and `overseer-9fe46`); both are live and verified against Google, and production has real Android and iOS device tokens registered. Expo is being retired as the transport in favour of native FCM tokens (OVSR-206). Credentials, encodings and the retirement rules for dead device tokens are in [push notifications](push-notifications.md).

Session sounds play on exactly one of an operator's open clients: the one they last picked up. The live socket keeps a per-user stack of clients (`hello` now carries a per-tab `clientId`), promotes a client that arrives or regains focus, drops it back when it disconnects or hides, and tells each client `{ "type": "audio", "primary": boolean }`. Playing is the default, and a client that sends no `clientId` stays out of the stack entirely — it neither goes quiet nor silences anyone, which is where the mobile app sits until it adopts the three-step contract (`clientId`, `audio:claim`/`audio:release` on foreground/background, gate on the last `audio` message). The signals, the wire format and what is deliberately left out are in [audio focus](audio-focus.md).

The Fleet list can attach the sessions the calling operator personally created or followed up on, per Peon, behind `GET /api/workspaces/:wsId/peons?includeRecentSessions=mine` — one query for the whole fleet, with `hasOutstandingRequest` now driven by a dedicated `session_attention.resolved_at` lifecycle column rather than by read state. Each row carries the canonical display fields (`title`, `promptPreview`, `preview`) plus `peonId`, `syncedAt` and `attentionUpdatedAt`, so a client names and merges a session without a second per-Peon request. The contract, the ordering rules and the attention event payload are in [operator-scoped recent sessions](operator-recent-sessions.md).

A Peon can leave a session record at `status: "running"` with no process behind it — it only finalises such orphans when the daemon restarts (`restoreFromDisk` in the Peon's `sessions.ts`), so until then every reader, Overseer included, is told the run is live. A cancel refused with `409 SESSION_NOT_RUNNING` is the Peon's more specific statement and the session view now trusts it over the record until live work resumes; other surfaces that read the record (project "active" counts, list rows after a reload, mobile) keep showing the run until the owning daemon restarts. Overseer must not rewrite session state to paper over this — the fix belongs in the Peon.

Session run state heals itself rather than waiting for the periodic reconcile: reading a session (`GET .../sessions/:sid`) and a Stop refused with `409 SESSION_NOT_RUNNING` both republish the Peon's authoritative record into the index, so every open and every client-side run-watchdog poll corrects a stale "running" row for the whole fleet. The projection's monotonicity and fingerprint guards keep repeated reads silent. A Peon that dies mid-run cannot report the ending, so the session view stops claiming live work while its control channel is down — the index still holds the Peon's last word, which is why a list can show a run as live until that Peon answers again.

A Peon carries a default reasoning effort next to its default model, settable from the Peon Settings → Agent tab. The Peon owns this setting (`ai.defaultReasoningEffort`, flat on the wire as `aiDefaultReasoningEffort` on `GET`/`PATCH /settings` in both the fleet and human profiles); `null` means the agent applies its own default. It validates an effort against the **effective model**, not just the agent — `PATCH` fails with `aiDefaultReasoningEffort is not valid for model <id>` — and when a change of `defaultAgent` or default model strands a saved effort, the Peon substitutes that model's own default rather than clearing it. Overseer only ever submits an effort the effective model still advertises, and sends an explicit `null` to reset (the settings form otherwise strips nulls to keep the `PATCH` partial, which would make "reset" a no-op). Effort options come from the per-model `reasoningEfforts` list a current Peon publishes on `/api/v1/models`, falling back to the provider-wide list for older Peons; a model advertising no efforts hides the selector entirely.

The new-project directory picker browses the Peon's whole filesystem, starting at `/`, through the Peon's `folder-listing-v1` reverse WebSocket rather than the HTTP `/files?stat=1` proxy — that proxy could only see `fileTransferRoot`. The surface is `GET /api/workspaces/:wsId/peons/:id/folders?path=&limit=` (owner-only, directories only, `{ path, entries }`); it is a thin wrapper over `listFolder` in `apps/server/src/peonFolderListing.ts`, so pagination, cancellation, the 15 s timeout, listing bounds and capability negotiation are the operation's, not a second wire protocol. A Peon that does not negotiate `folder-listing-v1` gets `409 UNSUPPORTED_CAPABILITY` and the picker says so instead of falling back to a restricted listing. A Peon serves one folder listing at a time, so an overlapping reader is refused with `SYNC_IN_PROGRESS` — routine on open, since a superseded request's cancellation may not have landed yet; both callers (the picker and project documentation) therefore wait through the shared bounded backoff in `apps/server/src/peonFolderRetry.ts` rather than reporting a busy Peon. Because a suggested project directory does not exist yet, the picker's *first* listing walks up to the nearest existing ancestor; explicit navigation never does, so a missing or unreadable folder is reported. Other pickers (project settings, new session, Peon settings) still browse through the file proxy.

Every file the web client shows — a message attachment, a project file, a documentation page, a session artifact — is named by one `FileSource` (`apps/web/src/pages/peon/fileLinks.ts`) and read by one reader/renderer (`apps/web/src/pages/peon/FileView.tsx`); a surface contributes only its chrome. Message attachments have their own route, `GET /api/workspaces/:wsId/peons/:id/attachments?path=`, because a transcript names an attachment by the Peon's *absolute* path while `/files/...` is relative to `fileTransferRoot` — Overseer maps one to the other in `apps/server/src/peonFileSandbox.ts` and answers `400 PATH_ESCAPE` / `503 FILES_DISABLED` with a sentence the viewer shows. Details, including why the path travels as a query parameter, are in [showing a file](file-viewing.md). File traffic is moving off the Peon's HTTP API onto its reverse transfer socket: project file reads now take `project-file-read-v1` for every Peon that holds a transfer socket (by key as well as by ID, with the proxy left only as the fallback for an older Peon), while directory listings, attachment reads and every upload still need Peon-side channels that do not exist yet — the split and what each one is waiting for are in the same page.

An iOS Live Activity server surface shipped on 2026-07-27 (`/api/push/live-activities*`, tables `live_activity_tokens` and `live_activity_claims`): one aggregate per operator per device connection, keyed by (user, device, connection). Registration takes a `connectionId` and never a `workspaceId`/`peonId`/`sessionId`, and the content state is `runningCount`/`completedCount`/`oldestStartedAt`/`updatedAt` — the contract is in [push notifications](push-notifications.md#ios-live-activities), and `apps/server/src/liveActivity.test.ts` holds start/update/end to it. It is dormant in production until an iOS client registers ActivityKit tokens — no tokens, no pushes, and behaviour on a real handset is still unverified.

A separate product — the instructions site — lives in `site/` (Vite + Tailwind v4 + Motion/Lenis), runs on 127.0.0.1:4582, is published for dev at https://dev.ovrseer.org and is destined for Cloudflare Pages — see [instructions site](static-site.md). It is not under version control at all yet; OVSR-237 gives it a repository and detaches it from this tree, and it does not join the monorepo.

Peon, the Overseer server, the web dashboard and the Flutter client are being brought into one repository — the existing `rnm-dev/overseer`, so the remote and the deploy paths survive. The reason is that a single wire contract currently lives in four hand-synced places (the canonical `peon/PROTOCOL.md`, its self-described "vendored snapshot" here, the vendored `reverse-command-v1` schema and fixtures, and the client's hand-written Dart models), plus two `docs/` trees covering the same topics. Directories name the role (`apps/server`, `apps/web`, `apps/client`, `apps/peon`, `packages/protocol`) and package manifests name the product (`@rnm/overseer-server`, `@rnm/overseer-web`, `@rnm/peon`, `@rnm/protocol`), so "overseer" stops meaning three things at once. GitHub Actions are not used — the only workflow in the picture is the client's, it goes away, and a root `npm run verify` covering every workspace plus `flutter analyze`/`flutter test` takes its place.

The work is epic **Монорепо**. OVSR-238 is **done on branch `monorepo`** (not yet merged or deployed): the checkout root was flattened from `/rnm/overseer/app` to `/rnm/overseer`, the server and the dashboard became `apps/server` and `apps/web`, and `docs/`, `infra/` and compose came under version control with them. Remaining: OVSR-237 (give the instructions site its own repository and detach it) → OVSR-239 (`packages/protocol`) → OVSR-240 (publish `@rnm/protocol` and `@rnm/peon`, then bring Peon in — the only step touching the fleet's live update channel) → OVSR-241 (Flutter client). The layout and the constraints that were measured rather than assumed — npm rejects the `workspace:` protocol, the npm name `peon` is taken, Peon's Overseer-served SHA-256-verified update channel must not be replaced by the public registry, the Flutter client shares no dependency graph with the Node packages — are in [monorepo](monorepo.md).

Pages this index does not otherwise reach: [server design notes](server-design.md) holds the settled decisions, the robustness model and the roadmap; [architecture](architecture.md) holds the rules for organising the code itself; [the dev box](dev-box.md) holds how the stack is served and operated on nid-dev; [deploy runbook](deploy-runbook.md) holds the Kamal preparation, the persistent-volume rules and rollback; [public website PRD](public-website-prd.md) belongs to the instructions site and leaves with it (OVSR-237). There are no `CLAUDE.md` files in this repository — that content lives in the two pages above, and this index is what every session is given.

Project workflow: use Heroboard task tracking for non-trivial implementation, fixes, design, refactors, migrations, publishing, and deployments. Reuse a matching task or create one before work begins. Do not create tasks for read-only checks, diagnostics without requested changes, or genuinely trivial edits. Do not create tasks for preparing a working environment either — pulling or cleaning a checkout, restarting a dev process, installing dependencies. That is part of doing the work; if it matters to whoever picks the work up, note it in the task that needs it.

## Local setup

repo: /rnm/overseer (git repo, remote origin git@github.com:rnm-dev/overseer.git, branch master; push after committing before deploying). It is a monorepo: `apps/server` (Express API, `@rnm/overseer-server`) and `apps/web` (React SPA, `@rnm/overseer-web`) are npm workspaces sharing one root lockfile, and `docs/`, `infra/`, `scripts/` and `docker-compose.yml` are versioned with them. `site/`, `backups/`, `secrets/`, `postgres/` and the env files are gitignored. `npm run verify` at the root runs lint plus every workspace's own verify.
sibling repos: git@github.com:rnm-dev/peon.git and git@github.com:rnm-dev/overseer-app.git (the Flutter client, branch main)
github: plain git over SSH is the only interface to GitHub here. The `gh` CLI is not used — its stored credentials were removed on 2026-07-29 (they could not see the rnm-dev organisation anyway: every `gh api repos/rnm-dev/*` answered 404). Do not reintroduce it or plan work around the GitHub API; the apt package `gh` is still installed and awaits removal by root
compose: postgres (compose-net only, 5432 unpublished), app: 127.0.0.1:4580, web: 127.0.0.1:4581 — all three up, postgres healthy
postgres: postgres:5432/overseer overseer/1701e037ee97028cc925d2925e7ec7b0 (not host-published; use docker compose exec postgres psql)
seed: no seed script; schema self-migrates on boot (initDb/MIGRATIONS in apps/server/src/db.ts). No env-seeded admin — auth is now GitHub OAuth with open sign-up (ensureUserFromGithub in apps/server/src/auth.ts; OVERSEER_ADMIN_EMAIL no longer used anywhere), access gated by workspace membership

Dev public origin is https://overseer-dev.rnm.dev. Cloudflare A record remains proxied to 94.247.128.101. Dev app configuration uses OVERSEER_PUBLIC_URL and OVERSEER_PEON_CALLBACK_URL = https://overseer-dev.rnm.dev. Native OAuth accepts both `overseer-dev://oauth/github` and `overseer://oauth/github` through OVERSEER_GITHUB_NATIVE_CALLBACKS so dev and prod mobile builds can be tested against the dev server. The dev database intentionally contains only Nova and its history; shared users/workspaces/devices remain available for login. The empty RNM workspace (1313b906-590b-4b07-b7a3-c37b0e9f14d0) was deleted from dev on 2026-07-20; production RNM was not changed. Pre-delete backup: /rnm/overseer/backups/dev-delete-rnm-20260720T1320Z/dev-before-delete-rnm.dump, SHA-256 761057b1aebb1d7df7734d276bb0cc8340e459e2a9d0960009f0e58443dd1bcd.

## Production deployment

host: root@94.247.128.103 (nid-01 / nid-prod-coloc.mesh.rnm / Tailscale 100.64.0.5)
tailnet: hs.rnm.dev, MagicDNS suffix mesh.rnm; the production app container resolves and reaches Peons at peon-*.mesh.rnm:4570
deploy: Kamal 2 config /rnm/overseer/apps/server/config/deploy.yml; service overseer; registry image vibze/overseer
current image: vibze/overseer:decf3d60c409bccaca9197016756e79ea4ff2dae (clean commit, deployed 2026-07-28 — the composer's inherited-default entry now naming the model it runs on; it succeeds 9e59584, which brought per-client session-sound focus, the folder-listing directory picker for new projects and the shared bounded backoff on a Peon's single folder-listing slot)
app container pattern: overseer-web-<version>, port 5000 on the kamal network, health check /healthz
proxy path: Cloudflare → host nginx :80 → shared kamal-proxy 127.0.0.1:8080 → Overseer :5000
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

Final pre-cutover backups:
- source: /rnm/overseer/backups/cutover-20260720T1301Z/overseer-final.dump
- source releases: /rnm/overseer/backups/cutover-20260720T1301Z/overseer-releases.tgz
- dump SHA-256: de40548406eb652706a36dad7e127f749a0f11d1204c4e74708ecdbdb9181231
- release archive SHA-256: c53182c095e194883d859448d3956499708a362f50f398191d73e66c884d2c6d
- remote dump: /backups/overseer-final-20260720T1301Z.dump inside overseer-postgres-backups

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

## Known limitation

The production DNS record *.preview.overseer.rnm.dev points to 94.247.128.103 and nginx/app routing is prepared, but HTTPS currently fails during the Cloudflare TLS handshake because the nested wildcard hostname is not covered by the available edge certificate. Do not consider tokenized web previews production-ready until Cloudflare issues/configures suitable nested-host certificates or the preview hostname design is flattened. Dev preview.overseer-dev.rnm.dev is configured in the app but does not yet have working wildcard DNS/nginx/TLS routing.
