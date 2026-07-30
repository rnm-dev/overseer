# Reverse fleet control security

This is the durable OVSR-150 threat model and security-test plan for the
Overseer ↔ Peon reverse control and transfer boundary. It describes the shared
tree as reviewed on 2026-07-30. It is a cutover gate, not an approval of work
that is still in progress.

Normative protocol details remain in
[the reverse command gateway](reverse-command-gateway.md),
[Peon-initiated enrollment](peon-claim-v1.md), and
[file viewing](file-viewing.md). The canonical claim contract is
`apps/peon/docs/peon-claim-protocol-v1.md`; the canonical reverse-command
contract is `apps/peon/docs/reverse-command-protocol-v1.md`.

## Security decision and current gate

The stable transport, ACL, file-containment, and information-flow layers have
an executable regression gate:

```sh
node scripts/security/run-reverse-fleet-security.mjs
```

This command is read-only apart from temporary test files and in-memory
databases. It does not contact production, deploy, or restart a service.

Reverse-only/public-boundary cutover is **not approved** by this document.
OVSR-129 is in Code Review; OVSR-130, OVSR-210, OVSR-145, and OVSR-147 are
unfinished. Their uncommitted semantics are listed under
[Blocked suites](#blocked-suites). OVSR-248 and OVSR-249 are fixed in the
working source; their deployment/review state remains part of the cutover gate.

The mixed-version legacy credential is also deliberately recoverable plaintext
in `peon_credentials.token` and `peons.token`, because Overseer still calls old
Peons. That is a high-impact compatibility risk, not evidence that `pc1`
implements hashing incorrectly. It must not survive the reverse-only/legacy
retirement gate in OVSR-211.

## Security objectives

The boundary must preserve these properties:

1. An operator can affect or observe only a workspace, Peon, project, and
   session authorized by server-side membership and ACL state.
2. Browser input never selects the command actor, Peon socket identity,
   workspace binding, credential generation, or durable delivery cursor.
3. At-least-once delivery cannot become more-than-once effect. Same ID/same
   canonical request joins one lifecycle; same ID/different request fails.
4. A stale socket, callback, async completion, ACK, or transfer frame cannot
   mutate the current generation.
5. Control traffic remains bounded and responsive under catalog, transcript,
   command, and file pressure.
6. Peon is authoritative for command admission/effect and filesystem
   containment; Overseer is authoritative for operator ACL and its safe,
   rebuildable projection.
7. Credentials, pairing/claim material, prompts, transcript bodies, private
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
| Legacy `pn_…` Peon credential | Secret and workspace/Peon bound; currently recoverable for callback compatibility |
| Claim `pc1.…` credential | HMAC-verifiable in the ordinary row; plaintext recoverable only while encrypted delivery is pending |
| Claim token, operator code, Ed25519 private key | Separate scopes; no browser access to claim token/private key; short operator-code lifetime |
| Workspace/Peon/project/session ACL | Integrity and non-enumerability |
| Command ID, request hash, actor and lifecycle | Integrity, replay safety, generation binding, durable recovery |
| Durable epoch/cursor/message ID | Ordered integrity; ACK only after atomic commit |
| Session/project projections and audit | Integrity, safe allowlist, actor/workspace scope |
| Project, sandbox, attachment and artifact bytes | Confidentiality to ACL; containment; bounded ranges/credit |
| Peon host paths/configuration | Not browser-visible unless explicitly part of an authorized product surface |
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
  | TB4 control socket        |       | TB5 transfer socket       |
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

  Peon identity + signed HTTPS ----> TB8 public claim service
                                      |
  operator code + owner approval --->+----> encrypted delivery /
                                            hashed credential state

  Legacy coexistence:

  operator -> Overseer -> inbound Peon /enroll -> pn_ credential
               (separate attempt lock; must never race claim mode)
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
| TB8 claim | Strict 16 KiB schema, minimal auth lookup, valid fresh Ed25519 proof, correct token/credential state | Redirect/downgrade, replayed nonce, bad origin/path/binding, workspace supplied by Peon, plaintext normal-row bearer |

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
- PostgreSQL and deployment keys are separate compromise domains. A database
  read alone must not recover an acknowledged `pc1` bearer.
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
| Claim or rotate with replayed proof | Fresh proof + semantic ID; nonce replay rejected | **blocked: OVSR-210/145/147** |
| Race claim and legacy enrollment | One durable method lease; losing credential revoked | **blocked: OVSR-210/145/147** |

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
- reverse-command contract/gateway, control and transfer sockets
- attachment sandbox, folder browse, project viewer, preview and ACL tests

Peon coverage:

- reverse-command channel/ledger characterization
- socket and credential-generation replacement
- project/sandbox file channels and folder listing
- human-settings credential redaction

The Peon command/gateway files are included as characterization against the
released envelope and stable transport boundaries. A green run does **not**
approve OVSR-129/130 persistence/fault semantics while those tasks are
unfinished.

Run one new cross-boundary file:

```sh
node --import tsx --test --test-concurrency=1 \
  apps/server/src/reverseFleetSecurity.test.ts
```

Run the complete stable security gate:

```sh
node scripts/security/run-reverse-fleet-security.mjs
```

The stable gate includes `proxyTrust.test.ts` for OVSR-248 and the
cross-boundary sentinel regression for OVSR-249.

## Blocked suites

These suites must be implemented and enabled before OVSR-150 can move to Code
Review.

| Blocked suite | Owner/dependency | Exit condition |
| --- | --- | --- |
| Crash before/after Peon command admission, effect, result persistence, publish and ACK | OVSR-129 | Reviewed ledger/outbox implementation and deterministic fault hooks |
| Overseer restart/disconnect at every send/accept/result/commit boundary; forged ACK/cursor/message collisions | OVSR-130 | Gateway task completes review and fault-injection surface is frozen |
| Cross-workspace tests for every future reverse operation family | Operation tasks + OVSR-129/130 | Operation is shipped and uses the one gateway/ledger |
| Claim brute force, real signature/origin/path binding, nonce replay, changed-body ID reuse, cleanup and restart | OVSR-210/145/147 | Frozen vectors and both runtime implementations complete |
| Claim approval/denial/expiry/cancel/ACK races | OVSR-210/145/147 | Final state machine and cleanup ordering reviewed |
| Recovery, rotation, retiring-credential upgrade refusal, grace eviction, revocation | OVSR-145/147 | Both socket registries consume final credential generations |
| Claim-versus-legacy race in both directions and downgrade on every transport outcome | OVSR-145/147 | Durable attempt/method leases complete |
| Transfer write checksum, atomic replace, post-completion write frames | OVSR-49/51/53 | Write protocol exists; no write operation exists today |
| Public-origin proxy/TLS/slowloris and no-inbound soak | OVSR-148/149/151/152 | Deploy the reviewed trusted-IP config and make staging topology available |
| Legacy credential plaintext removal | OVSR-211 | Mixed-version window ended and no callback credential remains |

Tests in unfinished claim files may be run for development, but their green
status must not be copied into this gate until the dependency moves through
review and the test is re-read against the final contract.

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
cannot rotate auth, claim-start, or operator-code attribution. A malformed
rightmost token is rejected as a non-IP and collapses to the trusted
application socket peer.

`proxyTrust.test.ts` exercises all three limits for an untrusted direct app
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

### OVSR-249 — absolute file-transfer root in error (resolved 2026-07-30)

Both legacy HTTP attachment resolution and reverse-transfer `PATH_ESCAPE`
failures now publish one generic message. Overseer replaces Peon-supplied
`PATH_ESCAPE` detail at ingestion and again at the HTTP boundary. The active
security-gate regression uses independent sentinel root and rejected-path
values and asserts that neither reaches the response body, durable/live browser
events, routine logs, or an upstream file read.

### Legacy recoverable bearer (high at cutover)

Legacy `pn_` credentials are plaintext in both the credential and Peon
registry rows. This is necessary only because Overseer still authenticates
outbound callbacks to legacy Peons. `pc1` normal rows use an HMAC verifier and
claim-mode Peon registry rows keep an empty callback token. Before legacy
retirement, database access therefore remains enough to impersonate a legacy
Peon. OVSR-211 owns removal; cutover evidence must prove there are no remaining
legacy credentials before declaring plaintext-bearer risk removed.

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

### Suspected legacy `pn_` credential compromise

1. Stop using the affected Peon for new work and record workspace, Peon ID,
   observed time, socket presence and affected sessions without copying the
   token into the incident record.
2. As workspace owner, remove/revoke the Peon through the authenticated fleet
   surface. Current `DELETE /api/workspaces/:wsId/peons/:id` revokes the legacy
   credential, evicts both sockets, and removes the registry row.
3. Confirm both control and transfer presence are gone and old north-bound
   requests/upgrades return unauthenticated.
4. Arm a fresh local pairing phrase and re-enroll only after the source of
   compromise is contained. Never reuse the old token or pairing phrase.
5. Review command audit, session events and relevant access changes by stable
   IDs/codes; do not paste credentials, prompts, transcript bodies, or host
   paths into routine logs/tickets.

### Suspected `pc1` bearer compromise

The following endpoints and rotation behavior are provisional until
OVSR-145/147 complete:

1. Revoke the specific credential immediately when the Peon identity is still
   trusted; otherwise revoke the whole Peon.
2. Confirm revocation committed before UI success, both sockets were evicted,
   and old HTTP/upgrades are rejected without a grace period.
3. If only the bearer was lost, start recovery with the same Ed25519 identity;
   owner approval must remain in the already-bound workspace. Older
   credentials are revoked only when the recovered credential ACK commits.
4. If the identity private key may be compromised, revoke the Peon, explicitly
   remove the identity binding, generate a new Peon ID/key and enroll as a new
   identity. Remote key reset is forbidden.
5. Routine rotation uses the old active bearer plus identity proof, persists
   the new bearer before ACK, rejects old new connections after ACK, and evicts
   lower-generation sockets on the first new-generation ready channel or the
   five-minute deadline.

No operator should execute these provisional `pc1` steps in production until
the feature gate, deployment keys, reviewed implementations and regression
suites are complete.

## Cutover checklist

- Stable security runner passes from a clean, reviewed revision.
- OVSR-248 is resolved and proxy trust is verified in the deployed topology.
- No unresolved critical/high security finding remains.
- OVSR-129/130 fault suites pass every lifecycle boundary.
- OVSR-210/145/147 claim/rotation/revocation suites are unblocked and pass.
- Cross-workspace authorization covers every shipped operation family.
- Transfer write/checksum suites cover every shipped write operation.
- Logs, metrics, events, URLs, error bodies and projections pass sentinel-secret
  scans.
- Both socket channels are proven bounded under concurrent command/catalog/file
  load and no-inbound soak.
- Legacy route selection is exclusive and the published mixed-version window is
  observed.
- Before claiming legacy risk removed, production inventory proves no
  recoverable callback credential remains.
- Incident revoke/rotate/re-enroll procedures have been exercised in a
  non-production environment.
