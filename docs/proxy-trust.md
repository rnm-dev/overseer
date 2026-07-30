# Trusted client IPs

Overseer uses a client IP for public authentication limits, Peon claim-start
limits, operator-code lookup limits, and device security attribution. That
identity is security-sensitive: a request header is not an IP observation until
every proxy between the TCP peer and the client has been validated.

## Current and target chains

The intended production path is:

```text
client
  -> Cloudflare
  -> host nginx :80
  -> kamal-proxy 127.0.0.1:8080
  -> Overseer :5000
```

During OVSR-248 review, the production Kamal listeners were wildcard host-bound
on both 8080 and 8443 (`0.0.0.0/[::]`). An independent external request to
8080 returned HTTP 200; the 8443 probe timed out with no HTTP response
(possibly filtered), so only 8080 was demonstrated Internet-reachable. Until
the checked-in Kamal run configuration is applied in an approved proxy-reboot
window, this second path is verified:

```text
direct Internet client
  -> public kamal-proxy :8080
  -> Overseer :5000
```

The wildcard 8443 binding remains an unacceptable target even though its
external path may currently be filtered. Any reachable direct-Kamal listener
bypasses nginx. The source fix therefore defends that chain independently:
pinned kamal-proxy v0.9.2 preserves inbound XFF and appends its actual TCP peer
on the right. With the application socket peer trusted, the appended public
peer is the first untrusted address in the right-to-left walk;
attacker-controlled or malformed entries farther left are ignored. If the
rightmost token itself is malformed, `clientInfo()` rejects it as an IP and
collapses attribution to the trusted Kamal socket peer instead of accepting an
attacker-selected string.

The fail-safe target is source-controlled in `apps/server/config/deploy.yml`:

```yaml
minimum_version: 2.12.0
proxy:
  run:
    repository: basecamp/kamal-proxy
    version: v0.9.2
    http_port: 8080
    https_port: 8443
    publish: true
    bind_ips:
      - 127.0.0.1
```

After an explicit approved `kamal proxy reboot`, only host-local nginx can
reach those ports and the direct Internet path must be unreachable. An ordinary
application deploy is not permission to reboot or rebind the shared proxy.

Development:

```text
client
  -> Cloudflare
  -> host nginx :80
  -> Docker-published 127.0.0.1:4580
  -> Overseer :5000
```

The application configuration for both paths is:

```text
OVERSEER_TRUSTED_PROXIES=loopback,linklocal,uniquelocal
```

These are named ranges validated by Express/proxy-addr. Invalid names, IPs, or
CIDRs fail `createServer()` and therefore fail startup. An empty list is safe:
all forwarding headers are ignored and the socket peer is used. Production
prints a warning when the list is empty.

The local ranges are trusted only because the application ports stay
loopback-only or inside the private Docker/Kamal network. Do not publish the app
container directly, attach untrusted workloads to that network, or copy this
setting to a topology where private-network peers are not controlled. The
current wildcard Kamal host bindings—and the independently verified direct
8080 boundary—are a known deployment mismatch, not a reason to treat arbitrary
public addresses as trusted proxies.

## Header contract

nginx and the application have separate responsibilities:

1. nginx lists every current Cloudflare IPv4 and IPv6 CIDR with
   `set_real_ip_from` and uses `real_ip_header CF-Connecting-IP`.
2. Only a TCP peer inside those ranges can change nginx's `$remote_addr` from
   `CF-Connecting-IP`. A direct caller's copy of that header is ignored.
3. nginx overwrites, rather than appends, `X-Forwarded-For` with
   `$remote_addr`. Caller-supplied XFF never crosses the host boundary.
4. On the nginx path, kamal-proxy forwards that canonical XFF to Overseer. In
   development nginx sends it directly through the Docker port.
5. Overseer walks XFF from the socket peer toward the client and stops at the
   first address outside `OVERSEER_TRUSTED_PROXIES`. That first untrusted
   address is the client.
6. Overseer never reads `CF-Connecting-IP` directly. A malformed XFF result
   also cannot become an arbitrary rate-limit key; `clientInfo()` falls back to
   the socket peer unless the derived value is an IP literal.
7. On the temporary direct-Kamal path, v0.9.2 appends the actual external TCP
   peer at the right of preserved XFF. The app stops there, so attacker entries
   to its left cannot select attribution.

Consequences:

| Request path | Effective client IP |
| --- | --- |
| Cloudflare -> nginx -> application | validated `CF-Connecting-IP`, carried as canonical XFF |
| direct caller -> nginx | caller's nginx socket address; spoofed CF/XFF discarded |
| direct caller -> reachable wildcard-bound Kamal v0.9.2 -> application (verified on 8080; 8443 not demonstrated externally) | Kamal-appended actual TCP peer at rightmost XFF; attacker entries farther left ignored |
| direct caller -> application from an untrusted peer | application socket peer; CF/XFF ignored |
| trusted proxy chain with several XFF entries | first untrusted address when walking right-to-left |
| empty trust configuration | application socket peer |
| trusted socket peer with malformed rightmost XFF | trusted application socket peer; arbitrary malformed token rejected |

## Deployment validation

Cloudflare can change its published networks. Before installing or reloading
either nginx config, compare every `set_real_ip_from` entry with:

```sh
curl --fail --silent --show-error https://www.cloudflare.com/ips-v4/
curl --fail --silent --show-error https://www.cloudflare.com/ips-v6/
rg '^set_real_ip_from ' apps/server/config/nginx/*.conf
```

Update both checked-in nginx files when the lists differ. Then validate the
source and deployment configuration:

```sh
node --import tsx --test --test-concurrency=1 \
  apps/server/src/proxyTrust.test.ts
kamal config
nginx -t
```

`nginx -t` runs on the host after the checked-in vhost is installed but before
reload. Keep `proxy.forward_headers: true` in Kamal: nginx has already
canonicalized XFF, and disabling forwarding would collapse production limits
to the proxy address.

Before the first approved proxy reboot with the checked-in loopback binding,
create and retain the executable rollback bundle described in
[Approved shared proxy loopback cutover](deploy-runbook.md#approved-shared-proxy-loopback-cutover).
It contains a validated `rollback.yml` plus checksummed legacy options, image,
command, bindings, and routes; it must be copied off-host before cutover.
Then:

1. Run `kamal config` with Kamal 2.12 or newer and confirm the rendered proxy
   run state pins v0.9.2, publishes 8080/8443, and lists only `127.0.0.1` under
   `bind_ips`.
2. Treat the proxy as shared infrastructure. Save `kamal proxy details` and
   `docker exec kamal-proxy kamal-proxy list`; inspect `nginx -T` and abort if
   any local application expects to reach 8080/8443 through a non-loopback host
   address.
3. Reboot the proxy only in an approved maintenance window. This task does not
   authorize or perform that reboot.
4. On nid-01, require Docker port bindings to be exactly
   `127.0.0.1:8080` and `127.0.0.1:8443`, then verify nginx still reaches
   `http://127.0.0.1:8080/healthz`.
5. From a genuinely external host, both direct requests below must fail to
   connect; an HTTP response of any status is a failed invariant:

   ```sh
   curl --fail --connect-timeout 5 \
     --header 'Host: overseer.rnm.dev' \
     http://94.247.128.103:8080/healthz
   curl --fail --insecure --connect-timeout 5 \
     --header 'Host: overseer.rnm.dev' \
     https://94.247.128.103:8443/healthz
   ```

The 8443 probe already timed out during review, but that alone does not prove
the target: Docker must also show the exact loopback binding after reboot.
Until both loopback bindings and both external negative probes are verified,
OVSR-248 must not be treated as deployed. The current production image also
predates the application fix, so public claim enrollment and reverse-only
cutover remain blocked.

The regression test proves that rotating both `X-Forwarded-For` and
`CF-Connecting-IP` on direct requests does not rotate the auth, claim-start, or
operator-code rate keys. It separately models the exact v0.9.2 direct-Kamal
chain, malformed intermediate/left entries, malformed rightmost entries, a
valid multi-proxy chain, invalid trusted-proxy configuration, and the
loopback-only Kamal run configuration.
