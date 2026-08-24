# App Store demo workspace

Use the isolated `Northstar Demo` workspace on the development Overseer when
capturing public screenshots. Its names, projects, prompts and session previews
are fictional and contain no customer, operator or infrastructure data.

The seed accepts the development origin, or production only when
`OVERSEER_APP_REVIEW_DEMO=1` is set alongside `NODE_ENV=production` and the
exact public origin `https://overseer.rnm.dev`. Any other combination stops
before a database transaction begins.

Run it inside the development app container after the screenshot operator has
signed in at least once:

```sh
docker compose exec app npm run seed:screenshot-demo -w @rnm-dev/overseer-server -- \
  --owner-email viktor.ten@me.com
```

The command is idempotent. Re-running it refreshes relative activity times and
restores the curated catalog: three fictional Peons, six projects with safe
documentation, and eight completed sessions with curated prompts and previews.

For the complete screenshot tour, start the read-only demo Peon inside the
development app container:

```sh
docker compose exec app npx tsx src/cli/runScreenshotDemoPeon.ts
```

It serves fictional project detail, documentation, files, session detail and
transcript responses on container port 5001. The seed points all three demo
Peons at that endpoint. The development server presents only these seeded
Peons as connected so mobile enables the read surfaces; ordinary Peons still
derive presence exclusively from the reverse socket. When the explicit
production App Review gate is enabled, the server starts the same helper
in-process for the isolated review workspace. Mutations are always refused.

App Review uses the dedicated password-auth identity
`app-review@ovrseer.org`, scoped as a member of only
`demo-screenshot-workspace`. Its password is stored in App Store Connect's
review details and must not be committed to this repository. When rotating it,
replace the user's scrypt hash and update the App Store review credentials
together, then verify a native password login before submission.

Never capture screenshots from a production connection. Before upload, inspect
every source image at full resolution for names, emails, domains, addresses,
session content, notifications and status-bar overlays.
