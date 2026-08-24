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
| `overseer-releases` | `/data/releases` | Legacy release data retained for rollback/audit; current Peon updates use public npm |

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

For historical cutovers that still carry legacy release data, archive the
release volume even though current schema has no `releases` table:

```sh
docker run --rm --read-only \
  -v overseer_releases:/source:ro \
  -v "$PWD/backups:/backup" \
  alpine:3.22 tar -C /source -czf /backup/overseer-releases.tgz .
sha256sum backups/overseer-releases.tgz
```

Copy both artifacts to independent storage before continuing. This legacy
archive is not an input to current Peon releases, which come from public npm.

## Approved data migration

This section is intentionally not executed during preparation.

1. Put the source Overseer into a maintenance window so no writes can race the
   final dump.
2. Produce and checksum a new final database dump and, when legacy release data
   is present, its archive.
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

5. If the source carried legacy release bytes, restore them into
   `overseer-releases`, preserving ownership for the application `node` user:

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
   heartbeat/recruitment, a tokenized preview host, and an owner-authorized Peon
   update check.
7. Keep the source stack and its volumes untouched through the rollback window.

## Rollback

For an application-only regression:

```sh
kamal rollback <previous-version>
```

For a cutover failure, point Cloudflare back to the source host, reload the old
route, and leave the target volumes intact for diagnosis. Do not restore a newer
target dump over the old source database without a separate reconciliation plan.

## Current production deployment

The facts an operator needs before touching production; the procedures above
remain the authority for *how* to change them.

- **Host** — `root@94.247.128.103` (nid-01 / `nid-prod-coloc.mesh.rnm` /
  Tailscale `100.64.0.5`).
- **Tailnet** — `hs.rnm.dev`, MagicDNS suffix `mesh.rnm`. The production app
  container resolves and reaches Peons at `peon-*.mesh.rnm:4570`.
- **Deploy** — Kamal 2, config `apps/server/config/deploy.yml`, service
  `overseer`, registry image `rnmdev/overseer`. The Docker build context is the
  repository root (`builder.context: ../..`) because the npm workspaces keep a
  single lockfile there.
- **App container** — pattern `overseer-web-<version>`, port 5000 on the kamal
  network, health check `/healthz`.
- **Public origin** — https://overseer.rnm.dev. `OVERSEER_PUBLIC_URL` and
  `OVERSEER_PEON_CALLBACK_URL` both name it; production uses its own GitHub
  OAuth app.
- **Cloudflare** — proxied A `overseer.rnm.dev` → 94.247.128.103; proxied A
  `overseer-dev.rnm.dev` → 94.247.128.101.
- **Host nginx** — `/etc/nginx/sites-available/overseer.rnm.dev`, enabled in
  `sites-enabled`.
- **Proxy path** — Cloudflare → host nginx :80 → shared kamal-proxy
  127.0.0.1:8080 → Overseer :5000. See the OVSR-248 note in [Safety
  invariants](#safety-invariants): the checked-in Kamal 2.12+ run config targets
  both listeners at 127.0.0.1, but that needs a separately approved shared-proxy
  reboot and has **not** been applied.
- **Database** — accessory container `overseer-postgres`, PostgreSQL 16,
  internal DNS `overseer-postgres:5432/overseer`. Schema migrations self-apply
  on app boot under an advisory lock.

Deployed images:

The registry moved from `vibze/overseer` to `rnmdev/overseer`; rows below keep
the repository each image was actually pushed to.

| Image | Deployed | What it carried |
| --- | --- | --- |
| `rnmdev/overseer:ed1430e0138f9a592cbad38b7b3dc3b8bfe95f91` | 2026-08-24 (current) | The isolated App Review demo, enabled in production by `OVERSEER_APP_REVIEW_DEMO=1` in `deploy.yml`. The server starts the read-only screenshot demo Peon in-process on container port 5001 and presents the seeded `demo-screenshot-workspace` Peons as connected; ordinary Peons still derive presence from the reverse socket, and demo mutations are always refused. The gate needs all three of `NODE_ENV=production`, `OVERSEER_PUBLIC_URL=https://overseer.rnm.dev` and the explicit flag. Built from a clean detached worktree of the pushed commit because the shared checkout held unrelated unpushed work. |
| `rnmdev/overseer:5b81531409d5bd7e24641feab7438f53caabcbc5` | 2026-08-21 | Server 0.2.0. First row recorded on the `rnmdev` registry. |
| `vibze/overseer:027a13932e5133cc9a1c4a076105830291a3addb` | 2026-08-12 | The project Files page as a working file surface: one reusable drag-and-drop layer behind both file trees, folder upload and folder move, upload placeholders with progress, context menus, deletion, a movable split, line numbers, image zoom and in-place text editing. Built from merged `master`; an earlier same-day build of the unmerged branch commit `3039245` carried the same application code. The Peon half of folder transfers ships separately through the npm update channel, so a Peon below 0.12.9 answers PARENT_NOT_FOUND for a nested upload and INVALID_PATH for a folder move — the client names both as "this Peon needs an update". |
| `vibze/overseer:ef4e768620cdaf76ff58fda1cc433c610f7483e2` | 2026-08-12 | Public-release web/server batch: transcript scroll-follow fixes, managed-plugin inquiry convergence and Peon 0.12.8 release preparation. |
| `vibze/overseer:f9b82819c6a88ffec666e1659ab746aac4fd1962` | 2026-08-10 | An upgrade to a path no handler claims is refused with 400 and the socket destroyed, stopping the file-descriptor leak an outdated Peon caused by dialling the retired `/api/v1/peons/transfer/ws`. Built from a detached worktree of the pushed commit because the shared checkout held unrelated work in progress. |

### Everyday deploy

Deploy from `/rnm/overseer/apps/server` after validation, using the gitignored
`.kamal/secrets` file there:

```sh
kamal config
kamal deploy
```

Then verify app health, proxy routes, the DB migration count and the persistent
volume mounts. Never put secrets into metadata or commits, and keep
`DATABASE_URL` pointed at `overseer-postgres`.

Rollback has three independent levers: `kamal rollback <version>` for the
application; the Cloudflare A record back to 94.247.128.101 for traffic; and a
`pg_restore` of a verified custom-format dump for data — stop the target app
first, never overwrite the source, and never delete either host's volumes. The
shared-proxy loopback rollback is separate and is described in [its own
section](#shared-proxy-rollback).

## The App Review demo instance

`https://demo.ovrseer.org` is a second, separate Overseer on the same host. It
is **not** Kamal and **not** compose — a plain `docker run`, so `kamal deploy`
does not touch it and it does not appear in the shared proxy's route table.

| | |
| --- | --- |
| Container | `overseer-demo-app`, Docker network `overseer-demo` |
| Port | `127.0.0.1:5010` → container `5000` |
| Database | `overseer-demo-postgres`, its own cluster, separate from production |
| Environment | `/root/overseer-demo.env` on nid-01, mode 0600 — it holds `DATABASE_URL`, so never print it into a task or a commit |

The doors are `github:false, password:true, oidc:false`, and that is achieved by
those variables simply being **absent**: only `OVERSEER_PUBLIC_URL`,
`OVERSEER_PASSWORD_AUTH=1`, `OVERSEER_APP_REVIEW_DEMO=1`,
`OVERSEER_TRUSTED_PROXIES`, `OVERSEER_HOST`, `OVERSEER_PORT`, `NODE_ENV` and
`DATABASE_URL` are set. Adding a GitHub or OIDC credential here would open a door
App Review is not expecting.

To deploy a commit to it, build and push the image, then replace the container —
renaming the old one rather than removing it, so rollback is one command:

```sh
docker pull rnmdev/overseer:<sha>
docker stop overseer-demo-app
docker rename overseer-demo-app overseer-demo-app-prev
docker run -d --name overseer-demo-app \
  --network overseer-demo --restart unless-stopped \
  --env-file /root/overseer-demo.env \
  -p 127.0.0.1:5010:5000 rnmdev/overseer:<sha>
```

Then confirm `/api/auth/methods` still answers `github:false, password:true,
oidc:false`, and that a request carrying the deep link the shipped app opens —
`overseer://oauth/github` — is refused with `401 INVALID_CREDENTIALS` rather than
`400 INVALID_CALLBACK`. The second check is the one that proves the native
password door is reachable by the production build; see
[email and password sign-in](password-auth.md#inside-the-apps-webview).

Roll back with `docker stop overseer-demo-app && docker rm overseer-demo-app &&
docker rename overseer-demo-app-prev overseer-demo-app && docker start
overseer-demo-app`.

## Cutover state (2026-07-20)

Production holds Kanat, Marat, Neo, Thor and the historical Smoke record with
their sessions, events and follow-up history. Nova and Nova's credential and
history are deliberately excluded from production and live only on dev.

The final pre-cutover database dump lives on nid-01 in the
`overseer-postgres-backups` volume, twice — `/backups/overseer-final-20260720T1301Z.dump`
and `/backups/overseer-final.dump`, both SHA-256
`de40548406eb652706a36dad7e127f749a0f11d1204c4e74708ecdbdb9181231`. The earlier
aborted attempt sits beside them as `/backups/overseer-final-20260720T1255Z.dump`.
List them with:

```sh
docker run --rm -v overseer-postgres-backups:/b alpine:3 ls -la /b
```

The dev box's copies were deleted on 2026-07-29 after verifying the remote ones
byte for byte, so that volume is the only place they exist — which is why the
safety invariants above forbid removing it.

Kanat is verified registered and heartbeating to production. During the first
aborted split an active Peon received 401 from the Nova-only dev database and
entered the daemon's durable-in-memory derecruited state; Kanat was re-pointed
without a daemon restart and recovered. Marat may still need re-enrollment or a
daemon restart if it observed that transient 401. Offline Neo and Thor will use
the canonical production URL when they return. Nova, if started, must have its
local `overseerUrl` pointed at https://overseer-dev.rnm.dev first, keeping its
existing dev credential — otherwise it calls production, where its credential is
intentionally absent, gets 401 and de-recruits.

## Turned off: preview hostnames

Tokenized web previews are **off**, on 2026-08-20, by removing
`OVERSEER_PREVIEW_DOMAIN` from production and from the dev instance. They never
worked: `*.preview.overseer.rnm.dev` points at 94.247.128.103 and the nginx and
app routing are prepared, but HTTPS fails during the Cloudflare TLS handshake
because the nested wildcard is not covered by the available edge certificate.
Dev never had working wildcard DNS at all.

Nothing was removed. Setting the variable again turns the feature back on, and
it is worth doing only once the nested host has a certificate or the hostname
design is flattened to a single label. Until then the route answers
`503 PREVIEWS_DISABLED`, the middleware claims no hosts, and an HTML artifact
opens as its own source instead of a rendered page.
