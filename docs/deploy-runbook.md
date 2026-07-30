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
- Preserve the validated proxy chain in [trusted client IPs](proxy-trust.md):
  the app/container port is not public, the shared Kamal ports must reach the
  target loopback-only binding, nginx canonicalizes Cloudflare identity, and
  `OVERSEER_TRUSTED_PROXIES` names only controlled local proxy networks.
- During OVSR-248 review, the production Kamal listeners were wildcard
  host-bound on both 8080 and 8443 (`0.0.0.0/[::]`). An independent external
  request to 8080 returned HTTP 200; the 8443 probe timed out with no HTTP
  response (possibly filtered), so only 8080 was demonstrated
  Internet-reachable. Do not describe the target invariant as deployed until
  the approved proxy reboot, exact loopback binding checks, and both external
  negative probes below succeed.

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
node --import tsx --test --test-concurrency=1 \
  apps/server/src/proxyTrust.test.ts
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

Because Overseer is the proxy fallback, test both an allowed and rejected Host
from nid-01 loopback. Never make public 8080 a required health path:

```sh
ssh root@94.247.128.103 \
  "curl --fail --header 'Host: overseer.rnm.dev' \
    http://127.0.0.1:8080/healthz"
ssh root@94.247.128.103 \
  "curl --include --header 'Host: unrelated.invalid' \
    http://127.0.0.1:8080/api/account"
```

The second request must return `421 MISDIRECTED_REQUEST`. Existing named routes
must still target their original containers. Do not install the nginx file yet.

## Approved shared proxy loopback cutover

This is a production network change and is intentionally **not executed** as
part of OVSR-248 implementation. Kamal's proxy is shared by every application
on nid-01, so an ordinary application deploy must not perform this reboot.

The checked-in `proxy.run` block requires Kamal 2.12+, pins
`basecamp/kamal-proxy:v0.9.2`, keeps the existing 8080/8443 host ports and binds
them only to `127.0.0.1`.

### Required rollback bundle

Create this bundle from the reviewed checkout **before** the maintenance
window. It is the executable representation of the observed legacy boot state,
not merely diagnostic output. The generated `rollback.yml` retains the pinned
v0.9.2 image and 8080/8443 ports but removes `bind_ips`; under Kamal 2.12 that
restores the legacy wildcard `--publish 8080:80 --publish 8443:443` behavior.

`backups/` and `.kamal/secrets` are gitignored. The YAML contains secret
references, never secret values. The captured options, command, bindings, and
routes are machine-specific operational data: keep them mode 0600, copy the
archive to approved off-host storage, and never commit them or attach them to a
task.

Run the following from `apps/server`, where the ignored `.kamal/secrets` file
already lives. `kamal config` includes resolved secrets in its output, so these
commands send that output to `/dev/null`; never redirect it into the rollback
bundle or a task log.

```sh
umask 077
OVSR_REPOSITORY_ROOT="$(cd ../.. && pwd)"
OVSR_PROXY_ROLLBACK_ID="$(date -u +%Y%m%dT%H%M%SZ)"
OVSR_PROXY_ROLLBACK_DIR="$OVSR_REPOSITORY_ROOT/backups/ovsr-248-proxy-$OVSR_PROXY_ROLLBACK_ID"
OVSR_PROXY_ROLLBACK_YML="$OVSR_PROXY_ROLLBACK_DIR/rollback.yml"
mkdir -p "$OVSR_PROXY_ROLLBACK_DIR"
chmod 700 "$OVSR_PROXY_ROLLBACK_DIR"

ruby -ryaml -e '
  source, target = ARGV
  config = YAML.load_file(source)
  run = config.dig("proxy", "run")
  abort "expected loopback bind_ips" unless run["bind_ips"] == ["127.0.0.1"]
  run.delete("bind_ips")
  File.write(target, YAML.dump(config))
' config/deploy.yml "$OVSR_PROXY_ROLLBACK_YML"
chmod 600 "$OVSR_PROXY_ROLLBACK_YML"

ruby -ryaml -e '
  run = YAML.load_file(ARGV.fetch(0)).dig("proxy", "run")
  expected = {
    "repository" => "basecamp/kamal-proxy",
    "version" => "v0.9.2",
    "http_port" => 8080,
    "https_port" => 8443,
    "publish" => true
  }
  abort "rollback proxy.run mismatch: #{run.inspect}" unless run == expected
' "$OVSR_PROXY_ROLLBACK_YML"

kamal config -c "$OVSR_PROXY_ROLLBACK_YML" > /dev/null
kamal proxy details \
  > "$OVSR_PROXY_ROLLBACK_DIR/legacy-proxy-details.txt"
ssh root@94.247.128.103 'cat /root/.kamal/proxy/options' \
  > "$OVSR_PROXY_ROLLBACK_DIR/legacy-options.txt"
ssh root@94.247.128.103 \
  'docker inspect kamal-proxy --format "{{.Config.Image}}"' \
  > "$OVSR_PROXY_ROLLBACK_DIR/legacy-image.txt"
ssh root@94.247.128.103 \
  'docker inspect kamal-proxy --format "{{json .Path}} {{json .Args}}"' \
  > "$OVSR_PROXY_ROLLBACK_DIR/legacy-command.txt"
ssh root@94.247.128.103 \
  'docker inspect kamal-proxy --format "{{json .HostConfig.PortBindings}}"' \
  > "$OVSR_PROXY_ROLLBACK_DIR/legacy-bindings.json"
ssh root@94.247.128.103 \
  'docker exec kamal-proxy kamal-proxy list' \
  > "$OVSR_PROXY_ROLLBACK_DIR/legacy-routes.txt"
chmod 600 "$OVSR_PROXY_ROLLBACK_DIR"/*

test "$(cat "$OVSR_PROXY_ROLLBACK_DIR/legacy-options.txt")" = \
  '--publish 8080:80 --publish 8443:443 --log-opt max-size=10m'
test "$(cat "$OVSR_PROXY_ROLLBACK_DIR/legacy-image.txt")" = \
  'basecamp/kamal-proxy:v0.9.2'
ruby -rjson -e '
  actual = JSON.parse(File.read(ARGV.fetch(0)))
  expected = {
    "80/tcp" => [{ "HostIp" => "", "HostPort" => "8080" }],
    "443/tcp" => [{ "HostIp" => "", "HostPort" => "8443" }]
  }
  abort "legacy bindings changed: #{actual.inspect}" unless actual == expected
' "$OVSR_PROXY_ROLLBACK_DIR/legacy-bindings.json"
test -s "$OVSR_PROXY_ROLLBACK_DIR/legacy-command.txt"
test -s "$OVSR_PROXY_ROLLBACK_DIR/legacy-routes.txt"

(
  cd "$OVSR_PROXY_ROLLBACK_DIR"
  sha256sum \
    rollback.yml \
    legacy-proxy-details.txt \
    legacy-options.txt \
    legacy-image.txt \
    legacy-command.txt \
    legacy-bindings.json \
    legacy-routes.txt \
    > SHA256SUMS
  sha256sum -c SHA256SUMS
)

OVSR_PROXY_ROLLBACK_ARCHIVE="$OVSR_PROXY_ROLLBACK_DIR.tar.gz"
tar -C "$(dirname "$OVSR_PROXY_ROLLBACK_DIR")" -czf \
  "$OVSR_PROXY_ROLLBACK_ARCHIVE" \
  "$(basename "$OVSR_PROXY_ROLLBACK_DIR")"
(
  cd "$(dirname "$OVSR_PROXY_ROLLBACK_ARCHIVE")"
  sha256sum "$(basename "$OVSR_PROXY_ROLLBACK_ARCHIVE")" \
    > "$(basename "$OVSR_PROXY_ROLLBACK_ARCHIVE").sha256"
)
chmod 600 \
  "$OVSR_PROXY_ROLLBACK_ARCHIVE" \
  "$OVSR_PROXY_ROLLBACK_ARCHIVE.sha256"
```

Set the following only in the operator's shell; do not write these
machine-specific destinations into the repository:

```sh
: "${OVSR_ROLLBACK_OFFHOST_HOST:?set approved backup SSH host}"
: "${OVSR_ROLLBACK_OFFHOST_DIR:?set approved remote directory}"
ssh "$OVSR_ROLLBACK_OFFHOST_HOST" \
  "install -d -m 700 '$OVSR_ROLLBACK_OFFHOST_DIR'"
scp \
  "$OVSR_PROXY_ROLLBACK_ARCHIVE" \
  "$OVSR_PROXY_ROLLBACK_ARCHIVE.sha256" \
  "$OVSR_ROLLBACK_OFFHOST_HOST:$OVSR_ROLLBACK_OFFHOST_DIR/"
ssh "$OVSR_ROLLBACK_OFFHOST_HOST" \
  "cd '$OVSR_ROLLBACK_OFFHOST_DIR' && \
   chmod 600 \
     '$(basename "$OVSR_PROXY_ROLLBACK_ARCHIVE")' \
     '$(basename "$OVSR_PROXY_ROLLBACK_ARCHIVE").sha256' && \
   sha256sum -c '$(basename "$OVSR_PROXY_ROLLBACK_ARCHIVE").sha256'"
```

Do not proceed unless the local manifest and the off-host archive checksum both
verify. Retain the local bundle and off-host copy through the rollback window.

### Cut over to loopback

1. From `apps/server`, run
   `kamal config -c config/deploy.yml > /dev/null` with Kamal 2.12 or newer.
   Separately inspect the YAML and abort unless `proxy.run` contains only
   `bind_ips: [127.0.0.1]`, `publish: true`, ports 8080/8443, and version
   v0.9.2. Do not print or persist the resolved config because it includes
   secrets.
2. Inspect every host nginx upstream with `nginx -T`. Abort if any application
   reaches Kamal through a non-loopback host address; changing a shared listener
   before migrating that upstream would cause an outage.
3. Only after that preflight, run the separately approved
   `kamal proxy reboot -c config/deploy.yml`. Confirm the image
   remains `basecamp/kamal-proxy:v0.9.2` and Docker publishes exactly
   `127.0.0.1:8080` and `127.0.0.1:8443`.
4. Verify the allowed/rejected loopback Host probes above and every route saved
   in `legacy-routes.txt`.
5. From a host outside nid-01, require both commands to fail to connect:

   ```sh
   curl --fail --connect-timeout 5 \
     --header 'Host: overseer.rnm.dev' \
     http://94.247.128.103:8080/healthz
   curl --fail --insecure --connect-timeout 5 \
     --header 'Host: overseer.rnm.dev' \
     https://94.247.128.103:8443/healthz
   ```

Any HTTP response is failure: direct Kamal ingress still exists. The 8443 probe
timed out before cutover too, so its timeout is necessary but not sufficient;
the exact loopback Docker binding is also required.

### Shared-proxy rollback

Rollback deliberately restores the captured wildcard listener state. It
therefore **reopens the independently verified direct 8080 boundary** (and
restores the wildcard 8443 binding, whose external reachability was not
demonstrated). This is approved outage recovery only—not a routine rollback,
security fix, or substitute for repairing the loopback route. Obtain separate
authorization immediately before the proxy reboot.

Use the exact retained bundle; do not regenerate it after cutover and do not
use the checked-in loopback config:

```sh
OVSR_PROXY_ROLLBACK_DIR=/absolute/path/to/the/retained/ovsr-248-proxy-TIMESTAMP
OVSR_PROXY_ROLLBACK_YML="$OVSR_PROXY_ROLLBACK_DIR/rollback.yml"
(
  cd "$OVSR_PROXY_ROLLBACK_DIR"
  sha256sum -c SHA256SUMS
)
kamal config -c "$OVSR_PROXY_ROLLBACK_YML" > /dev/null
```

Validate the YAML again: image v0.9.2, ports 8080/8443, `publish: true`, and no
`bind_ips`. Do not print or persist the resolved config. Only after the approved
outage-recovery decision:

```sh
kamal proxy reboot -c "$OVSR_PROXY_ROLLBACK_YML"
```

Verify the restored options, image, command, wildcard bindings, and route table
against the captured artifact:

```sh
OVSR_PROXY_VERIFY_DIR="$(mktemp -d)"
ssh root@94.247.128.103 'cat /root/.kamal/proxy/options' \
  > "$OVSR_PROXY_VERIFY_DIR/options.txt"
ssh root@94.247.128.103 \
  'docker inspect kamal-proxy --format "{{.Config.Image}}"' \
  > "$OVSR_PROXY_VERIFY_DIR/image.txt"
ssh root@94.247.128.103 \
  'docker inspect kamal-proxy --format "{{json .Path}} {{json .Args}}"' \
  > "$OVSR_PROXY_VERIFY_DIR/command.txt"
ssh root@94.247.128.103 \
  'docker inspect kamal-proxy --format "{{json .HostConfig.PortBindings}}"' \
  > "$OVSR_PROXY_VERIFY_DIR/bindings.json"
ssh root@94.247.128.103 \
  'docker exec kamal-proxy kamal-proxy list' \
  > "$OVSR_PROXY_VERIFY_DIR/routes.txt"

cmp "$OVSR_PROXY_ROLLBACK_DIR/legacy-options.txt" \
  "$OVSR_PROXY_VERIFY_DIR/options.txt"
cmp "$OVSR_PROXY_ROLLBACK_DIR/legacy-image.txt" \
  "$OVSR_PROXY_VERIFY_DIR/image.txt"
cmp "$OVSR_PROXY_ROLLBACK_DIR/legacy-command.txt" \
  "$OVSR_PROXY_VERIFY_DIR/command.txt"
cmp "$OVSR_PROXY_ROLLBACK_DIR/legacy-bindings.json" \
  "$OVSR_PROXY_VERIFY_DIR/bindings.json"
cmp "$OVSR_PROXY_ROLLBACK_DIR/legacy-routes.txt" \
  "$OVSR_PROXY_VERIFY_DIR/routes.txt"
ssh root@94.247.128.103 \
  "curl --fail --header 'Host: overseer.rnm.dev' \
    http://127.0.0.1:8080/healthz"
```

Every `cmp` and the loopback health probe must pass. A rollback does not touch
application or database volumes. Record the approved recovery, then schedule
restoration of the loopback target; do not leave the reopened 8080 boundary as
an undocumented steady state.

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
2. Compare the checked-in `set_real_ip_from` entries with Cloudflare's current
   `https://www.cloudflare.com/ips-v4/` and `/ips-v6/` lists. A missing range
   collapses those visitors to a Cloudflare address; an obsolete over-broad
   range can make a spoofed `CF-Connecting-IP` trusted.
3. Copy `config/nginx/overseer.rnm.dev.conf` to
   `/etc/nginx/sites-available/overseer.rnm.dev` and enable it.
4. Run `nginx -t` before `systemctl reload nginx`. Confirm the vhost uses
   `real_ip_header CF-Connecting-IP`, explicit Cloudflare `set_real_ip_from`
   ranges and `proxy_set_header X-Forwarded-For $remote_addr` — never
   `$proxy_add_x_forwarded_for`.
5. Confirm `kamal config` renders
   `OVERSEER_TRUSTED_PROXIES=loopback,linklocal,uniquelocal` and keeps
   `proxy.forward_headers: true`.
6. Verify `/healthz`, SPA assets, GitHub OAuth, WebSocket `/api/ws`, Peon
   heartbeat/recruitment, a tokenized preview host, and release download.
7. Keep the source stack and its volumes untouched through the rollback window.

## Rollback

For an application-only regression:

```sh
kamal rollback <previous-version>
```

For a cutover failure, point Cloudflare back to the source host, reload the old
route, and leave the target volumes intact for diagnosis. Do not restore a newer
target dump over the old source database without a separate reconciliation plan.
