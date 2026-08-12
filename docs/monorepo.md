# Monorepo

Peon, the Overseer server, the web dashboard and the Flutter client live in a
single repository — the existing `rnm-dev/overseer`, so the remote, the Kamal
config and the deployment paths survive the move. Planned as epic **Монорепо**
(OVSR-237 … OVSR-241). The server, web dashboard, Peon and cross-platform
Flutter client now live here; the shared protocol package remains to be moved.

## Why

One wire contract currently lives in four places, kept in sync by hand:

- `peon/PROTOCOL.md` — the canonical copy;
- `overseer/PROTOCOL.md` — a copy whose own header calls it a *vendored
  snapshot* and asks the reader to re-copy it when the contract changes;
- `overseer/protocol/reverse-command-v1/{schema.json,fixtures.json}` — vendored
  the same way;
- `overseer-app/lib/features/*/domain/*_models.dart` — a third, hand-written
  implementation of the same messages (`fleet_models.dart`,
  `session_models.dart`, `peon_settings_models.dart`,
  `web_socket_fleet_live_protocol.dart`, …).

On top of that the client carries its own `docs/` describing the same contracts
as this one: `push-notifications.md`, `voice-input.md`, `live-activities.md`,
plus fleet/sessions/project-files pages.

So the point of the move is **one owner for the contract**, not build speed.
Shared tooling is a side benefit for the Node packages and no benefit at all for
the Flutter client, which shares no dependency graph with them.

## Layout

```
overseer/
├── package.json                   # workspaces: ["apps/*","packages/*"]
├── packages/
│   └── protocol/                  # schema + fixtures + PROTOCOL.md + generated TS types
├── apps/
│   ├── server/                    # Express API
│   ├── web/                       # React SPA
│   ├── client/                    # Flutter — android/ios/linux/macos/windows
│   └── peon/                      # daemon + CLI
├── docs/
├── infra/dev/Dockerfile           # one dev image for both Node workspaces
└── docker-compose.yml             # dev stack: postgres, app, web, site
```

Production is built from `apps/server/Dockerfile` with the **repository root** as
its Docker context — a single lockfile lives there, so the build cannot be
scoped to one app directory. Kamal still deploys from `apps/server` (its
`config/` and `.kamal/` travel with the app it deploys) and passes
`builder.context: ../..`.

## Naming convention

Directories name the **role**, package manifests name the **product**:

| Directory | Package name | What it is |
| --- | --- | --- |
| `apps/server` | `@rnm-dev/overseer-server` | Express API |
| `apps/web` | `@rnm-dev/overseer-web` | React SPA |
| `apps/client` | `overseer_mobile` (pubspec) | Flutter, all platforms |
| `apps/peon` | `@rnm-dev/peon` | daemon + CLI |
| `packages/protocol` | `@rnm-dev/protocol` | the wire contract |

Two rules behind that table:

- **Inside the repo we say "server", "web", "client", "peon".** Without this,
  `overseer` names three different things — the product, the repository and the
  backend — and "look in overseer" stops being an unambiguous sentence.
- **Every package is scoped `@rnm-dev/`, including the private ones.** npm takes a
  workspace's name from its `package.json`, not from its directory, so a mix of
  scoped and unscoped names would leave `npm test -w overseer-web` sitting next
  to `npm test -w @rnm-dev/peon`.

`rnm-dev/overseer` staying the repository root is formally imprecise — it will
contain `apps/peon`, which ships as its own product. A neutral name would cost a
rewrite of every path, remote and deploy reference, and does not earn it.

## No CI — the root `verify` replaces it

GitHub Actions are not used here. `peon` and `overseer` have no `.github`
directory at all; the only workflow in the picture is
`overseer-app/.github/workflows/ci.yml`, and it was removed as part of OVSR-241.

That means path filters are not a concern, and the client becomes the *easiest*
directory to bring in rather than the hardest. It also means the protocol
fixtures are only enforced by whoever runs the tests, so the repository needs one
command that runs everything:

```json
"scripts": {
  "verify": "npm run lint && npm run verify --workspaces --if-present && npm run verify:client",
  "verify:client": "if command -v flutter >/dev/null 2>&1; then cd apps/client && flutter analyze && flutter test; else echo 'SKIPPED: Flutter client verification (flutter is not installed)'; fi"
}
```

## Constraints found while planning

Each of these was checked against the actual tooling, not assumed.

**`workspace:` is not usable.** On npm 10.8.2 `npm install` fails with
`EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`, and `npm pack` leaves
the literal `"workspace:^"` in the published manifest. Declare workspace
dependencies as ordinary semver ranges (`"@rnm-dev/protocol": "^1.0.0"`) — npm links
the local package by symlink and publishes a valid range. This is why
`@rnm-dev/protocol` must be published publicly before Peon starts depending on
it rather than kept private.

**The npm name `peon` is taken** (version 0.1.0, maintainer `tpisto`), and the
`@rnm` npm scope was unavailable. The npm organisation is `rnm-dev`; the
`rnmdev` account owns it with 2FA enabled. Public packages therefore use the
`@rnm-dev/` scope, matching the GitHub organisation.

**Peon's release channel is public npm.** Production installs and enrolled
fleet updates both resolve `@rnm-dev/peon` from npm. Overseer authorizes the
owner's check/apply/status request and relays it to the selected Peon over Fleet
HTTP, but never stores or streams release metadata or bytes. Peon binds an
admitted update to an exact version, relies on npm integrity verification, and
packs the current installation locally before replacement so rollback does not
depend on the network.

**Peon's checkout update mode assumes package root == repository root.**
`PACKAGE_ROOT` and `isGitCheckout` need to be separated once the package sits in
`apps/peon`, or `git merge --ff-only` self-update breaks silently.

**The public Peon package is compiled distribution, not the source tree.**
`files: [dist, assets]` plus npm's automatic README, LICENSE and manifest keeps
tests, fixtures, TypeScript sources and build configuration out of the tarball.
Peon is MIT licensed. `prepack` always rebuilds `dist`; release verification
installs and exercises that exact archive before publication. The daemon and
dashboard bind to loopback by default. Wider binding remains an explicit
operator action and is rejected in reverse-only fleet mode.

**The client is Flutter, not React Native.** Flutter 3.44.8, Dart SDK `^3.12.2`,
Riverpod 3, go_router, dio, drift, freezed, firebase_messaging, and desktop
targets besides the mobile ones. It lives on pub, not npm — verified that npm
silently ignores a directory without a `package.json` under an `apps/*` glob, so
it sits inside the workspace tree without participating in it. Version streams
diverge too: npm semver for peon against `1.0.0+2` with a build number for the
app, so release tags need prefixes (`peon-v*`, `app-v*`).

## Settled: the checkout root was flattened

The repository used to be `/rnm/overseer/app`, with `/rnm/overseer` — holding
`docker-compose.yml`, `docs/`, `backups/`, `secrets/`, `postgres/` and `site/` —
not a git repository at all, so the documentation injected into every session
was unversioned. OVSR-238 flattened it: the checkout is now `/rnm/overseer`
itself, and `docs/`, `infra/`, `scripts/` and compose are versioned with the
code. `.gitignore` covers what is state rather than source — `postgres/`,
`backups/`, `secrets/`, the env files and the deploy logs.

## Out of scope: the instructions site

The site is a separate product and does **not** join the monorepo. OVSR-237
gave it its own repository (`rnm-dev/overseer-website`) and moved it out of
`/rnm/overseer` to `/rnm/overseer-website`, taking its documentation with it.
Only the `site` dev service in compose still points at that sibling checkout.

## Order

Each step leaves the tree working.

0. **OVSR-237** — *done.* The instructions site has its own repository and left
   the tree for `/rnm/overseer-website`; compose builds it from there.
1. **OVSR-238** — *released to production.* Flattened checkout root, npm
   workspaces, `apps/server` and `apps/web`, root `verify`, `infra/dev` image,
   rewritten compose mounts and Kamal build context.
2. **OVSR-239** — `packages/protocol`; server and web move onto it, then publish
   it as `@rnm-dev/protocol`.
3. **OVSR-240** — *released.* Peon lives in `apps/peon` as the
   `@rnm-dev/peon` workspace. Public `0.11.3` was published to npm on
   2026-07-30; `0.12.8` was published and canary-updated on 2026-08-12. Both
   were verified by clean registry installs, and the updater's locally packed
   archive provides rollback for the compiled-only distribution. npm is the
   installation and enrolled-fleet package channel; Overseer relays only the
   authenticated control request.
4. **OVSR-241** — *done locally.* The Flutter client is in `apps/client`, its
   GitHub Actions workflow is gone, and its documentation lives under
   `docs/client/`.

The npm organisation is `rnm-dev` (`@rnm` was unavailable), so every Node
package is `@rnm-dev/*`. The updater derives and preserves the existing global
npm prefix and packs rollback archives with lifecycle scripts disabled, which
the compiled-only npm distribution requires.

On 2026-07-30 nid-dev (`94.247.128.101`, user `peon`) was migrated in place from
unscoped `peon@0.11.1` to `@rnm-dev/peon@0.11.3`: its Peon ID and all 556
sessions were preserved, both reverse sockets reconnected with an empty outbox,
and the old package remains for rollback. The verified pre-migration archive is
on that host at `/root/peon-migration-backups/20260730T183400Z/`.

Merging histories is cheap at this size — `.git` is 13 MB for overseer, 6.3 MB
for peon, 8.4 MB for the client — so `git read-tree --prefix=` into subdirectories
preserves `git log --follow` without any rewriting.

## Access note

Plain git over SSH is the only interface to GitHub on this box, and every step
above is planned that way — merging histories, moving directories and pushing
need nothing else.

The `gh` CLI is deliberately not part of the toolchain: its stored token could
not see the `rnm-dev` organisation (`gh api repos/rnm-dev/peon` → 404, likewise
every sibling), and the credentials were removed on 2026-07-29. The one step
that did assume the API — creating the instructions site's repository in
OVSR-237 — is done through the GitHub web UI instead, then wired up with
`git remote add` over SSH.
