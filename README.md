# Overseer

Monorepo for the Overseer fleet control plane and the things that talk to it.

| Path | Package | What it is |
| --- | --- | --- |
| `apps/server` | `@rnm/overseer-server` | Express API — the control plane. Its design notes are in [`apps/server/README.md`](apps/server/README.md) and [`apps/server/CLAUDE.md`](apps/server/CLAUDE.md). |
| `apps/web` | `@rnm/overseer-web` | React (Vite) operator dashboard |

Directories are named for the role, package manifests for the product, so
"overseer" names the product and this repository rather than also naming the
backend. Two more workspaces are planned — `packages/protocol` for the single
wire contract, then `apps/peon` and `apps/client` — see
[docs/monorepo.md](docs/monorepo.md).

## Working in it

The workspaces share one lockfile and one ESLint config. There is no CI: the
root `verify` is what runs instead, and it is expected to be green before a
deploy.

```bash
npm install          # installs every workspace
npm run verify       # lint + each workspace's own tests, typecheck and build
npm run dev          # the API under tsx watch (the dashboard is a compose service)
```

The dev stack — Postgres, the API, the dashboard and the instructions site —
runs from `docker-compose.yml`; the shared dev image is `infra/dev/Dockerfile`.
Operational detail for the box it runs on lives in [CLAUDE.md](CLAUDE.md).

Production is one image built from `apps/server/Dockerfile` with the repository
root as its Docker context, deployed with Kamal from `apps/server`. The runbook
is [docs/deploy-runbook.md](docs/deploy-runbook.md).

## Documentation

[`docs/index.md`](docs/index.md) is the hub — start there.
