# overseer — deploy notes (nid-dev)

This is the **deployment/ops** doc for the overseer stack on the `nid-dev` box.
It is NOT the app design doc — that lives in `apps/server/CLAUDE.md` (copied from the
repo). Read this before touching the running stack.

## Where things are

Host: **nid-dev** (`ssh NID-DEV`, root). Everything under `/rnm/overseer/`:

```
/rnm/overseer/           # the git checkout itself — this is the monorepo root
├── package.json         # npm workspaces: apps/*, packages/*
├── package-lock.json    # the single lockfile for every Node workspace
├── docker-compose.yml   # dev stack: postgres + app (API, tsx watch) + web (Vite HMR) + site
├── eslint.config.js     # one config for both workspaces
├── .env                 # secrets + auth config — NOT in git
├── CLAUDE.md            # this file
├── apps/
│   ├── server/          # @rnm/overseer-server — Express API, plus config/ and .kamal/
│   └── web/             # @rnm/overseer-web — React (Vite+TS) dashboard
├── infra/dev/Dockerfile # the shared dev image for both workspaces
├── docs/                # project documentation hub (docs/index.md)
├── site/                # instructions site — separate product, gitignored (OVSR-237)
└── postgres/
    └── data/            # bind-mounted Postgres 16 data dir (system-of-record)
```

## Full-stack shape

Overseer is a full-stack app: **one Express backend** (the capable core — JSON
API for web + mobile, peon control plane, soon WebSocket) and a **React SPA**
that is just a client of it. See `apps/server/CLAUDE.md` for the design rationale (not
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
  in `web/vite.config.ts` `server.hmr`); `allowedHosts` includes `overseer.rnm.dev`.
- Verified end-to-end: login (magic-link + OTP) → dashboard renders live.

## Serving

- **Public URL:** https://overseer.rnm.dev
- **HTML preview URL:** `https://<token>.preview.overseer.rnm.dev/*`. This needs
  a proxied wildcard DNS record for `*.preview.overseer.rnm.dev`; nginx routes
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

## The two network faces (IMPORTANT — see apps/server/CLAUDE.md "Locked decisions")

- **Operator/mobile API** (`/fleet/*` + WS) → public via nginx/Cloudflare. Done.
- **Peon-facing API** (`/agent/v1/peons/*` register+heartbeat, and the
  overseer→peon calls) is meant to be **tailnet-only**. ⚠️ **Tailscale is NOT
  installed on nid-dev yet** and the container currently binds `0.0.0.0`
  *inside* the container (host mapping is loopback-only, so nothing is exposed —
  but there is also no tailnet path to NAT'd peons yet). Before wiring real
  peons: `apt install tailscale && tailscale up`, then give the container the
  tailnet and split the listeners. Until then, test with a peon reachable on
  the same host/LAN.

## Secrets (`.env`)

Generated at setup (2026-07-07), git-ignored. Rotate before this faces real
traffic. Keys:
- `POSTGRES_PASSWORD` — Postgres superuser for the `overseer` DB.
- `OVERSEER_PEON_CALLBACK_URL` — tailnet URL the overseer hands a peon at
  recruitment (`/enroll`), i.e. where peons phone home. Empty ⇒ only *manual*
  recruitment (operator pastes the minted token) works. There is **no shared fleet
  secret**: each peon gets a per-peon, workspace-scoped credential the overseer
  mints (`apps/server/src/credentials.ts`). Operators authenticate only with device tokens.
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

`apps/` holds the code, owned by `peon` (edit it in place). Both services mount
`./apps` plus the root manifests, with an anonymous volume masking the hoisted
`/repo/node_modules`, so ANY changed file — src, index.html, vite.config,
tsconfig — hot-reloads live (API tsx-watch restarts; Vite HMR, polling on via
VITE_POLL). No recreate needed. The two services share one dev image
(`infra/dev/Dockerfile`) and differ only in which workspace they run:
`npm run dev -w @rnm/overseer-server` and `-w @rnm/overseer-web`.

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
  `src/server.ts` but not wired to a Dockerfile yet.
- nid-dev disk was ~92% full at setup — watch it; prune old images with
  `docker image prune -f` if builds start failing on space.
- **Done:** full-stack (Express API + React dashboard), passwordless auth
  (magic-link + OTP → device tokens), CORS for mobile.
- Not yet done: Tailscale + tailnet binding; real email provider (Resend key);
  the resumable WebSocket + event log (roadmap step 3); APNs/FCM. See
  `apps/server/CLAUDE.md` roadmap.
