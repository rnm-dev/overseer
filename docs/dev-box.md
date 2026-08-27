# The dev box (nid-dev)

How the Overseer stack is served, run and operated on the `nid-dev` box: ports,
nginx, the compose services, the secrets it reads and the everyday commands.
Read this before touching the running stack.

It is not the design doc — the API's decisions and roadmap are in
[server design notes](server-design.md), and its code-organisation rules are in
[architecture](architecture.md). Production deployment is in
[deploy runbook](deploy-runbook.md).

## Where things are

Host: **nid-dev** (`ssh NID-DEV`, root). Everything under `/rnm/overseer/`:

```
/rnm/overseer/           # the git checkout itself — this is the monorepo root
├── package.json         # npm workspaces: apps/*, packages/*
├── package-lock.json    # the single lockfile for every Node workspace
├── docker-compose.yml   # dev stack: postgres + app (API, tsx watch) + web (Vite HMR) + site
├── eslint.config.js     # one config for both workspaces
├── .env                 # secrets + auth config — NOT in git
├── apps/
│   ├── server/          # @rnm-dev/overseer-server — Express API, plus config/ and .kamal/
│   └── web/             # @rnm-dev/overseer-web — React (Vite+TS) dashboard
├── infra/dev/Dockerfile # the shared dev image for both workspaces
├── docs/                # project documentation hub (docs/index.md)
└── postgres/
    └── data/            # bind-mounted Postgres 16 data dir (system-of-record)
```

The checkout is the git repository `git@github.com:rnm-dev/overseer.git`, branch
`master` — commit and **push before deploying**. `apps/server` and `apps/web`
are npm workspaces sharing the one root lockfile; `docs/`, `infra/`, `scripts/`
and `docker-compose.yml` are versioned with them, while `backups/`, `secrets/`,
`postgres/` and the env files are gitignored. `npm run verify` at the root runs
lint plus every workspace's own verify.

The instructions site is a separate product in its own repository, checked out
beside this tree at `/rnm/overseer-website`; the sibling Flutter client is
`git@github.com:rnm-dev/overseer-app.git`, branch `main`.

**GitHub access is plain git over SSH, and only that.** The `gh` CLI is not
used — its stored credentials were removed on 2026-07-29 and could not see the
`rnm-dev` organisation anyway (every `gh api repos/rnm-dev/*` answered 404). Do
not reintroduce it or plan work around the GitHub API. The apt package is still
installed and awaits removal by root.

Compose services: `postgres` (compose-net only, 5432 unpublished),
`app` on 127.0.0.1:4580, `web` on 127.0.0.1:4581, `site` on 127.0.0.1:4582.
The database is `postgres:5432/overseer`, user `overseer`, and is not
host-published — reach it with `docker compose exec postgres psql`.

There is **no seed script**: the schema self-migrates on boot (`initDb`/
`MIGRATIONS` in `apps/server/src/infrastructure/db/migrations.ts`) and there is no env-seeded admin.
Sign-in is GitHub OAuth with open sign-up (`ensureUserFromGithub` in
`apps/server/src/modules/auth/authOAuth.ts`), plus email/password and OIDC where the instance
enables them — see [sign-in methods](sign-in-methods.md). Access is gated by
workspace membership.

## Dev origin and data

The public origin is https://overseer-dev.rnm.dev (proxied Cloudflare A record
→ 94.247.128.101). `OVERSEER_PUBLIC_URL` and `OVERSEER_PEON_CALLBACK_URL` both
name it. Native OAuth accepts both `overseer-dev://oauth/github` and
`overseer://oauth/github` through `OVERSEER_GITHUB_NATIVE_CALLBACKS`, so dev and
prod mobile builds can both be tested against this server.

The dev database intentionally holds only Nova and its history; shared
users/workspaces/devices remain available for login. The empty RNM workspace
(`1313b906-590b-4b07-b7a3-c37b0e9f14d0`) was deleted from dev on 2026-07-20 —
production RNM was untouched — and its pre-delete dump was the only copy, which
went on 2026-07-29 with the rest of this box's `backups/`. The workspace was
empty, so nothing recoverable was in it.

## Full-stack shape

Overseer is a full-stack app: **one Express backend** (the capable core — JSON
API for web + mobile, peon control plane, the live WebSocket) and a **React SPA**
that is just a client of it. See [server design notes](server-design.md) for the design rationale (not
Next.js — keep the capable backend).

- **`app` service** — Express API, `tsx watch` on container `:5000` → host
  `127.0.0.1:4580`.
- **`web` service** — Vite dev server (HMR) on container `:5173` → host
  `127.0.0.1:4581`. Built from `infra/dev/Dockerfile`.
- nginx routes `/fleet` + `/agent` → `app` (4580), everything else → `web`
  (4581). So the browser hits one origin; the React app calls `/fleet/*`
  same-origin; **mobile** calls the same `/fleet/*` cross-origin (CORS is on).

## Dev mode (HMR for web, auto-restart for API)

One compose file, dev-oriented. `docker compose up -d`:
- **API** runs `tsx watch` — an edit to `apps/server/src` restarts the process.
- **Web** runs the Vite dev server — an edit to `apps/web/src` **hot-reloads
  the browser** (true HMR). HMR speaks `wss:443` through Cloudflare (configured
  in `apps/web/vite.config.ts` `server.hmr`); `allowedHosts` includes
  `overseer-dev.rnm.dev`.
- Verified end-to-end: sign-in → dashboard renders live.

## Serving

- **Public URL:** https://overseer-dev.rnm.dev
- **HTML preview URL:** `https://<token>.preview.overseer-dev.rnm.dev/*`. This
  needs a proxied wildcard DNS record for `*.preview.overseer-dev.rnm.dev`;
  nginx routes
  the entire wildcard host to the API, which validates the expiring token and
  proxies only files beneath that preview's root.
- **TLS:** terminated by **Cloudflare** (rnm.dev is proxied). nginx on the host
  listens plain `:80` and sets `X-Forwarded-Proto https`. No local certbot cert
  for this host — it's Cloudflare-Flexible/Full, same as the other `*.rnm.dev`
  vhosts.
- **nginx vhost:** `/etc/nginx/sites-enabled/overseer.rnm.dev`. Routes `/fleet`
  + `/agent` → API (`127.0.0.1:4580`) and everything else → Vite (`127.0.0.1:4581`).
  WebSocket/SSE upgrade enabled on all locations (`$connection_upgrade` map +
  `proxy_read_timeout 24h`) — covers the live resumable WS, session tails and
  Vite HMR.
- **Host ports:** API `127.0.0.1:4580`, web/Vite `127.0.0.1:4581`. Both
  loopback-only; the internet reaches them only via nginx.
- Note: `/healthz` (API liveness) is only reachable on the container directly
  (`curl 127.0.0.1:4580/healthz`) — nginx sends non-`/fleet`,-`/agent` paths to Vite.

## The two network faces (IMPORTANT — see [server design notes](server-design.md), "Locked decisions")

- **Operator/mobile API** (`/fleet/*` + WS) → public via nginx/Cloudflare. Done.
- **Peon-facing API** (`/agent/v1/peons/*` register+heartbeat, and the
  overseer→peon calls) is **tailnet-only**. nid-dev is Tailscale node
  `100.64.0.1`; the app container reaches Peons through the host's mesh routes.

### Dev direct-path stability

The self-hosted Headscale control plane runs on nid-01. Its
`/etc/headscale/policy.hujson` applies the `randomize-client-port` node
attribute only to the two dev-path endpoints, nid-dev (`100.64.0.1`) and
Viktor's Mac/Peon (`100.64.0.3`). Both endpoints must carry the attribute:
targeting only one side left the direct UDP path asymmetric and lossy. The
production Overseer node (`100.64.0.5`) is deliberately not targeted.

This replaced an observed 80–90% tailnet packet-loss condition with 0 loss in
200 packets in each direction and about 9 ms average RTT. Do not work around a
regression by pinning DERP with host firewall rules; first check
`tailscale ping`, `tailscale status --json` (`RandomizeClientPort`) on both dev
endpoints, and `headscale policy check -f /etc/headscale/policy.hujson` on
nid-01.

The pre-change Headscale config and final applied policy are backed up on
nid-01 under `/root/headscale-backups/20260810-dev-randomize-client-port/`.
Rollback is to restore `config.yaml.before` to `/etc/headscale/config.yaml`,
move `/etc/headscale/policy.hujson` aside, and restart Headscale. This changes
the shared control plane, so verify that only the two dev node addresses are
targeted before every edit.

## Secrets (`.env`)

Generated at setup (2026-07-07), git-ignored. Rotate before this faces real
traffic. Keys:
- `POSTGRES_PASSWORD` — Postgres superuser for the `overseer` DB.
- `OVERSEER_PEON_CALLBACK_URL` — tailnet URL the overseer hands a peon at
  recruitment (`/enroll`), i.e. where peons phone home. Empty ⇒ only *manual*
  recruitment (operator pastes the minted token) works. There is **no shared fleet
  secret**: each peon gets a per-peon, workspace-scoped credential the overseer
  mints (`apps/server/src/modules/fleet/credentialsService.ts`). Operators authenticate only with device tokens.
- Auth → device tokens; see `apps/server/src/modules/auth/` and
  [sign-in methods](sign-in-methods.md). `OVERSEER_PUBLIC_URL` is the origin
  every door is built against; `OVERSEER_PASSWORD_AUTH=1` opens email/password
  (on here), and the `OVERSEER_OIDC_*` pair names an OIDC issuer and client.
  There is no `OVERSEER_ADMIN_EMAIL` seeding and no magic-link flow any more —
  both were removed.

## Common ops

```bash
ssh NID-DEV
cd /rnm/overseer

# bring up / rebuild after a code change
docker compose up -d --build

# logs
docker compose logs -f app
docker compose logs -f postgres

# restart just the app
docker compose restart app

# stop / start the whole stack
docker compose down          # keeps postgres/data (bind mount)
docker compose up -d

# psql into the DB
docker compose exec postgres psql -U overseer -d overseer

# health check (liveness, no auth) — container only:
curl -s http://127.0.0.1:4580/healthz
# operator API now needs a device token (GitHub OAuth login), mounts at /api, and is
# workspace-scoped, e.g. GET /api/workspaces/<wsId>/status -H "Authorization: Bearer <deviceToken>"
```

## Updating the code

`apps/` and `packages/` hold the code (edit them in place; see the ownership
note below). Both services mount `./apps` and `./packages` plus the root manifests, with an anonymous volume masking the hoisted
`/repo/node_modules`, so ANY changed file — src, index.html, vite.config,
tsconfig — hot-reloads live (API tsx-watch restarts; Vite HMR, polling on via
VITE_POLL). No recreate needed. The two services share one dev image
(`infra/dev/Dockerfile`) and differ only in which workspace they run:
`npm run dev -w @rnm-dev/overseer-server` and `-w @rnm-dev/overseer-web`.

The checkout is not uniformly owned by `peon`: most of it, `apps/peon` included,
is owned by `root` with group `rnm` and setgid group-writable directories, so the
`peon` user edits files through the group. That is enough to write a file but not
to `chmod`/`utimes` one, which is what any tool that rewrites an existing
root-owned file trips over — `npm install` fails `EPERM` on the workspace bin
(`apps/peon/dist/cli/peon.js`) and `@rnm-dev/peon`'s `compile` fails `EPERM` copying
into `apps/peon/dist`. Both were repaired on 2026-07-29 by handing `node_modules`
and `apps/peon/dist` to `peon` (`docker run --rm -v /rnm/overseer:/repo node:22
chown -R 1018 <path>` — there is no root shell here). If a root-run build takes
those directories back, the same two failures return; hand them over again rather
than working around them. Beware of a *partially* completed `compile`: it leaves
committed artifacts damaged (the CLI keeps its dev `--import tsx` shebang because
`fixCliShebang.mjs` never ran), so check `git status apps/peon` and restore before
doing anything else.

A completed `npm install` also rewrites `package-lock.json` with `"peer": true`
annotations on esbuild's platform packages. That is npm correcting the committed
lockfile, not version churn, and it comes back on every install.

Dependency change (package.json/lock) or Dockerfile change — rebuild AND renew
the anon node_modules volume with `-V`, else the container keeps the stale one:

```bash
cd /rnm/overseer && docker compose up -d --build -V
```

Migrations run automatically on app boot (`initDb()` in `apps/server/src/infrastructure/db/index.ts`),
so a restart (which every reload is) keeps the schema in sync.

## Notes

- Dev images install dependencies and run watch servers: no `dist/`, no compile
  step in dev. The production build is a different path entirely —
  `apps/server/Dockerfile`, built and shipped by Kamal; see the [deploy
  runbook](deploy-runbook.md).
- **Disk is the standing risk on this box.** It was ~92% full at setup and is
  still ~95% (23 GB free of 438 GB as of 2026-08-12). Prune with
  `docker image prune -f` before blaming a failing build on anything else.
