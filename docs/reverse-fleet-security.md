# Reverse fleet control security

This is the durable OVSR-150 threat model and security-test plan for the
Overseer ↔ Peon reverse control and transfer boundary. It describes the shared
tree as reviewed on 2026-07-30. It is a cutover gate, not an approval of work
that is still in progress.

Normative protocol details remain in
[the reverse command gateway](reverse-command-gateway.md),
[file viewing](file-viewing.md), and the canonical reverse-command contract at
`apps/peon/docs/reverse-command-protocol-v1.md`.

## Security decision and current gate

The stable transport, ACL, file-containment, and information-flow layers have
an executable regression gate:

```sh
node scripts/security/run-reverse-fleet-security.mjs
```

This command is read-only apart from temporary test files and in-memory
databases. It does not contact production, deploy, or restart a service.

Reverse-only/public-boundary cutover is **not approved** by this document.
OVSR-129 and OVSR-130 remain In Progress. OVSR-248 and OVSR-249 are in Code
Review; review state is not deployment or
operational evidence. The exact executable and blocked cells are listed under
[Blocked suites](#blocked-suites).

The `pn_` Peon credential is deliberately recoverable in
`peon_credentials.token` and `peons.token`, because Overseer uses it for Fleet
HTTP and Peon-initiated registration/socket authentication. Database access is
therefore sufficient to impersonate a Peon and must be protected accordingly.

## Security objectives

The boundary must preserve these properties:

1. An operator can affect or observe only a workspace, Peon, project, and
   session authorized by server-side membership and ACL state.
2. Browser input never selects the command actor, Peon socket identity,
   workspace binding or durable delivery cursor.
3. At-least-once delivery cannot become more-than-once effect. Same ID/same
   canonical request joins one lifecycle; same ID/different request fails.
4. A stale socket, callback, async completion, ACK, or transfer frame cannot
   mutate the current generation.
5. Control traffic remains bounded and responsive under catalog, transcript,
   command, and file pressure.
6. Peon is authoritative for command admission/effect and filesystem
   containment; Overseer is authoritative for operator ACL and its safe,
   rebuildable projection.
7. Credentials, pairing phrases, prompts, transcript bodies, private
   keys, sensitive paths, and configuration secrets do not enter routine logs,
   metrics, browser events, URLs, or safe error bodies.
8. Active content from a Peon never executes in the authenticated Overseer
   origin.
9. Revocation closes both control and transfer authority before success is
   reported.
10. Mixed-version routing selects exactly one authority for an action; reverse
    and legacy paths never both execute it.

Availability against volumetric denial of service is bounded, not guaranteed.
A compromised operator account may perform every action its current ACL
allows. A fully compromised Peon can lie about its own state and bytes, but it
must not cross into another Peon/workspace or escape browser isolation.

## Assets

| Asset | Required protection |
| --- | --- |
| Operator web/device credentials | Secret; accepted only by operator auth; never forwarded to Peon |
| `pn_…` Peon credential | Secret and workspace/Peon bound; recoverable because it authenticates both Fleet HTTP and outbound registration/socket traffic |
| Pairing phrase | Short-lived, single-use bootstrap secret; generated and displayed only through the local CLI |
| Workspace/Peon/project/session ACL | Integrity and non-enumerability |
| Command ID, request hash, actor and lifecycle | Integrity, replay safety, generation binding, durable recovery |
| Durable epoch/cursor/message ID | Ordered integrity; ACK only after atomic commit |
| Session/project projections and audit | Integrity, safe allowlist, actor/workspace scope |
| Project, sandbox, attachment and artifact bytes | Confidentiality to ACL; containment; bounded ranges/credit |
| Peon host paths/configuration | Not browser-visible unless explicitly part of an authorized product surface |
| Armory profile values and project assignments | Values are write-only and package/profile/process scoped; assignment integrity is bound to immutable project ID |
| Control-plane availability | Bounded queues, frames, timeouts and priority lanes |

## Data flow and trust boundaries

```text
  untrusted browser/native request
               |
               | HTTPS + operator device/web session
               v
  +---------------------------+
  | TB1 Overseer public edge  |  host/origin/CSRF/body/rate boundary
  +-------------+-------------+
                |
                | canonical user + workspace membership + ACL
                v
  +---------------------------+
  | TB2 operator services     |  derive actor, choose one route
  +------+--------------------+
         |                         PostgreSQL
         | persist request         +----------------------+
         +------------------------>| TB3 durable registry |
         |                         | inbox/audit/proj.     |
         |                         +----------------------+
         |
         | command/control WSS, authenticated Peon credential
         v
  +---------------------------+       +---------------------------+
  | TB4 control socket        |       | TB5 Fleet HTTP byte plane |
  | generation + capability   |       | generation + capability   |
  +-------------+-------------+       +-------------+-------------+
                ^                                   ^
                | outbound WSS                      | outbound WSS
                |                                   |
  +-------------+-----------------------------------+-------------+
  | TB6 Peon daemon                                             |
  | durable admission/outbox, local services, filesystem checks |
  +---------------------------+----------------------------------+
                              |
                              | resolve + open + inode revalidation
                              v
  +--------------------------------------------------------------+
  | TB7 project root / fileTransferRoot / session artifacts      |
  +--------------------------------------------------------------+

  Before TB4/TB5 exist:

  local operator -> peon enroll -> one-time phrase
                                      |
  operator -> Overseer -> Peon /enroll -> pn_ credential
```

### Boundary rules

| Boundary | Trusted input after crossing | Rejected/ignored input |
| --- | --- | --- |
| TB1 public edge | Authenticated user/device, trusted cookie origin, bounded parsed body | Unauthenticated operator request, untrusted cookie mutation origin, wrong production host |
| TB2 operator service | Canonical user loaded by ID; current membership and ACL | Request actor/email, workspace/Peon mismatch, inaccessible project/session |
| TB3 database | Transactionally correlated IDs and safe allowlists | Raw browser/Peon payloads outside their dedicated bounded columns |
| TB4 control WSS | Credential-bound Peon record, ready socket generation, exact capabilities | Wrong/missing identity where required, binary, malformed/oversized/unexpected frames, stale generation |
| TB5 transfer WSS | Same credential binding plus file capability and request correlation | Unknown transfer ID, bad sequence, excess credit/bytes, late non-tombstoned frame, oversized frame |
| TB6 Peon command | Authenticated socket authority, server-derived actor envelope, durable admission | Wrong target Peon, unknown fields, ID reuse with changed hash, unnegotiated capability |
| TB7 filesystem | Immutable project ID/root, contained resolved path, opened regular-file inode | Traversal, absolute project path, external symlink, symlink swap, directory/device, invalid range |

The two sockets are separate availability domains. Transfer loss must not mark
control presence offline, and transfer pressure must not block command
acceptance, heartbeat, status reconciliation, or durable ACKs.

## Threat actors and assumptions

- An unauthenticated Internet client can reach public HTTPS and WSS paths and
  can choose headers, timing, framing, compression offers, and disconnect
  points.
- An authenticated member may know workspace, Peon, project, session, command,
  or transfer IDs they no longer have access to.
- A malicious site can cause ambient-cookie requests, but browser JavaScript
  cannot set Peon's bearer `Authorization` header on a WebSocket upgrade.
- A stolen Peon bearer permits impersonation within that credential's current
  scope until revocation. It does not authorize another workspace or Peon.
- A stale/replaced Peon socket may continue producing frames and async results.
- A compromised Peon may send arbitrary protocol-valid metadata and bytes.
- TLS termination/proxy configuration is part of the security boundary.
  Forwarded-client identity follows the explicit, fail-closed chain in
  [trusted client IPs](proxy-trust.md).

## Prioritized abuse cases

### P0: authorization, identity, replay, and secret loss

| Abuse | Required prevention/detection | Current test |
| --- | --- | --- |
| Use workspace A route with workspace B Peon | Opaque `UNKNOWN_PEON`; no row/send | `reverseFleetSecurity.test.ts` |
| Use an accessible Peon with an inaccessible session/project | Opaque target refusal; no row/send | security gate + `access.test.ts` |
| Supply actor/user/email in request | Reject actor field; reload canonical user/email | security gate + `reverseCommandGateway.test.ts` |
| Reuse command ID with changed target/actor/payload | `COMMAND_ID_REUSED`; original hash/effect retained | security gate + both command suites |
| Replay same durable result/ACK | One inbox/audit/event/projection effect; ACK replay harmless | `reverseCommandGateway.test.ts` and outbox tests |
| Send result/acceptance from another Peon/generation | Fence and close/reject without resolving command | gateway/socket generation tests |
| Steal/replay revoked credential | Upgrade/request rejected; both sockets evicted | transfer/socket credential tests |
| Expose credential in view/error/preview | Sentinel absent from browser/API/close reason | security gate, settings and preview tests |
| Read an Armory profile value or reuse it across package/project scope | Safe views expose only configured booleans; profile/package/project checks and turn snapshots fence runtime reuse | `armory-project-packages-v1` contract tests; rollout suites tracked by OVSR-357/358/359/361 |
| Recreate global activation through compatibility paths | Capability-gated assignments only; legacy enable/disable is side-effect-free `410 ARMORY_ACTIVATION_RETIRED` | `armoryProjectPackagesProtocolContract.test.ts` and mixed-version rollout suite |

### P1: frame, durable stream, and resource abuse

| Abuse | Required prevention/detection | Current test |
| --- | --- | --- |
| Malformed JSON/binary control frame | Close 1007/1003 before dispatch | security gate |
| Control frame/decompression bomb | Complete decoded frame capped at 1 MiB; command at 60 KiB | security gate + command schema tests |
| Transfer frame bomb | Complete frame capped at 64 KiB; chunk payload at 65,514 bytes | security gate + file channel tests |
| Queue flood | Per-connection message/byte and process bounds; bounded pending commands | socket/gateway tests |
| ACK forgery/cursor gap/message collision | Epoch/cursor/message correlation; transaction rollback; no false ACK | current catalog/gateway tests; full fault suite blocked on OVSR-129/130 |
| Capability downgrade | Exact hello negotiation; no reverse+legacy double execution | protocol/gateway tests; rollout proof blocked |
| Slowloris/half-open socket | hello timeout, ping/pong termination, edge timeouts | socket/transfer tests; proxy soak blocked |
| Transfer ID guessing/post-completion frames | Socket/request ownership and bounded tombstones | file stream/channel tests |
| Excess credit/range/sequence/checksum | Credit cap, range validation, exact length/sequence | file stream/channel tests; write/checksum semantics not shipped |
| Log injection | Stable codes/correlation only; no raw frames/headers | static review; structured logging regression still required |

### P1: filesystem and active content

| Abuse | Required prevention/detection | Current test |
| --- | --- | --- |
| `..`, absolute project path, slash/backslash ambiguity | Reject before Peon open | sandbox/file tests |
| External symlink or directory-to-symlink swap | Realpath containment plus opened-inode revalidation | Peon file channel tests |
| Cross-project key reuse | Authorize immutable project ID | access/project viewer tests |
| MIME/content-type attack | `nosniff`, no-store, sandboxed content origin/CSP | transfer/viewer/preview tests |
| Preview hostname/path escape | Opaque subdomain grant, rooted path resolution, no SPA fallback | `webPreview.test.ts` |
| Attachment absolute path outside root | Generic `PATH_ESCAPE`, no upstream read/event/log disclosure | sandbox, transfer and security-gate sentinel tests |

## Executable suite

The runner intentionally selects tests by stable security property rather than
running every unfinished claim/command test in the tree.

Overseer coverage:

- `apps/server/src/reverseFleetSecurity.test.ts`
- claim contract and service proof/replay/race/rotation/revocation tests
- reverse-command contract/gateway, control socket and Fleet HTTP byte routes
- attachment sandbox, folder browse, project viewer, preview and ACL tests

Peon coverage:

- claim contract and implemented client persistence/proof/recovery tests
- reverse-command channel/ledger characterization
- socket and credential-generation replacement
- project/sandbox file channels and Fleet HTTP directory listing
- human-settings credential redaction

The command and enrollment files are executable characterization against the
current reviewed contract and implementations. A green run does **not** approve
unfinished tasks or operational rollout.

The profile/assignment security boundary is specified in [Armory project
packages](armory-project-packages.md). Until the implementation and rollout
suites tracked there ship, its contract tests prove schema, safe-fixture,
migration and canonical-contract invariants only; the Peon must not advertise
the capability.

Run one new cross-boundary file:

```sh
node --import tsx --test --test-concurrency=1 \
  apps/server/src/reverseFleetSecurity.test.ts
```

Run the complete stable security gate:

```sh
node scripts/security/run-reverse-fleet-security.mjs
```

The stable gate includes `proxyTrust.test.ts` for OVSR-248, the cross-boundary
sentinel regression for OVSR-249, and the claim contract/client/service
security cells. The former claim-generation failure was an outbound-only view
defect: presence publication required a legacy callback URL and closed the
generation-2 socket with `1011`. `PeonView.baseUrl` is now nullable, and the
delayed generation-1 control regression passes repeatedly. The former transfer
socket generation no longer exists.

The two gateway intermittents were test synchronization defects, not observed
duplicate command effects. Terminal status was followed by a fixed sleep
instead of an explicit persistence barrier, and event assertions counted every
process event rather than the tested command ID. The gateway is injectable at
the socket boundary for deterministic lifecycle tests; the regression waits
for the exact terminal observation and correlates event counts by workspace,
Peon and command.

## Blocked suites

These cells must be green, reviewed, or backed by the stated operational
evidence before OVSR-150 can move to Code Review.

| Blocked suite | Owner/dependency | Exit condition |
| --- | --- | --- |
| Full command crash matrix at admission/effect/result persistence/publish/ACK plus forged ACK/cursor/message collisions | OVSR-129/130 | Both tasks complete review and the executable fault matrix passes |
| Cross-workspace tests for every shipped reverse operation family | Operation tasks + OVSR-129/130 | Registry-derived operation matrix proves denial before command creation/send |
| Claim proof, nonce replay, changed-body ID reuse, cleanup/restart, approval/denial/expiry/cancel/ACK, rotation and revocation | OVSR-210/145/147 | **Executable:** contract, client and service suites are in the stable runner |
| Claim-versus-legacy race and downgrade outcomes | OVSR-145/147 | **Partially executable:** committed-method race passes; complete transport-outcome downgrade matrix remains reviewed |
| Transfer write checksum, atomic replace, post-completion write frames | OVSR-49/51/53 | Write protocol exists; no write operation exists today |
| Public-origin proxy/TLS/slowloris and no-inbound soak | OVSR-148/149/151/152 | Deploy the reviewed trusted-IP config and make staging topology available |
| Legacy credential plaintext removal | OVSR-211 | Mixed-version window ended and no callback credential remains |

An excluded or TODO cell is never included in the pass count. Task review,
source/config review and production operational evidence are separate gates.

## Findings and residual risks

### OVSR-248 — validated forwarded client IP (fixed in source)

`clientInfo()` now consumes Express's validated proxy chain and accepts only an
IP literal; otherwise it falls back to the socket peer. Both deployments set
`OVERSEER_TRUSTED_PROXIES=loopback,linklocal,uniquelocal`. nginx accepts
`CF-Connecting-IP` only from the checked-in Cloudflare CIDRs, overwrites XFF
with that validated address (or the direct socket peer), and the application
never reads the CF header itself.

During OVSR-248 review, the production Kamal listeners were wildcard host-bound
on both 8080 and 8443 (`0.0.0.0/[::]`). An independent external request to
8080 returned HTTP 200; the 8443 probe timed out with no HTTP response
(possibly filtered), so only 8080 was demonstrated Internet-reachable. On any
reachable direct-Kamal listener, the pinned proxy behavior preserves inbound
XFF and appends the actual TCP peer at the right; the application stops at that
first untrusted peer, so attacker-controlled or malformed entries farther left
cannot rotate authentication attribution. A malformed
rightmost token is rejected as a non-IP and collapses to the trusted
application socket peer.

`proxyTrust.test.ts` exercises authentication limits for an untrusted direct app
peer, the exact trusted-Kamal/appended-public-peer chain, malformed
left/intermediate and rightmost XFF, a multi-hop trusted chain, invalid proxy
configuration, and the checked-in nginx/Kamal/Compose invariant.

The source-controlled fail-safe target requires Kamal 2.12+, pins proxy v0.9.2
and binds host 8080/8443 only to `127.0.0.1`. That shared-proxy reboot has not
been performed. Production cutover still requires a checksummed, off-host
rollback bundle, the preflight, reboot, exact loopback binding checks, local
health checks, and both external connection-failure probes in
[trusted client IPs](proxy-trust.md).

The rollback bundle's validated `rollback.yml` removes `bind_ips` to reproduce
the captured legacy options. A separately authorized rollback therefore
restores both wildcard bindings and reopens the verified direct 8080 boundary;
it is outage recovery only, not an acceptable steady-state security posture.

### OVSR-249 — absolute file root in error (resolved 2026-07-30)

Both legacy HTTP attachment resolution and reverse-transfer `PATH_ESCAPE`
failures now publish one generic message. Overseer replaces Peon-supplied
`PATH_ESCAPE` detail at ingestion and again at the HTTP boundary. The active
security-gate regression uses independent sentinel root and rejected-path
values and asserts that neither reaches the response body, durable/live browser
events, routine logs, or an upstream file read.

### Recoverable Peon bearer

`pn_` credentials are plaintext in both the credential and Peon registry rows.
They authenticate direct Fleet HTTP as well as Peon registration and sockets,
so database access is enough to impersonate a Peon. This is an accepted current
boundary and requires strict database access control, credential redaction and
immediate revocation on suspected disclosure.

### WebSocket Origin is not the Peon authorization boundary (accepted)

Control/transfer upgrades do not enforce a browser Origin allowlist. They
authenticate a Peon bearer before upgrade, use no ambient cookie, and browsers
cannot set that header through the WebSocket API. Host/TLS/proxy policy still
belongs at TB1. If authentication ever accepts cookies, query tokens, or
browser-settable subprotocol credentials, an explicit Origin policy becomes
mandatory.

### Untrusted Peon error text (residual)

Several legacy proxy routes preserve useful Peon error messages. Any route that
publishes these to a browser must treat them as untrusted text, bound their
length, and keep them out of logs/headers. Reverse command terminal detail is
safer: it is operation-allowlisted before persistence and publication.

## Incident procedures

These are operator actions, not automated assumptions.

### Suspected `pn_` credential compromise

1. Stop using the affected Peon for new work and record workspace, Peon ID,
   observed time, socket presence and affected sessions without copying the
   token into the incident record.
2. As workspace owner, remove/revoke the Peon through the authenticated fleet
   surface. Current `DELETE /api/workspaces/:wsId/peons/:id` revokes the
   credential, evicts both sockets, and removes the registry row.
3. Confirm both control and transfer presence are gone and old north-bound
   requests/upgrades return unauthenticated.
4. Arm a fresh local pairing phrase and re-enroll only after the source of
   compromise is contained. Never reuse the old token or pairing phrase.
5. Review command audit, session events and relevant access changes by stable
   IDs/codes; do not paste credentials, prompts, transcript bodies, or host
   paths into routine logs/tickets.

## Cutover checklist

- Stable security runner passes from a clean, reviewed revision.
- OVSR-248 is resolved and proxy trust is verified in the deployed topology.
- No unresolved critical/high security finding remains.
- OVSR-129/130 fault suites pass every lifecycle boundary.
- Cross-workspace authorization covers every shipped operation family.
- Transfer write/checksum suites cover every shipped write operation.
- Logs, metrics, events, URLs, error bodies and projections pass sentinel-secret
  scans.
- Both socket channels are proven bounded under concurrent command/catalog/file
  load and no-inbound soak.
- Incident revoke/re-enroll procedures have been exercised in a
  non-production environment.
