# Releasing the server image

The server and web SPA ship together as one public image, `rnmdev/overseer`.
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

`latest` moves with each release and is what the install template names, so an
installation that never thinks about versions still gets the current one. No
moving `stable` beside it: one floating tag is enough, and a second only invites
a guess about which of them is meant.

Know what `latest` costs before recommending it to anyone. Migrations apply
themselves on boot, so a `docker compose pull` — or a restart that happens to
re-resolve the tag — takes an upgrade nobody separately decided to take, and
the 0.2.0 notes are exactly the kind of thing that has to be read first. The
template says so where it names the tag, and points at the exact version to use
instead. An operator who wants upgrades to be deliberate pins `X.Y.Z`; that is
the reason the immutable tags exist and are never rewritten.

Publishing a release therefore moves `latest` as well as pushing `X.Y.Z`. Do
not move it to a build that has not been verified through step 6.

Git tags follow the existing per-application convention — `peon-v0.12.8`,
`app-v1.0.0+8` — so the server is `server-vX.Y.Z`.

## Where the notes live

The public changelog is a page on the instructions site, `changelog/index.html`
in the `overseer-website` repository, served at https://ovrseer.org/changelog/.
It is not in this repository: a self-hoster deciding whether to pull a tag reads
it before they have a checkout, and the release notes belong beside the
documentation that made them want the upgrade. There is no `CHANGELOG.md` here
to keep in step with it.

The page is written for the person taking the upgrade, not from the commit log:
what changed for them, and whether they can go back. Anything that makes a
downgrade need a database restore is stated above the feature list, because that
is the one thing they must read before pulling.

## Cutting a release

1. Decide the number against the table above. Look at what the diff does to
   `apps/server/src/infrastructure/db` before choosing.
2. Bump `version` in the root `package.json`, `apps/server/package.json` and
   `apps/web/package.json`, and the four matching entries in
   `package-lock.json`. Update `SERVER_VERSION` in `apps/server/src/shared/serverVersion.ts`
   — its neighbouring test fails if it drifts from the server manifest — and the
   exact version the install template offers as the alternative to `latest`.
3. `npm run verify`.
4. Commit and tag `server-vX.Y.Z`. Never build a release from a dirty working
   tree; the deploy runbook's safety invariants apply here too.
5. Build from that commit, for `linux/amd64`, with the repository root as the
   context:

   ```sh
   docker build --pull --platform linux/amd64 --label service=overseer \
     -f apps/server/Dockerfile \
     -t rnmdev/overseer:X.Y.Z \
     -t "rnmdev/overseer:$(git rev-parse HEAD)" .
   ```

   `latest` is deliberately not tagged here. It is moved in step 7, after the
   image has been verified, so a build that fails verification never becomes
   what a `docker compose pull` fetches.

6. Verify the built image before it is public: run it against a throwaway
   Postgres, confirm `/healthz` reports `{"ok":true,"version":"X.Y.Z"}`, and
   confirm a foreign `Host` gets `421`.
7. `docker push` both tags, then move `latest` onto the same image and push it.
   This is publication — it is not part of an ordinary deploy and needs a
   deliberate decision, and moving `latest` is the half of it that reaches every
   installation that never pinned.
8. Publish the release notes on the instructions site, and check that the
   version the install template offers as the pinned alternative is this one.

Deploying our own production is a different procedure with its own approvals;
see the [deploy runbook](deploy-runbook.md).

## What an operator can see

`GET /healthz` answers `{"ok":true,"version":"0.2.0"}` and needs no
authentication — it is the one route ahead of host validation, because
container health probes cannot present the public authority. It is also the
only place a self-hosting operator can read what they are running, which is why
the version belongs there.
