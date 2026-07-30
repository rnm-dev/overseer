## Project information

The cross-platform Flutter operator client now lives in `apps/client` (iOS,
Android, macOS, Windows and Linux). Its development and feature documentation
starts at [client documentation](client/index.md).

The mobile app signs in through a webview on the web login screen — see [mobile webview login](mobile-webview-login.md).

Runtime status, capacity, daemon revision, provider availability, models and
reasoning modes converge through the durable `runtime-state-v1` projection;
quota, provider capability probes, fixed-period stats and filtered analytics
use bounded `reverse-command-v1` operations rather than another request ledger.
Stored state is explicitly fresh, stale or offline and legacy Peons retain the
HTTP route. The field classification, redaction and query bounds are in
[reverse runtime capabilities](runtime-capabilities.md).

Pluggable speech-to-text for the composer (Groq first, provider seam for open source): the server side is implemented — `POST /api/v1/voice/transcriptions` plus `GET /api/v1/voice/capabilities` — and stays disabled until `OVERSEER_VOICE` and a key are configured. Both dev and production are configured with the same Groq key and verified end to end (565 ms warm on dev, 775 ms through the public origin). They share a free-tier budget of 1000 requests/day and cannot see each other's spend, so it is split by `OVERSEER_VOICE_REQUESTS_PER_DAY`: 800 in production (`apps/server/config/deploy.yml`), 200 on dev. No client records audio yet. Configuration reference and the measured latencies are in [voice input](voice-input.md).

Push notifications fire on exactly one signal — a `session_attention` occurrence turning unread, meaning a turn the user initiated finished while they were not watching it — and deliver through Expo and, since 2026-07-27, FCM HTTP v1. Dev and production hold different Firebase projects (`overseer-dev-f24fe` and `overseer-9fe46`); both are live and verified against Google, and production has real Android and iOS device tokens registered. Expo is being retired as the transport in favour of native FCM tokens (OVSR-206). Credentials, encodings and the retirement rules for dead device tokens are in [push notifications](push-notifications.md).

Session sounds play on exactly one of an operator's open clients: the one they last picked up. The live socket keeps a per-user stack of clients (`hello` now carries a per-tab `clientId`), promotes a client that arrives or regains focus, drops it back when it disconnects or hides, and tells each client `{ "type": "audio", "primary": boolean }`. Playing is the default, and a client that sends no `clientId` stays out of the stack entirely — it neither goes quiet nor silences anyone, which is where the mobile app sits until it adopts the three-step contract (`clientId`, `audio:claim`/`audio:release` on foreground/background, gate on the last `audio` message). The signals, the wire format and what is deliberately left out are in [audio focus](audio-focus.md).

The Fleet list can attach the sessions the calling operator personally created or followed up on, per Peon, behind `GET /api/workspaces/:wsId/peons?includeRecentSessions=mine` — one query for the whole fleet, with `hasOutstandingRequest` now driven by a dedicated `session_attention.resolved_at` lifecycle column rather than by read state. Each row carries the canonical display fields (`title`, `promptPreview`, `preview`) plus `peonId`, `syncedAt` and `attentionUpdatedAt`, so a client names and merges a session without a second per-Peon request. The contract, the ordering rules and the attention event payload are in [operator-scoped recent sessions](operator-recent-sessions.md).

A Peon can leave a session record at `status: "running"` with no process behind it — it only finalises such orphans when the daemon restarts (`restoreFromDisk` in the Peon's `sessions.ts`), so until then every reader, Overseer included, is told the run is live. A cancel refused with `409 SESSION_NOT_RUNNING` is the Peon's more specific statement and the session view now trusts it over the record until live work resumes; other surfaces that read the record (project "active" counts, list rows after a reload, mobile) keep showing the run until the owning daemon restarts. Overseer must not rewrite session state to paper over this — the fix belongs in the Peon.

Session run state heals itself rather than waiting for the periodic reconcile: reading a session (`GET .../sessions/:sid`) and a Stop refused with `409 SESSION_NOT_RUNNING` both republish the Peon's authoritative record into the index, so every open and every client-side run-watchdog poll corrects a stale "running" row for the whole fleet. The projection's monotonicity and fingerprint guards keep repeated reads silent. A Peon that dies mid-run cannot report the ending, so the session view stops claiming live work while its control channel is down — the index still holds the Peon's last word, which is why a list can show a run as live until that Peon answers again.

Every rendered transcript row is Peon's own: no surface inserts a message into the transcript optimistically. A sent message is instead shown as a **ghost** — one dimmed, breathing placeholder rendered *after* the transcript, owned by the composer, on both the web dashboard and the Flutter client. It retires as soon as the transcript shows more user messages than it counted when the send started (plus a 60 s backstop, and immediately if the send is refused); a queued follow-up gets none, because the queue widget already shows it. The Send button spins until the browser's/client's `POST .../sessions/:sid/followup` settles — that hop is still ordinary HTTP; only Overseer→Peon moved to the reverse WebSocket.

Counting, rather than matching, is the point. Overseer derives its *own* reverse-command id for a follow-up (`stableCommandId(peonId, userId, operation, Peon-Request-Id)`) and Peon stamps the transcript row with that derived id, so a client can never recognise its own message by identity. Every attempt to reconcile a local echo against the authoritative row by payload was a guess, and one of them left every follow-up on screen twice. A ghost is not a transcript row, so it cannot duplicate one; at worst two operators send at once and a ghost retires on the other's row, one beat before its own arrives. A follow-up's `Peon-Request-Id` is stable while the payload is unchanged: a 5xx or a lost connection keeps it so a retry is deduplicated by Overseer rather than posting a second message, while a stated refusal (4xx) mints a fresh one.

A Peon carries a default reasoning effort next to its default model, settable from the Peon Settings → Agent tab. The Peon owns this setting (`ai.defaultReasoningEffort`, flat on the wire as `aiDefaultReasoningEffort` on `GET`/`PATCH /settings` in both the fleet and human profiles); `null` means the agent applies its own default. It validates an effort against the **effective model**, not just the agent — `PATCH` fails with `aiDefaultReasoningEffort is not valid for model <id>` — and when a change of `defaultAgent` or default model strands a saved effort, the Peon substitutes that model's own default rather than clearing it. Overseer only ever submits an effort the effective model still advertises, and sends an explicit `null` to reset (the settings form otherwise strips nulls to keep the `PATCH` partial, which would make "reset" a no-op). Effort options come from the per-model `reasoningEfforts` list a current Peon publishes on `/api/v1/models`, falling back to the provider-wide list for older Peons; a model advertising no efforts hides the selector entirely.

The new-project directory picker browses the Peon's whole filesystem, starting at `/`, through the Peon's `folder-listing-v1` reverse WebSocket rather than the HTTP `/files?stat=1` proxy — that proxy could only see `fileTransferRoot`. The surface is `GET /api/workspaces/:wsId/peons/:id/folders?path=&limit=` (owner-only, directories only, `{ path, entries }`); it is a thin wrapper over `listFolder` in `apps/server/src/peonFolderListing.ts`, so pagination, cancellation, the 15 s timeout, listing bounds and capability negotiation are the operation's, not a second wire protocol. The same operation carries negotiated `size`/`mtimeMs` entry metadata and project-relative containment, so the web project file tree marks confirmed directory requests as `?stat=1&directory=1` and routes them over the control socket; plain individual-file `?stat=1` remains exclusively on HTTP for `sha256`, never probes both transports, and older Peons retain the HTTP directory fallback with only that private marker removed from the original query. Socket listings normalize back to the legacy public contract: contained symlinks keep their target `dir`/`file` type and metadata, while escaping/broken/special links are inert `other`. Peon resolves a directory to its real path, requires it to still be a directory, classifies each child by its target and releases the listing slot only after every sibling in an aborted metadata batch settles — the same contract `fileAccessService.listDirEntries` has always served over HTTP, and it runs on every platform. It deliberately does **not** anchor the walk to open directory handles. That earlier design traversed `/proc/self/fd/N` so an ancestor could not be swapped mid-listing, but the mechanism is Linux-only (Darwin's `fcntl(F_GETPATH)` only reconstructs a path string; Node exposes no `openat`), which left a macOS Peon answering every request with `UNSUPPORTED_PLATFORM`. Withdrawing the capability there only moved the failure: the HTTP fallback requires Overseer to dial the Peon, which is precisely what the reverse socket exists to avoid, so a NAT'd macOS Peon had no working path and the file tree hung instead of answering. Defeating a mid-listing rename needs write access to the Peon's own filesystem — code running as the Peon user, whose agent already reads those files directly — so the capability is advertised unconditionally and no surface branches on the platform. A Peon serves one folder listing at a time, so an overlapping reader is refused with `SYNC_IN_PROGRESS` — routine on open, since a superseded request's cancellation may not have landed yet; callers therefore wait through the shared bounded backoff in `apps/server/src/peonFolderRetry.ts` rather than reporting a busy Peon. Because a suggested project directory does not exist yet, the picker's *first* listing walks up to the nearest existing ancestor; explicit navigation never does, so a missing or unreadable folder is reported. Other pickers (project settings, new session, Peon settings) still browse through the file proxy.

Overseer has one durable [reverse command gateway](reverse-command-gateway.md) for `reverse-command-v1`: it persists the canonical request and server-derived authenticated actor before send, fences acceptance/status/result by workspace, Peon and socket generation, reconciles the same Peon-scoped command ID after reconnect/restart, and commits an allowlisted terminal result + shared durable inbox/checkpoint + safe projection + audit + operator browser event before ACK. The status surface for a bounded HTTP wait is `GET /api/workspaces/:wsId/peons/:peonId/commands/:commandId`. The released v1 operation is session cancel; operation-specific route cutovers still choose either this gateway or legacy HTTP, never both.

Armory inventory, settings, package/configuration/MCP reads and lifecycle
mutations now use that same gateway on negotiated Peons, with exclusive HTTP
fallback for older Peons. Results are bounded and explicitly redacted, while
the Peon's existing package locks, transactional installer, operation store and
restart recovery remain authoritative — see [Armory reverse commands](armory-reverse.md).

Project administration and resources share that gateway: create,
suggest-directory, stable-ID detail/settings/update/delete, bounded
documentation reads, skill discovery and quick-link CRUD are typed
`project.*` operations. Selected projects travel only as immutable
`projectId`; mutations carry a canonical digest, are durably deduplicated by
command ID, and publish through `project-catalog-v1`. Older Peons retain the
exclusive HTTP compatibility route. The terminal allowlists and bounded cursor
contract are in [project reverse commands](project-reverse-commands.md).

Peon daemon settings use the same gateway: [reverse daemon configuration](daemon-configuration.md) projects only the seven safe `daemon-configuration-v1` fields, revision-fences every owner patch, and selects projection/WSS or legacy HTTP exclusively after negotiation and initial state commit.

If a Peon does not return after a restart, follow the short
[Peon restart recovery](peon-restart-recovery.md) checklist. Preserve its
config/state, inspect the native service's first startup error, and do not
restore connectivity by exposing the local listener or re-enabling VPN
callbacks.

Update checks and self-update use that dispatcher while retaining the
authenticated, SHA-256-verified Overseer release channel and replacement
process attestation; see [Peon update channel](peon-update-channel.md).

The remaining direct Peon HTTP/SSE control plane is inventoried and assigned in
[remaining Peon HTTP control plane](remaining-peon-http-control-plane.md).
The independent second-pass 2026-07-30 census finds 79 production call sites
including legacy-only
fallback branches; the design separates projections, bounded queries, durable
commands and transfer streams, and maps every family to existing implementation
tasks rather than creating duplicates. OVSR-229 is the reviewed base
`file-write-v1` implementation; OVSR-49/51/53 retain only their explicit
residual scope.

The Overseer-side [file-write coordinator](file-write-coordinator.md) extends
that base transport with browser-stream correlation, admission quotas, safe
aggregate lifecycle telemetry and deterministic cleanup; it is not a second
command ledger or write protocol.

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

The reusable [protocol conformance and failure-injection harness](protocol-conformance-harness.md) lives in the private `@rnm/protocol-conformance` workspace. Its stable slice executes shared socket/catalog/folder/file-read golden frames, a 3×3 Peon/Overseer capability and exclusive-downgrade matrix, deterministic drop/duplicate/reorder/reconnect/restart faults, bounded redacted diagnostics, and a NAT assertion that fails on any Overseer→Peon dial. Reverse commands, enrollment, transcripts, writes and rollout remain explicit blocked extension cells until their contracts, adapters and acceptance coverage are complete.

The complete [`transcript-sync-v1` snapshot/projection/relay](transcript-sync.md)
is independent of reverse commands and enrollment: Peon freezes bounded
canonical JSONL snapshots and publishes post-barrier commits through the shared
durable outbox; Overseer stages atomically, commits projection + inbox cursor +
ACL-scoped browser event before ACK, shares one demand per Peon/session, fences
socket generations, exposes freshness, and evicts only whole rebuildable
transcripts.

Deleting a project unregisters it and nothing more: the Peon drops its record (refusing with `409 PROJECT_RUNNING` while a session is running against it, and leaving already-recorded sessions with the project key they carry), while the directory and its files stay on disk. The owner-only Settings action needs the Peon online because the Peon owns the record. After a confirmed reverse-command or legacy-HTTP deletion, Overseer immediately evicts its cached project and access grants through `forgetIndexedProject` instead of waiting for the following catalog event; that event then becomes an idempotent no-op.

Every file the web client shows — a message attachment, a project file, a documentation page, a session artifact — is named by one `FileSource` (`apps/web/src/pages/peon/fileLinks.ts`) and read by one reader/renderer (`apps/web/src/pages/peon/FileView.tsx`); a surface contributes only its chrome. Message attachments have their own route, `GET /api/workspaces/:wsId/peons/:id/attachments?path=`, because a transcript names an attachment by the Peon's *absolute* path while `/files/...` is relative to `fileTransferRoot` — Overseer maps one to the other in `apps/server/src/peonFileSandbox.ts` and answers `400 PATH_ESCAPE` / `503 FILES_DISABLED` with a sentence the viewer shows. Details, including why the path travels as a query parameter, are in [showing a file](file-viewing.md). File traffic is moving off the Peon's HTTP API: project file bodies take `project-file-read-v1` on the transfer socket, project directory listings take project-scoped `folder-listing-v1` on the control socket, attachment reads take `sandbox-file-read-v1`, and attachment/project uploads plus scoped project rename take `file-write-v1`. Every operation keeps an exclusive HTTP fallback only for an older Peon that did not negotiate its capability; a selected socket failure never retries the mutation over HTTP.

Session artifacts and base previews take `session-artifact-v1` on that same
outbound transfer socket: authoritative session ID plus a contained path for
metadata, Range/download bytes, preview handoff and debounced refresh watches.
They reuse the file reader's credit, backpressure, cancellation, tombstone and
generation fencing, so a negotiated Peon needs no inbound callback for these
flows. Advanced push-on-change preview leases and atomic multi-asset revisions
remain outside this base capability.

An iOS Live Activity server surface shipped on 2026-07-27 (`/api/push/live-activities*`, tables `live_activity_tokens` and `live_activity_claims`): one aggregate per operator per device connection, keyed by (user, device, connection). Registration takes a `connectionId` and never a `workspaceId`/`peonId`/`sessionId`, and the content state is `runningCount`/`completedCount`/`oldestStartedAt`/`updatedAt` — the contract is in [push notifications](push-notifications.md#ios-live-activities), and `apps/server/src/liveActivity.test.ts` holds start/update/end to it. It is dormant in production until an iOS client registers ActivityKit tokens — no tokens, no pushes, and behaviour on a real handset is still unverified.

A separate product — the instructions site — lives in `site/` (Vite + Tailwind v4 + Motion/Lenis), runs on 127.0.0.1:4582, is published for dev at https://dev.ovrseer.org and is destined for Cloudflare Pages — see [instructions site](static-site.md). It is not under version control at all yet; OVSR-237 gives it a repository and detaches it from this tree, and it does not join the monorepo.

Peon, the Overseer server, the web dashboard and the Flutter client are being brought into one repository — the existing `rnm-dev/overseer`, so the remote and the deploy paths survive. The reason is that a single wire contract currently lives in four hand-synced places (the canonical `peon/PROTOCOL.md`, its self-described "vendored snapshot" here, the vendored `reverse-command-v1` schema and fixtures, and the client's hand-written Dart models), plus two `docs/` trees covering the same topics. Directories name the role (`apps/server`, `apps/web`, `apps/client`, `apps/peon`, `packages/protocol`) and package manifests name the product (`@rnm/overseer-server`, `@rnm/overseer-web`, `@rnm/peon`, `@rnm/protocol`), so "overseer" stops meaning three things at once. GitHub Actions are not used — the only workflow in the picture is the client's, it goes away, and a root `npm run verify` covering every workspace plus `flutter analyze`/`flutter test` takes its place.

The work is epic **Монорепо**. OVSR-238 is **released to production**: the checkout root was flattened from `/rnm/overseer/app` to `/rnm/overseer`, the server and the dashboard became `apps/server` and `apps/web`, and `docs/`, `infra/` and compose came under version control with them. Peon now lives in `apps/peon` as the `@rnm/peon` workspace. Remaining: OVSR-237 (give the instructions site its own repository and detach it) → OVSR-239 (`packages/protocol`) → the publishing and fleet-update-channel part of OVSR-240 → OVSR-241 (Flutter client). The layout and the constraints that were measured rather than assumed — npm rejects the `workspace:` protocol, the npm name `peon` is taken, Peon's Overseer-served SHA-256-verified update channel must not be replaced by the public registry, the Flutter client shares no dependency graph with the Node packages — are in [monorepo](monorepo.md).

Peon-initiated enrollment is frozen as `peon-claim-v1`: outbound HTTPS short
polling, stable Ed25519 machine identity, one encrypted-at-rest credential
delivery replayed until acknowledgement, explicit recovery/rotation/revocation,
generation-fenced socket replacement, and no automatic legacy downgrade after a
claim begins. OVSR-210 defines only the contract, schemas, fixtures and
conformance tests; OVSR-145/147 still implement it, and legacy `/enroll` remains
until OVSR-211. Artifact ownership and the settled security decisions are in
[Peon-initiated enrollment](peon-claim-v1.md).

Pages this index does not otherwise reach: [server design notes](server-design.md) holds the settled decisions, the robustness model and the roadmap; [architecture](architecture.md) holds the rules for organising the code itself; [the dev box](dev-box.md) holds how the stack is served and operated on nid-dev; [deploy runbook](deploy-runbook.md) holds the Kamal preparation, the persistent-volume rules and rollback; [public website PRD](public-website-prd.md) belongs to the instructions site and leaves with it (OVSR-237). There are no `CLAUDE.md` files in this repository — that content lives in the two pages above, and this index is what every session is given.

Project workflow: use Heroboard task tracking for non-trivial implementation, fixes, design, refactors, migrations, publishing, and deployments. Reuse a matching task or create one before work begins. Do not create tasks for read-only checks, diagnostics without requested changes, or genuinely trivial edits. Do not create tasks for preparing a working environment either — pulling or cleaning a checkout, restarting a dev process, installing dependencies. That is part of doing the work; if it matters to whoever picks the work up, note it in the task that needs it.

## Local setup

repo: /rnm/overseer (git repo, remote origin git@github.com:rnm-dev/overseer.git, branch master; push after committing before deploying). It is a monorepo: `apps/server` (Express API, `@rnm/overseer-server`) and `apps/web` (React SPA, `@rnm/overseer-web`) are npm workspaces sharing one root lockfile, and `docs/`, `infra/`, `scripts/` and `docker-compose.yml` are versioned with them. `site/`, `backups/`, `secrets/`, `postgres/` and the env files are gitignored. `npm run verify` at the root runs lint plus every workspace's own verify.
sibling repos: git@github.com:rnm-dev/peon.git and git@github.com:rnm-dev/overseer-app.git (the Flutter client, branch main)
github: plain git over SSH is the only interface to GitHub here. The `gh` CLI is not used — its stored credentials were removed on 2026-07-29 (they could not see the rnm-dev organisation anyway: every `gh api repos/rnm-dev/*` answered 404). Do not reintroduce it or plan work around the GitHub API; the apt package `gh` is still installed and awaits removal by root
compose: postgres (compose-net only, 5432 unpublished), app: 127.0.0.1:4580, web: 127.0.0.1:4581 — all three up, postgres healthy
postgres: postgres:5432/overseer overseer/1701e037ee97028cc925d2925e7ec7b0 (not host-published; use docker compose exec postgres psql)
seed: no seed script; schema self-migrates on boot (initDb/MIGRATIONS in apps/server/src/db.ts). No env-seeded admin — auth is now GitHub OAuth with open sign-up (ensureUserFromGithub in apps/server/src/auth.ts; OVERSEER_ADMIN_EMAIL no longer used anywhere), access gated by workspace membership

Dev public origin is https://overseer-dev.rnm.dev. Cloudflare A record remains proxied to 94.247.128.101. Dev app configuration uses OVERSEER_PUBLIC_URL and OVERSEER_PEON_CALLBACK_URL = https://overseer-dev.rnm.dev. Native OAuth accepts both `overseer-dev://oauth/github` and `overseer://oauth/github` through OVERSEER_GITHUB_NATIVE_CALLBACKS so dev and prod mobile builds can be tested against the dev server. The dev database intentionally contains only Nova and its history; shared users/workspaces/devices remain available for login. The empty RNM workspace (1313b906-590b-4b07-b7a3-c37b0e9f14d0) was deleted from dev on 2026-07-20; production RNM was not changed. Its pre-delete dump (SHA-256 761057b1aebb1d7df7734d276bb0cc8340e459e2a9d0960009f0e58443dd1bcd) was the only copy and was deleted on 2026-07-29 with the rest of the dev box's `backups/`; that workspace was empty, so nothing recoverable was in it.

## Production deployment

host: root@94.247.128.103 (nid-01 / nid-prod-coloc.mesh.rnm / Tailscale 100.64.0.5)
tailnet: hs.rnm.dev, MagicDNS suffix mesh.rnm; the production app container resolves and reaches Peons at peon-*.mesh.rnm:4570
deploy: Kamal 2 config /rnm/overseer/apps/server/config/deploy.yml; service overseer; registry image vibze/overseer
current image: vibze/overseer:df4b2b75d1558cec99dc771be52026a536065051 (clean commit, deployed 2026-07-29 — OVSR-238 moved the repository root to `/rnm/overseer` and the production build to the root npm workspaces)
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
