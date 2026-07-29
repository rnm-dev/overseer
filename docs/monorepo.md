# Monorepo

Peon, the Overseer server, the web dashboard and the Flutter client move into a
single repository — the existing `rnm-dev/overseer`, so the remote, the Kamal
config and the deployment paths survive the move. Planned as epic **Монорепо**
(OVSR-237 … OVSR-241); nothing has been moved yet.

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
| `apps/server` | `@rnm/overseer-server` | Express API |
| `apps/web` | `@rnm/overseer-web` | React SPA |
| `apps/client` | `overseer_mobile` (pubspec) | Flutter, all platforms |
| `apps/peon` | `@rnm/peon` | daemon + CLI |
| `packages/protocol` | `@rnm/protocol` | the wire contract |

Two rules behind that table:

- **Inside the repo we say "server", "web", "client", "peon".** Without this,
  `overseer` names three different things — the product, the repository and the
  backend — and "look in overseer" stops being an unambiguous sentence.
- **Every package is scoped `@rnm/`, including the private ones.** npm takes a
  workspace's name from its `package.json`, not from its directory, so a mix of
  scoped and unscoped names would leave `npm test -w overseer-web` sitting next
  to `npm test -w @rnm/peon`.

`rnm-dev/overseer` staying the repository root is formally imprecise — it will
contain `apps/peon`, which ships as its own product. A neutral name would cost a
rewrite of every path, remote and deploy reference, and does not earn it.

## No CI — the root `verify` replaces it

GitHub Actions are not used here. `peon` and `overseer` have no `.github`
directory at all; the only workflow in the picture is
`overseer-app/.github/workflows/ci.yml`, and it is removed as part of OVSR-241.

That means path filters are not a concern, and the client becomes the *easiest*
directory to bring in rather than the hardest. It also means the protocol
fixtures are only enforced by whoever runs the tests, so the repository needs one
command that runs everything:

```json
"scripts": {
  "verify": "npm run verify --workspaces --if-present && (cd apps/client && flutter analyze && flutter test)"
}
```

## Constraints found while planning

Each of these was checked against the actual tooling, not assumed.

**`workspace:` is not usable.** On npm 10.8.2 `npm install` fails with
`EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`, and `npm pack` leaves
the literal `"workspace:^"` in the published manifest. Declare workspace
dependencies as ordinary semver ranges (`"@rnm/protocol": "^1.0.0"`) — npm links
the local package by symlink and publishes a valid range. This is why
`@rnm/protocol` must be published publicly alongside `@rnm/peon` rather than kept
private.

**The npm name `peon` is taken** (version 0.1.0, maintainer `tpisto`). `@rnm/peon`
is free.

**Peon's release channel must not change.** In production a Peon is installed
from an npm archive served by Overseer itself, verified by exact size and
SHA-256 against enrollment credentials (`src/cli/update.ts`,
`shared/releaseRegistry.ts`, the `/data/releases` volume). That is what makes a
fleet-wide version gate possible. The public registry is the *installation and
onboarding* channel; Overseer stays the *update* channel for an enrolled fleet.

**Peon's checkout update mode assumes package root == repository root.**
`PACKAGE_ROOT` and `isGitCheckout` need to be separated once the package sits in
`apps/peon`, or `git merge --ff-only` self-update breaks silently.

**Publishing peon publishes its source.** `files: [dist, src, assets,
tsconfig.json]` ships the whole tree (1.7 MB `src`, 1.3 MB `dist`, 960 KB
`assets`). A sweep found no credentials — the only internal reference is a
comment naming `peon-serik.mesh.rnm` in
`src/dashboard/public/components/OverseerCard.jsx`, and the "secrets" a grep
turns up are fake tokens in `src/daemon/__tests__/*`. The tests do not belong in
the tarball. Whether the source should be public at all is a product decision,
not a technical one, and the daemon's default bind addresses and auth deserve a
review before strangers can install it.

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
`backups/`, `secrets/`, `site/`, the env files and the deploy logs.

## Out of scope: the instructions site

The site is a separate product and does **not** join the monorepo. It has to
leave `/rnm/overseer` first (OVSR-237) — and note that it currently has no
repository at all, despite what [instructions site](static-site.md) claims.
Detaching it before the move keeps an unversioned directory out of the history
merge.

## Order

Each step leaves the tree working.

0. **OVSR-237** — give the instructions site a repository and detach it from
   compose and docs. Outside the monorepo; `site/` is gitignored until then, so
   this no longer blocks anything.
1. **OVSR-238** — *done, on branch `monorepo`.* Flattened checkout root, npm
   workspaces, `apps/server` and `apps/web`, root `verify`, `infra/dev` image,
   rewritten compose mounts and Kamal build context.
2. **OVSR-239** — `packages/protocol`; server and web move onto it.
3. **OVSR-240** — publish `@rnm/protocol` and `@rnm/peon`, then bring peon in.
   The only risky step: it touches the fleet's live update channel.
4. **OVSR-241** — bring the Flutter client in as `apps/client`, drop its
   workflow, merge the two `docs/` trees.

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
