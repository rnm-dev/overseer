# App Store demo workspace

Use the isolated `Northstar Demo` workspace on the development Overseer when
capturing public screenshots. Its names, projects, prompts and session previews
are fictional and contain no customer, operator or infrastructure data.

The seed requires `NODE_ENV=development` and the exact public origin
`https://overseer-dev.rnm.dev`. Either mismatch stops before a database
transaction begins.

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
Peons as connected so mobile enables the read surfaces; production and ordinary
development Peons still derive presence exclusively from the reverse socket.
Mutations are refused, and this helper must never run outside the development
container.

Never capture screenshots from a production connection. Before upload, inspect
every source image at full resolution for names, emails, domains, addresses,
session content, notifications and status-bar overlays.
