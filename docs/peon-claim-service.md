# Overseer Peon claim service

OVSR-147 implements the Overseer half of the frozen
[`peon-claim-v1`](peon-claim-v1.md). The capability is advertised only when its
explicit feature gate and all three independent deployment keys are configured.

## Configuration

The service has a separate `OVERSEER_PEON_CLAIM_V1=1` feature gate. Three
independent 32-byte, unpadded base64url deployment secrets are also required:

- `OVERSEER_PEON_CREDENTIAL_PEPPER` keys the HMAC verifier stored for a `pc1`
  bearer and the non-secret operator-code index;
- `OVERSEER_PEON_DELIVERY_KEY` seals the one pending recoverable bearer with
  AES-256-GCM.
- `OVERSEER_PEON_OPERATOR_CODE_KEY` separately seals the random operator code
  needed to replay a committed pending start response.

The keys do not live in Postgres. If any value is absent, malformed or equal to
either of the other keys,
`GET /api/v1/peon-claims/capabilities` returns
`UNSUPPORTED_CAPABILITY` and no claim or credential operation is admitted.
Generate each value independently with a cryptographically secure 32-byte
random source and encode it as unpadded base64url.

## Durable state

Migrations `025_peon_claim_v1` and `028_peon_claim_final_contract` create
separate ledgers for:

- stable Peon identity/workspace bindings and enrollment-method leases;
- claims, separately sealed operator codes, operator resolutions and seven-day
  attempt tombstones;
- versioned HMAC-verifiable claim credentials;
- AES-GCM-sealed pending deliveries;
- credential rotations;
- request-nonce replay protection and minimal post-completion ACK
  authentication material;
- fixed-window rate counters;
- audit-safe operator decisions and revocations.

The ordinary credential and Peon registry rows never receive a raw `pc1`
bearer. A reverse-only registry row carries an empty legacy callback token and
does not require a callback hostname or port.

Claim start validates the complete frame, clock and proof against the carried
Ed25519 identity before any durable lookup, mutation, rate admission or cleanup.
Authenticated follow-up operations perform only the operation-specific minimal
authentication lookup frozen in the security vectors. Clock/signature and
credential-admissibility checks precede a transaction that commits
request-nonce admission together with the semantic hash comparison and
lifecycle effect. Delivery ciphertext is not read or decrypted until that
transaction commits.

Claim/rotation access synchronously expires stale pending material before it can
be used. A minute worker, separate from unauthenticated request admission,
expires at most 500 abandoned claims and rotations per pass, revokes their
pending credentials, enforces at most 500 socket-grace deadlines and prunes at
most 500 rows from each replay/rate/terminal category.

## HTTP boundaries

Public Peon endpoints are mounted directly under `/api/v1` before both operator
authentication and the application-wide 1 MiB JSON parser. In production the
canonical Host/authority guard runs first, after the separate preview-host
dispatch, so a non-canonical authority receives `421 MISDIRECTED_REQUEST`
without entering claim parsing. Each correct-Host public POST owns a strict
16 KiB parser; malformed, non-object and oversized JSON all return the stable
JSON `claim_error` envelope rather than an Express error page. The routes also
enforce strict frame shape, proof/origin binding, `Cache-Control: no-store` and
durable rate limits.

Operator endpoints remain under the existing `/api` authentication boundary.
Cookie mutations retain the existing trusted-origin CSRF rule. Code resolution
records a short-lived claim/user grant. Approval locks and rechecks the actor's
owner membership inside the same transaction that binds the workspace and mints
the credential, so a role removal cannot race an earlier route observation.
Browser-safe claim details omit the public key, claim nonce/token material,
request proof, network source and every credential field.

The `/claim/XXXX-XXXX` page:

- captures the operator code and removes it from browser history;
- resumes the same page after GitHub sign-in without putting the code in an API
  URL;
- lists only workspaces the operator owns;
- shows the bounded display metadata and identity fingerprint;
- warns that recovery acknowledgement replaces older credentials;
- loads no third-party resources and uses a global `no-referrer` policy.

## Credential and connection lifecycle

`pc1` authentication parses the public credential UUID, loads one row,
recomputes the versioned HMAC over the complete bearer and compares it in
constant time. A pending credential authenticates only its claim or rotation
acknowledgement. Active credentials authenticate normal HTTP and WebSocket
traffic; revoked and retiring credentials cannot create new requests or socket
upgrades.

Both control and transfer connection registries remember the authenticated
credential generation. A ready newer-generation socket replaces the older
channel immediately. A delayed hello with a lower generation is rejected and
cannot replace the authoritative channel. Rotation acknowledgement schedules
lower-generation control and transfer eviction at the grace deadline;
Peon-wide, credential or existing fleet-delete de-recruitment revokes claim and
legacy credentials transactionally and evicts both channels immediately.

The legacy callback enrollment route remains available. Once it learns a Peon
ID, one advisory-locked transaction either binds the legacy credential and
records the legacy method lease, or observes the claim lease and revokes the
just-minted legacy credential. The claim-start transaction uses the same lock,
so both race directions have one winner.

## Retention and reconciliation

Proof timestamp and request nonce never enter the four semantic hashes. ACK
results remain replayable with fresh proof for 24 hours; the minimal ACK
authentication record survives terminal metadata cleanup so an installed
candidate still receives `CLAIM_NOT_FOUND` or `CREDENTIAL_REVOKED` rather than
an existence-dependent response. Cancel and ACK serialize on the same claim and
candidate rows. Cancel atomically removes its claim-token verifier, so no
repeatable authenticated cancel response is promised after the first commit.
