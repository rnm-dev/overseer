# Overseer Kamal deployment

This runbook prepares Overseer on `94.247.128.103` without switching public
traffic or migrating production data until those steps are explicitly approved.

## Safety invariants

- Deploy only a reviewed source snapshot; never build the current shared dirty
  working tree as a production release.
- Do not enable the nginx vhost, change Cloudflare, or restore the current
  database during preparation.
- Never delete or reuse `overseer-postgres-data`,
  `overseer-postgres-backups`, or `overseer-releases` during deploy/rollback.
- Postgres is an accessory. `kamal deploy` does not recreate or upgrade it.

## Persistent state

| Docker volume | Mount | Contents |
| --- | --- | --- |
| `overseer-postgres-data` | `/var/lib/postgresql/data` | PostgreSQL cluster |
| `overseer-postgres-backups` | `/backups` | On-host database dumps |
| `overseer-releases` | `/data/releases` | Published Peon release archives |

The backup volume is only the first recovery layer. Copy every cutover dump off
the production host before restoring or switching traffic.

## Controller preparation

From the reviewed checkout:

```sh
cp .kamal/secrets.example .kamal/secrets
chmod 600 .kamal/secrets
```

Provide all six variables without committing their values. `DATABASE_URL` must
use the accessory DNS name:

```text
postgresql://overseer:<password>@overseer-postgres:5432/overseer
```

Validate locally before touching the server:

```sh
npm run verify
docker build --pull -t overseer:production-check .
kamal config
```

## Preparation on nid-01 — no data migration, no DNS switch

Boot the empty Postgres accessory once:

```sh
kamal accessory boot postgres
```

Verify its persistent volumes and health:

```sh
ssh root@94.247.128.103 \
  'docker volume inspect overseer-postgres-data overseer-postgres-backups && \
   docker inspect overseer-postgres --format "{{.State.Health.Status}}"'
```

The application volume is created by the first app deploy. Before a pre-cutover
deploy, confirm the shared proxy routes still list every existing application:

```sh
ssh root@94.247.128.103 'docker exec kamal-proxy kamal-proxy list'
kamal deploy
ssh root@94.247.128.103 \
  'docker volume inspect overseer-releases && docker exec kamal-proxy kamal-proxy list'
```

Because Overseer is the proxy fallback, test both an allowed and rejected Host:

```sh
curl --fail --header 'Host: overseer.rnm.dev' \
  http://94.247.128.103:8080/healthz
curl --include --header 'Host: unrelated.invalid' \
  http://94.247.128.103:8080/api/account
```

The second request must return `421 MISDIRECTED_REQUEST`. Existing named routes
must still target their original containers. Do not install the nginx file yet.

## Backup before cutover

Create a consistent dump of the current compose database on the source host:

```sh
mkdir -p backups
chmod 700 backups
docker compose exec -T postgres \
  pg_dump -U overseer -d overseer --format=custom \
  > "backups/overseer-$(date -u +%Y%m%dT%H%M%SZ).dump"
sha256sum backups/overseer-*.dump
```

Archive the current release volume even when the `releases` table is empty:

```sh
docker run --rm --read-only \
  -v overseer_releases:/source:ro \
  -v "$PWD/backups:/backup" \
  alpine:3.22 tar -C /source -czf /backup/overseer-releases.tgz .
sha256sum backups/overseer-releases.tgz
```

Copy both artifacts to independent storage before continuing.

## Approved data migration

This section is intentionally not executed during preparation.

1. Put the source Overseer into a maintenance window so no writes can race the
   final dump.
2. Produce and checksum a new final database dump and release archive.
3. Stream the dump over SSH into the production backup volume:

   ```sh
   ssh root@94.247.128.103 \
     'docker exec -i overseer-postgres sh -c \
       "umask 077; cat > /backups/overseer-final.dump"' \
     < backups/overseer-final.dump
   ```

4. Restore only after verifying the target database is the intended empty
   cluster:

   ```sh
   ssh root@94.247.128.103 \
     'docker exec overseer-postgres pg_restore \
        -U overseer -d overseer --clean --if-exists \
        /backups/overseer-final.dump'
   ```

5. Restore release bytes into `overseer-releases`, preserving ownership for the
   application `node` user:

   ```sh
   ssh root@94.247.128.103 \
     'docker run --rm -i -v overseer-releases:/target alpine:3.22 \
       sh -c "tar -C /target -xzf - && chown -R 1000:1000 /target"' \
     < backups/overseer-releases.tgz
   ```

   Then restart the app. Startup applies any pending migrations under a
   PostgreSQL advisory lock.
6. Compare migration count and key table counts between source and target.

## Approved nginx and Cloudflare cutover

This section is intentionally not executed during preparation.

1. Create proxied Cloudflare records for `overseer.rnm.dev` and
   `*.preview.overseer.rnm.dev` targeting `94.247.128.103`.
2. Copy `config/nginx/overseer.rnm.dev.conf` to
   `/etc/nginx/sites-available/overseer.rnm.dev` and enable it.
3. Run `nginx -t` before `systemctl reload nginx`.
4. Verify `/healthz`, SPA assets, GitHub OAuth, WebSocket `/api/ws`, Peon
   heartbeat/recruitment, a tokenized preview host, and release download.
5. Keep the source stack and its volumes untouched through the rollback window.

## Rollback

For an application-only regression:

```sh
kamal rollback <previous-version>
```

For a cutover failure, point Cloudflare back to the source host, reload the old
route, and leave the target volumes intact for diagnosis. Do not restore a newer
target dump over the old source database without a separate reconciliation plan.
