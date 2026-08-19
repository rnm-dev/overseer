# Releasing the server image

The server and web SPA ship together as one public image, `vibze/overseer`.
This page is what a version number promises and how a release is made. Peon
releases are separate and go through
[the Peon update channel](peon-update-channel.md); the Flutter client has its
own store versions.

## What the number means

Semantic versioning, with the divisions defined against this product's actual
hazard rather than an API surface nobody links against. Schema migrations
self-apply on boot and are not reversible, so the question a version has to
answer is *can I take this upgrade, and can I go back*.

| Bump | Means |
| --- | --- |
| MAJOR | Going back needs a database restore, or the configuration changed in a way that stops an existing deployment, or the Peon protocol broke. Read the notes before upgrading. |
| MINOR | New behaviour. Any migration leaves a schema the previous image still runs, so `docker compose` can be pointed back at the older tag. |
| PATCH | Fixes, no migrations. |

`0.x` is deliberate while OIDC and the reverse-control cutover are still
moving: the contract is not yet stable, and the leading zero says so.

## Tags

Publish immutable `X.Y.Z` only, plus the commit SHA as a second tag on the same
image for our own debugging. That SHA convention already exists — the
[deploy runbook](deploy-runbook.md) records production deploys by it.

No `latest`, and no moving `stable`. With migrations that apply themselves on
boot, a floating tag turns an ordinary container restart into an unrequested
schema change on somebody else's database. `deploy/docker-compose.yml` pins an
exact version for the same reason.

Git tags follow the existing per-application convention — `peon-v0.12.8`,
`app-v1.0.0+8` — so the server is `server-vX.Y.Z`.

## Cutting a release

1. Decide the number against the table above. Look at what the diff does to
   `apps/server/src/infrastructure/db` before choosing.
2. Bump `version` in the root `package.json`, `apps/server/package.json` and
   `apps/web/package.json`, and the four matching entries in
   `package-lock.json`. Update `SERVER_VERSION` in `apps/server/src/shared/serverVersion.ts`
   — its neighbouring test fails if it drifts from the server manifest.
3. `npm run verify`.
4. Commit and tag `server-vX.Y.Z`. Never build a release from a dirty working
   tree; the deploy runbook's safety invariants apply here too.
5. Build from that commit, for `linux/amd64`, with the repository root as the
   context:

   ```sh
   docker build --pull --platform linux/amd64 \
     -f apps/server/Dockerfile \
     -t vibze/overseer:X.Y.Z \
     -t "vibze/overseer:$(git rev-parse HEAD)" .
   ```

6. Verify the built image before it is public: run it against a throwaway
   Postgres, confirm `/healthz` reports `{"ok":true,"version":"X.Y.Z"}`, and
   confirm a foreign `Host` gets `421`.
7. `docker push` both tags. This is publication — it is not part of an ordinary
   deploy and needs a deliberate decision.
8. Update the pinned tag in `deploy/docker-compose.yml`.

Deploying our own production is a different procedure with its own approvals;
see the [deploy runbook](deploy-runbook.md).

## What an operator can see

`GET /healthz` answers `{"ok":true,"version":"0.1.0"}` and needs no
authentication — it is the one route ahead of host validation, because
container health probes cannot present the public authority. It is also the
only place a self-hosting operator can read what they are running, which is why
the version belongs there.
