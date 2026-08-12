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

## Full-stack shape

Overseer is a full-stack app: **one Express backend** (the capable core — JSON
API for web + mobile, peon control plane, soon WebSocket) and a **React SPA**
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
  in `web/vite.config.ts` `server.hmr`); `allowedHosts` includes
  `overseer-dev.rnm.dev`.
- Verified end-to-end: login (magic-link + OTP) → dashboard renders live.

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
  `proxy_read_timeout 24h`) — covers the future resumable WS, session tails, and
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
- Auth (magic-link + OTP → device tokens; see `apps/server/src/auth.ts`):
  `OVERSEER_ADMIN_EMAIL` (seeds the first user on boot), `OVERSEER_PUBLIC_URL`
  (magic-link base), `OVERSEER_AUTH_DEV_ECHO=1` (**dev only** — echoes the OTP +
  link in `/auth/request`; currently ON here), `OVERSEER_RESEND_API_KEY` +
  `OVERSEER_EMAIL_FROM` (real email; empty ⇒ console transport logs the code).

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

`apps/` holds the code (edit it in place; see the ownership note below). Both services mount
`./apps` plus the root manifests, with an anonymous volume masking the hoisted
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

Migrations run automatically on app boot (`initDb()` in `apps/server/src/db.ts`),
so a restart (which every reload is) keeps the schema in sync.

## Notes / TODO

- Dev Dockerfiles install deps + run watch servers; no `dist/`, no compile in dev.
  A prod single-container build (Express static-serving `web/dist`) is stubbed in
  `src/app/server.ts` but not wired to a Dockerfile yet.
- nid-dev disk was ~92% full at setup — watch it; prune old images with
  `docker image prune -f` if builds start failing on space.
- **Done:** full-stack (Express API + React dashboard), passwordless auth
  (magic-link + OTP → device tokens), CORS for mobile.
- Not yet done: Tailscale + tailnet binding; real email provider (Resend key);
  the resumable WebSocket + event log (roadmap step 3); APNs/FCM. See
  [server design notes](server-design.md) roadmap.
