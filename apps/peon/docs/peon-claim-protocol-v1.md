# Peon claim and credential lifecycle protocol v1

Status: frozen normative contract; OVSR-145 and OVSR-147 may implement it, but this document does
not implement either side  
Capability: `peon-claim-v1`  
Wire version: `1`

This document is the canonical contract for Peon-initiated enrollment, credential recovery,
rotation, and revocation. The JSON Schema and golden exchanges beside the Peon source live at
`protocol/peon-claim-v1/`; Overseer's byte-identical vendor lives at the same path beneath
`apps/server`. Until `packages/protocol` is introduced by OVSR-239, the Peon copy is canonical.

`peon-claim-v1` is separate from `reverse-command-v1`: enrollment happens before an authenticated
control socket exists. It follows the same conventions where they apply: strict versioned JSON,
RFC 8785 canonicalization, stable UUID correlation IDs, explicit replay handling, bounded
retention, stable error codes, and generation fencing.

## Frozen decisions

- The transport is ordinary HTTPS with **short polling every two seconds**. There is no long poll
  and no claim WebSocket in v1.
- Peon creates and persists its stable Ed25519 identity before starting a claim. Overseer never
  generates or receives the private identity key.
- The operator code is an eight-character, 40-bit Crockford Base32 locator displayed as
  `XXXX-XXXX`. It is not a bearer credential. The separate 256-bit claim token never reaches the
  operator or browser.
- Overseer chooses the workspace only at authenticated operator approval. Peon cannot propose or
  change a workspace.
- A delivered Peon bearer credential is replayable over the authenticated claim poll until Peon
  acknowledges it. This is at-least-once network delivery of one credential, not an unsafe
  exactly-once HTTP response.
- Raw credentials are verifiable but not recoverable from the normal credential table. A pending
  credential is recoverable only from a separately encrypted delivery record, which is erased at
  acknowledgement, cancellation, denial, or expiry.
- Credential rotation has no period in which two credentials may create new connections. After
  rotation acknowledgement, the old credential may keep only already-authenticated sockets alive
  for up to five minutes; it cannot authenticate a new HTTP request or socket upgrade.
- Legacy Overseer-driven `POST /api/v1/enroll` remains a distinct compatibility mode. One durable
  enrollment attempt selects exactly one mode, and no automatic downgrade happens after a claim
  has been created.

## Origins and endpoints

`serverOrigin` is the configured canonical Overseer origin: lowercase scheme and host, explicit
non-default port if present, and no path, query, fragment, userinfo, or trailing slash. Production
claims require `https`. Plain HTTP is allowed only for literal loopback hosts `127.0.0.1`, `[::1]`,
or `localhost` in local development.

Peon must not follow redirects for any endpoint in this contract. A redirect, certificate error,
or response from an origin other than `serverOrigin` is a terminal transport error for that
request and never authorizes legacy downgrade.

### Public Peon endpoints

| Method and path | Authentication | Purpose |
|---|---|---|
| `GET /api/v1/peon-claims/capabilities` | none | Returns the exact supported claim version, limits, and server time. |
| `POST /api/v1/peon-claims` | Ed25519 request proof | Creates or idempotently resumes a claim attempt. |
| `POST /api/v1/peon-claims/:claimId/poll` | claim token + Ed25519 request proof | Short-polls state and, after approval, carries the pending credential. |
| `POST /api/v1/peon-claims/:claimId/cancel` | claim token + Ed25519 request proof | Cancels a pending or unacknowledged approved claim. |
| `POST /api/v1/peon-claims/:claimId/ack` | newly delivered credential + Ed25519 request proof | Proves installation, activates the credential, and erases delivery material. |
| `POST /api/v1/peon-credentials/rotations` | active credential + Ed25519 request proof | Idempotently creates a pending next-generation credential. |
| `POST /api/v1/peon-credentials/rotations/:rotationId/poll` | active old credential + Ed25519 request proof | Re-delivers the same pending credential until acknowledgement or expiry. |
| `POST /api/v1/peon-credentials/rotations/:rotationId/ack` | pending new credential + Ed25519 request proof | Activates the new generation and starts old-socket grace. |

The capability response is `200 claim_capabilities` when supported. A legacy Overseer returns
`404` or `400 UNSUPPORTED_CAPABILITY`. A `5xx`, `429`, network failure, invalid JSON, TLS failure,
or redirect does not mean unsupported.

### Authenticated operator endpoints

| Method and path | Purpose |
|---|---|
| `POST /api/peon-claims/resolve` with `{ operatorCode }` | Resolves a code to browser-safe claim details. |
| `POST /api/workspaces/:workspaceId/peon-claims/:claimId/decision` | An owner approves or denies the claim. |
| `POST /api/workspaces/:workspaceId/peons/:peonId/credentials/:credentialId/revoke` | Immediately revokes one credential. |
| `POST /api/workspaces/:workspaceId/peons/:peonId/revoke` | Immediately revokes every credential and socket for the Peon. |

Operator endpoints use existing web cookie/native device authentication. Request-supplied actor
identity is ignored. Approval and both revocation endpoints require the authenticated user to
hold the exact `owner` role in the route workspace; no lesser workspace role is sufficient.
Resolve and denial require an authenticated operator who presents the operator code.

Every cookie-authenticated mutating request, including decision and revocation, must carry an
`Origin` whose parsed origin exactly equals the configured public origin. A missing, opaque,
malformed, or cross-origin value returns `403 CSRF_ORIGIN` before authorization or mutation.
Native device-bearer requests do not use cookies and are exempt from this Origin check. An
authenticated non-owner revocation returns `403 FORBIDDEN`; an unknown or cross-workspace target
returns `404 NOT_FOUND` without disclosing which route component failed.

Revocation authorization order is externally stable: authenticate the operator; enforce cookie
Origin when applicable; resolve and verify that the target belongs to the route workspace; check
the `owner` role; then lock and mutate. Unauthenticated requests are `401 UNAUTHENTICATED`.
Unknown and cross-workspace targets are both `404 NOT_FOUND` before role evaluation, even when the
caller is not an owner. Authentication, CSRF, unknown-target, and cross-workspace failures write
no business audit event and perform no lifecycle/socket mutation; only bounded security counters
may record them.

Revocation bodies are the strict `revocationRequest` schema and their credential/Peon ID must
equal the corresponding route ID. Success is strict `revocation_result`; operator-boundary
failures are strict `operator_error`. Credential scope returns `CREDENTIAL_REVOKED`; Peon scope
returns `PEON_REVOKED`. `changed:false` on an authorized repeat preserves the original
`revokedAt`, reports zero newly revoked credentials/sockets, and still records
`already_revoked` in audit.

The human page is `/claim/XXXX-XXXX`. It may carry the operator code in the URL, but must set
`Referrer-Policy: no-referrer`, load no third-party resources, remove the code from browser history
after resolving it, and submit the code in an API request body rather than an API URL.

## Peon identity and signed requests

On first use Peon creates:

- a random canonical UUID `peonId`;
- an Ed25519 keypair;
- `identityKeyId = "ed25519:" + BASE64URL(SHA-256(RFC8785(publicJwk)))`.

`publicJwk` is exactly `{ "kty": "OKP", "crv": "Ed25519", "x": "<43 base64url chars>" }`.
Peon persists `peonId` and the private key before network I/O. The private key belongs in an OS
credential store when available; the fallback is a Peon-owned file with mode `0600`. It never
enters settings JSON, logs, crash reports, metrics, URLs, browser state, or Overseer's database.

The stable identity is `(peonId, identityKeyId)`. A first approved claim permanently binds that
pair. A later claim for the same `peonId` is recovery only when the signature verifies with the
already bound public key. A different key for an existing `peonId` returns
`IDENTITY_KEY_MISMATCH`; there is no remote key reset. If both credential and private identity key
are lost, an owner must revoke/delete the old Peon and enroll the machine with a new identity.

Every Peon mutation and every credential-bearing poll is a JSON `POST` and is signed.
The capability probe is the only `GET` in this contract. Signed JSON requests contain:

```json
{
  "proof": {
    "issuedAt": 1785427200000,
    "requestNonce": "22-base64url-characters",
    "signature": "86-base64url-characters"
  }
}
```

The Ed25519 signature input is UTF-8 RFC 8785 canonical JSON of:

```json
{
  "capability": "peon-claim-v1",
  "protocol": 1,
  "serverOrigin": "https://overseer.example.test",
  "method": "POST",
  "path": "/api/v1/peon-claims",
  "bindingNonce": "<claimNonce for claim requests, null for rotation requests>",
  "body": "<complete request object with proof.signature omitted>"
}
```

The path is the decoded, normalized path only; it never contains a query string. Method is
uppercase. The `claimNonce` created in `claim_start` is the `bindingNonce` for start, poll,
cancel, and acknowledgement; rotation requests use `null`. Polling uses
`claim_poll` or `credential_rotation_poll`; cancellation uses
`claim_cancel`, so proofs never depend on GET/DELETE request bodies or query parameters.
`serverOrigin`, method, path, body digest-equivalent canonicalization, the claim nonce,
attempt/rotation ID, and credential delivery acknowledgement are therefore all signature-bound.

`requestNonce` is 16 random bytes encoded as unpadded base64url. A previously admitted nonce is
rejected while `nonceAge <= 86400000` and is forgotten after that boundary; semantic idempotency
still prevents the repeated operation from taking effect.
Requests more than 120 seconds from Overseer's clock fail with `CLOCK_SKEW` and a safe
`serverTime`; the rejected nonce is not consumed. Peon retries with a fresh timestamp and nonce.
Overseer time is authoritative for expiry. The standard HTTP `Date` header and all protocol
responses carry `serverTime`.

### Fresh proofs and semantic idempotency

A proof is transport freshness, not request identity. Peon never persists or retries an old
`proof`. Every network retry and every resume after daemon restart rebuilds the same semantic body
with a new `issuedAt`, a new random `requestNonce`, and a new signature. This is required even when
the previous proof remains inside the 120-second window. Re-sending the same signed bytes is a
nonce replay, not an idempotent retry.

The semantic request hash is:

```text
LOWERCASE_HEX(SHA-256(UTF8(RFC8785(semanticObject))))
```

The four semantic objects are exact:

| Operation | Durable idempotency key | `semanticObject` |
|---|---|---|
| `claim_start` | `attemptId` | complete body excluding `attemptId` and the entire `proof` |
| `credential_rotation_start` | `rotationId` | complete body excluding `rotationId` and the entire `proof` |
| `claim_ack` | `(claimId, deliveryId)` | complete body excluding the entire `proof` |
| `credential_rotation_ack` | `(rotationId, deliveryId)` | complete body excluding the entire `proof` |

The route ID must equal the ID in the body before hashing. Excluding the idempotency key from a
start hash follows `reverse-command-v1`: the key selects the durable row, the hash is lowercase
SHA-256 over RFC 8785 bytes, and the semantic hash detects changed work. ACK IDs remain in their
semantic object except for proof freshness; this binds credential ID and generation to the
acknowledged delivery.

With a fresh valid proof, the same key and semantic hash selects the already committed lifecycle
row; it returns `replayed: true` only when the current response schema has all required material.
A changed semantic hash returns `ATTEMPT_ID_REUSED`,
`ROTATION_ID_REUSED`, `CLAIM_ACK_MISMATCH`, or `ROTATION_ACK_MISMATCH` and performs no effect.
Claim and rotation ACK stable results are retained for exactly 24 hours after commit. At
`resultAge <= 86400000` a fresh-proof retry returns the completion; after that, claim ACK returns
`CLAIM_NOT_FOUND` and rotation ACK returns `ROTATION_EXPIRED`. Start request/hash tombstones remain
seven days as specified below.

Claim-start retry output is state-dependent and never reconstructs erased operator material:

| Durable state at admission | Exact result |
|---|---|
| `pending` and `now < claim.expiresAt` | `201 claim_created`, `replayed:true`, using the still-sealed original operator code |
| `approved` and `now < delivery.expiresAt` | `409 CLAIM_ALREADY_ACTIVE`, `state:"approved"`, `claimId`, delivery expiry; no code or credential |
| `completed` while terminal metadata remains | `409 CLAIM_ALREADY_ACTIVE`, `state:"completed"`, `claimId`; no code or credential |
| `denied`, `cancelled`, or `expired` while terminal metadata remains | matching `409 CLAIM_DENIED|CLAIM_CANCELLED` or `410 CLAIM_EXPIRED`, `claimId`; no code |
| terminal metadata removed but the seven-day attempt tombstone remains | `410 ATTEMPT_RETIRED`; no `claimId`, code, URL, or credential |
| tombstone removed | no replay exists; the fresh signed request is admitted as a new claim only if normal eligibility permits, with a new `claimId` and new operator code and `replayed:false` |

Expiry is synchronous: a pending claim is expired when `now >= claim.expiresAt`, and an approved
delivery is expired and its candidate credential revoked when `now >= delivery.expiresAt`.
Terminal metadata remains through `terminalAge <= 86400000` and is removed after that boundary.
The attempt tombstone remains through `terminalAge <= 604800000` and is removed after that
boundary. A new claim after tombstone removal is not resurrection: the erased claim ID and
operator code are never recovered or reused.

A lost response never requires an old proof:

- crash before the admission transaction commits rolls it back; a fresh-proof retry creates the
  row once;
- crash after commit but before response is recovered by the same semantic request with a fresh
  proof and nonce;
- crash after Peon persists a delivered credential but before ACK sends the same semantic ACK with
  a fresh proof;
- crash after ACK commits but before its response returns the stored completion to a fresh-proof
  ACK for the remaining 24-hour result window.

### Authentication-material lookup and replay-check ordering

Proof verification may perform one bounded, read-only authentication lookup first, because poll,
cancel, and ACK messages intentionally do not repeat the public key or claim nonce. This lookup may
read only the locator and verifier, Peon and identity IDs, public JWK, claim nonce, server-origin
binding, and credential generation/state enumerated per operation in
`security-vectors.json:minimalLookupPolicy`. `claim_start` may read only the identity's bound public
JWK while using the submitted public JWK for first-claim verification. Workspace binding and every
workspace-dependent lifecycle check occur after proof verification.

Before proof verification the implementation must not read or decrypt a delivery ciphertext,
load an operator code/actor or workspace membership, read the enrollment lease, rotation/claim
state, expiry, semantic hash or stable result, emit an audit payload, or mutate any row.
The complete required order is:

1. enforce the 16 KiB bound and strict JSON/schema/route-ID shape;
2. perform the minimal lookup and constant-time claim-token/credential-verifier comparison;
   an absent/mismatched public locator returns generic `UNAUTHENTICATED`;
3. check `issuedAt`; out-of-window returns `CLOCK_SKEW` and does not consume the nonce;
4. verify identity/key/origin/path/binding and Ed25519 signature; failure does not consume the
   nonce;
5. reject an otherwise authenticated revoked, retired, wrong-generation, or inadmissible pending
   credential without consuming the nonce;
6. in one transaction, insert `(identityKeyId, requestNonce)`, lock the idempotency/lifecycle row,
   compare the semantic hash, and either commit one effect or select the stored stable result;
7. only after step 6 may a valid poll or replay response decrypt its bounded pending delivery.

The nonce insert and lifecycle/idempotency decision commit or roll back together. Therefore a
crash cannot consume a nonce without recording the effect/result. Ordering is externally stable:
a stale request with a seen nonce is `CLOCK_SKEW`; a bad signature with a seen nonce is
`BAD_SIGNATURE`; a valid proof with a seen nonce is `REQUEST_REPLAYED`; a valid fresh nonce with a
changed semantic body reaches the operation-specific reuse/mismatch code. Invalid auth is always
`UNAUTHENTICATED` before skew or signature details.

## Claim initiation

Peon creates and durably stores before sending:

- `attemptId`: UUID idempotency key;
- `claimNonce`: unpadded base64url encoding of 32 random bytes;
- `claimToken`: unpadded base64url encoding of 32 random bytes;
- the chosen `mode = "claim"`;
- `serverOrigin`, the semantic claim-start fields, and their semantic hash; no proof bytes.

Only `claimTokenHash = BASE64URL(SHA-256(decoded 32 claimToken bytes))` is sent or stored by
Overseer. Poll, cancel, and claim status requests use `Authorization: Bearer <43-character
claimToken>`; Overseer requires canonical unpadded base64url, decodes it, hashes the 32 bytes, and
constant-time compares the result. The raw claim token is never returned by Overseer.

`claim_start` includes the stable identity, claim nonce, token hash, and bounded display metadata:
user-configured Peon name, `darwin|linux|windows`, daemon version, and architecture. It excludes
hostnames, IP addresses, filesystem paths, usernames, environment variables, projects, and agent
configuration.

Creation returns `claim_created` with:

- server-generated UUID `claimId`;
- the operator code and canonical operator URL;
- `createdAt`, `expiresAt`, `serverTime`, and `pollAfterMs = 2000`;
- `replayed`, true only for a semantic retry carrying a fresh accepted proof.

To make a lost initial response recoverable, Overseer seals the generated operator code with
AES-256-GCM until the claim leaves `pending`. The sealed code uses a dedicated versioned
operator-code key, never the credential-delivery key, and follows the same 96-bit CSPRNG
nonce/unique `(keyVersion, nonce)` rule. It is readable only after valid proof admission of the
same semantic attempt. Only the code hash/index participates in operator resolution. Approval, denial,
cancellation, or synchronous claim expiry erases both the sealed code and its index; every later
start outcome is the code-free result in the table above.

Every claim and credential-lifecycle response carries `Cache-Control: no-store`.
Only one active claim may exist for an identity. A same-semantic fresh-proof retry resumes it. A different
`attemptId` receives `CLAIM_ALREADY_ACTIVE` and the existing non-secret `claimId` and expiry, but
never its operator code. The pending claim and operator code expire exactly ten minutes after
creation.

## Operator approval, denial, and workspace binding

Code resolution is authenticated and returns only `claim_details`: claim ID, state, stable Peon
ID, identity fingerprint, bounded display metadata, and timestamps. It does not return the public
key, claim nonce, token hash, request proof, network source, or any credential material.

The approval transaction:

1. verifies owner access to the route workspace and that the claim is still pending;
2. locks the claim, identity binding, and credential-generation rows;
3. establishes or verifies `(peonId, identityKeyId)`;
4. rejects a Peon bound to another workspace with `PEON_ALREADY_CLAIMED`;
5. chooses `mode = "new"` for an unbound identity or `mode = "recover"` for the same identity in
   the same workspace;
6. mints exactly one pending credential and encrypted delivery record;
7. commits the workspace, actor, decision, credential ID, and delivery expiry atomically.

Peon never supplies `workspaceId`. After approval, neither actor nor workspace can change.
Recovery is explicit in the decision result and the dashboard must warn that acknowledgement will
replace every older credential.

Denial records the authenticated actor and changes pending to `denied`; no credential is minted.
The Peon sees stable code `CLAIM_DENIED`, never the actor or a free-text reason. Approval, denial,
and expiry race under the same row lock: the first committed transition wins and every loser gets
the already committed state. Repeating the same decision is idempotent; the opposite decision
returns `CLAIM_ALREADY_DECIDED`.

## Credential format, storage, and delivery

A v1 bearer is:

```text
pc1.<credentialId UUID>.<43-character unpadded base64url secret>
```

The secret is 32 cryptographically random bytes. Credential rows contain credential ID, Peon ID,
workspace ID, identity key ID, integer generation, state, timestamps, pepper version, and
`HMAC-SHA-256(key = credentialPepper[version], message = completeBearer)`. Verification parses the public credential
ID, loads one row, recomputes the keyed hash, and compares it in constant time. The database never
stores the raw bearer. Pepper versions are deployment secrets outside the database.

While delivery is pending, the complete bearer is separately sealed with AES-256-GCM under a
versioned deployment credential-delivery key. The authenticated encryption associated data is
RFC 8785 canonical JSON of `{ protocol, claimId|rotationId, credentialId, peonId, workspaceId,
identityKeyId, generation }`. Nonce, ciphertext, tag, and key version may be stored. Plaintext may
exist only in bounded request memory and Peon's secret store.

Every sealing invocation obtains a 96-bit nonce directly from a CSPRNG. `(deliveryKeyVersion,
nonce)` must be unique across all claim and rotation deliveries and is protected by a database
unique constraint; collision retries generate a new nonce before encryption. Reuse under the same
key version is forbidden even for the same plaintext, delivery, process, retry, or restart.
Network retries and restarts do not reseal: they read and return the one stored nonce/ciphertext/tag
tuple. Key rotation may reseal only with a new key version and a newly generated nonce. The
executable tuple and uniqueness assertions are in `security-vectors.json:storageEncryptionVector`.

Approval starts a ten-minute delivery window independent of the original code expiry. An
authenticated `claim_status` returns state `approved`, a `deliveryId`, credential ID, generation,
complete bearer, workspace ID, and delivery expiry. Repeated valid polls before acknowledgement
return the **same** delivery ID and bearer. No second credential is minted.

Peon must atomically persist `serverOrigin`, Peon ID, identity key reference, credential ID,
generation, and bearer before acknowledgement. It then calls claim acknowledgement authenticated
by the new bearer and signed by the identity key. Successful acknowledgement:

- activates the credential;
- changes the claim to `completed`;
- erases encrypted delivery material and the claim token hash;
- for recovery, revokes every older credential and evicts every older socket generation;
- returns `claim_completed`.

The new credential may authenticate only its acknowledgement until activation. A same-semantic
acknowledgement with a fresh proof returns the stored completion for 24 hours; proof timestamp and
request nonce never participate in its semantic hash. If acknowledgement never arrives,
expiry revokes the pending credential and erases delivery material; it never affects an existing
credential.

## Claim state machine, restart, and cleanup

```text
pending ──approve──> approved ──ack──> completed
   │                    │
   ├──deny──────────> denied
   ├──cancel────────> cancelled <────cancel
   └──10m───────────> expired   <────10m delivery timeout
```

`completed`, `denied`, `cancelled`, and `expired` are terminal. Cancel and acknowledgement lock the
same claim and candidate-credential rows; the first commit wins. ACK-wins activates the candidate,
commits `completed`, and makes any already-authenticated losing cancel return
`409 CLAIM_ALREADY_DECIDED` with `state:"completed"`; a cancel arriving after verifier cleanup gets
generic `401 UNAUTHENTICATED`. Cancel-wins commits `cancelled`, revokes the candidate while
retaining its HMAC verifier/state, and every losing or retried ACK authenticated by that bearer
returns `401 CREDENTIAL_REVOKED`. Neither loser can reverse the winning transaction.

`claim_cancel` is authenticated by the claim token only while its verifier remains. Cancelling
`pending` or `approved` atomically changes the state to `cancelled`, revokes a pending credential,
erases delivery/operator-code/lease material and the claim-token hash, and returns
`claim_cancel_result { state:"cancelled", code:"CLAIM_CANCELLED", changed:true, terminalAt }`.
There is intentionally no authenticated repeat after that cleanup: a lost cancel response followed
by another cancel receives generic `401 UNAUTHENTICATED`. This response alone is ambiguous and
must never make Peon discard a persisted candidate credential.

For `denied` or `expired`, the verifier remains only until first terminal observation. A valid
cancel during that window does not change state; it returns `claim_cancel_result` with the existing
state/code, `changed:false`, and erases the verifier as that observation commits. `completed` and
already `cancelled` have no claim-token verifier and cannot authenticate cancel. Thus cancellation
is idempotent in effect, but the protocol does not promise a repeatable response after secret
cleanup.

Peon reconciliation is deterministic whenever a candidate bearer has been persisted. After any
ACK/cancel timeout, connection loss, ambiguous cancel `401`, daemon restart, or lost response, Peon
keeps the candidate and sends the same semantic `claim_ack` with a fresh proof authenticated by
that candidate:

- `claim_completed` (new or `replayed:true`) means ACK won; Peon promotes the candidate to active,
  erases local claim-token/attempt state, and must not report cancellation;
- `CREDENTIAL_REVOKED` means cancel or expiry won; Peon erases the candidate and records the
  terminal cancellation/expiry;
- `CLAIM_NOT_FOUND` after the 24-hour ACK-result window is not evidence that cancel won. Peon keeps
  the candidate and opens the normal reverse control WebSocket with it. A credential-authenticated
  `hello_ack` for the persisted Peon ID/generation confirms the candidate is active and Peon
  promotes it; `CREDENTIAL_REVOKED` confirms cancellation/expiry and permits deletion;
- transport/`5xx`/`429`/`PERSIST_FAILED` remains unknown and retries; it never deletes the
  candidate or starts another enrollment.

The candidate credential row and verifier therefore remain through the 24-hour ACK-result window
even when revoked. This reconciliation survives both process restarts and both commit-before-
response race directions, so Peon never discards a valid ACK-wins enrollment.

Claims, decisions, encrypted delivery, credential states, identity bindings, request nonces, and
idempotency hashes are durable database state. Overseer restart therefore changes no claim result.
Peon persists its attempt before sending and resumes the same short poll after restart. A lost
start response is recovered by rebuilding the same semantic `claim_start` with a fresh proof and
request nonce.

Terminal claim metadata is kept through 24 hours after `terminalAt`. Attempt ID plus canonical
request-hash tombstones are kept through seven days after `terminalAt`, so a delayed replay cannot
mint another credential. Request nonces are kept for 24 hours. Encrypted delivery and the sealed
operator code/index are erased as soon as their purpose ends. The claim-token hash is erased at
acknowledgement or cancellation; for denial/expiry it is
retained only until the first authenticated terminal poll, or 24 hours at most, so Peon can learn
the outcome without making terminal material indefinitely usable. Expiry cleanup must also run
synchronously on every access, so a delayed sweeper never makes expired material usable.

## Rotation

Rotation is Peon-initiated HTTPS, not a reverse command. `credential_rotation_start` contains a
UUID `rotationId`, current credential ID and generation, and an identity proof. Authorization uses
the current active credential. Server-derived Peon and workspace bindings must match the signed
identity; a request cannot nominate another Peon or workspace.

One rotation may be pending per Peon. The start transaction mints generation `current + 1`, stores
one encrypted delivery, and returns it. Semantic retries and the rotation poll endpoint return the
same pending bearer when they carry a fresh proof and the same semantic hash. The delivery window
is ten minutes. Until acknowledgement, the new credential may authenticate only the rotation
acknowledgement and the old credential remains fully active.

Peon persists the new bearer before acknowledging with it. A successful `rotation_ack` atomically:

- activates the new generation;
- marks the previous credential `retiring`;
- rejects the old credential for every new HTTP request and WebSocket upgrade;
- lets only sockets already authenticated with the old generation live until
  `oldSocketGraceEndsAt = acknowledgedAt + 300000`;
- erases encrypted delivery material.

The first successfully authenticated control or transfer `hello` using the new generation
immediately evicts **all** lower-generation control and transfer sockets. Otherwise the server
evicts them at the five-minute grace deadline. Within one generation, the existing rule remains:
the newer ready socket replaces the older socket for that channel. A stale socket's frames and
callbacks are generation-fenced and cannot mutate current state.

If rotation expires before acknowledgement, the pending credential is revoked and erased and the
old generation stays active. `rotationId` and request-hash tombstones remain seven days. The
normative stable conflicts are `ROTATION_ALREADY_ACTIVE`, `ROTATION_ID_REUSED`,
`ROTATION_ACK_MISMATCH`, `CREDENTIAL_GENERATION_MISMATCH`, `CREDENTIAL_RETIRED`, and
`ROTATION_EXPIRED`. A same-semantic rotation ACK with a fresh proof returns its stored completion
for 24 hours; revocation of the new credential wins before replay and returns
`CREDENTIAL_REVOKED`.

## Revocation and recovery

Both revocation routes are owner-only destructive mutations with the authentication, CSRF,
cross-workspace concealment, and stable errors specified above. Every authenticated request that
passes the CSRF boundary and resolves a same-workspace target writes exactly one immutable audit
event with server-derived actor user ID, route workspace/Peon/credential IDs as applicable,
request ID, timestamp, scope, and outcome `revoked|already_revoked|forbidden`; it never records a
bearer, verifier, identity private
material, delivery ciphertext, or claim token. An authorized mutation and its `revoked` or
`already_revoked` audit event commit in one transaction before success. A forbidden request writes
only its denial audit event and performs no lifecycle or socket mutation. Unauthenticated, CSRF,
unknown-target, and cross-workspace rejections occur before business audit and emit only bounded
security counters.

Operator revocation commits before returning success. It immediately rejects the credential for
HTTP and upgrades, evicts its control and transfer sockets, and fences late callbacks. Revoking a
Peon revokes active, retiring, and pending credentials, cancels active claims/rotations, erases
deliveries, and evicts every socket generation. Revocation is idempotent and has no grace period.

Loss of only the bearer uses a new claim with the same stable identity. Owner approval reports
`mode = "recover"`; old credentials are not changed until the recovered bearer is acknowledged,
then all older generations are revoked atomically. A previously revoked Peon may recover only
when its identity binding still exists and the approving user owns the same workspace.

Loss or compromise of the identity private key cannot be recovered remotely. The owner revokes the
old Peon, explicitly removes its identity binding, and enrolls a new `peonId` and key. Removing an
identity binding is a separate destructive operator action and is never implied by a claim,
credential rotation, daemon reinstall, or timeout.

## Rate limits and bounds

Servers may be stricter, but must never be weaker than these v1 limits and must return `429
RATE_LIMITED` with integer `retryAfterMs`:

| Scope | Required limit |
|---|---:|
| Claim starts per source IP | 5 per 10 minutes |
| Claim starts per identity key | 3 per hour |
| Active claims per identity | 1 |
| Poll/cancel requests per claim token | 1 per second; compliant clients wait `pollAfterMs = 2000` plus 0–500 ms jitter |
| Failed operator-code resolutions per source IP | 10 per 10 minutes |
| Failed operator-code resolutions per user | 5 per 10 minutes |
| Decisions per user | 10 per 10 minutes |
| Rotations per Peon | 3 per 24 hours |

Complete JSON request and response bodies are limited to 16 KiB. Display name is 120 Unicode
scalar values; daemon version is 64 ASCII characters. Operator codes use eight Crockford Base32
characters excluding `I`, `L`, `O`, and `U`. Claim and credential secrets are exactly 32 bytes.
An implementation must bound active claim rows and cleanup work globally; capacity exhaustion is
`503 CLAIM_CAPACITY_EXCEEDED`, never eviction of an active or unacknowledged claim.

## Stable errors

Every error uses strict `claim_error` with `protocol`, stable `code`, safe `message`,
`serverTime`, and optional `retryAfterMs` or already-committed `state`. English text is not
branchable. V1 codes are:

- validation/authentication: `BAD_REQUEST`, `UNSUPPORTED_CAPABILITY`, `UNSUPPORTED_PROTOCOL`,
  `INVALID_IDENTITY`, `BAD_SIGNATURE`, `CLOCK_SKEW`, `UNAUTHENTICATED`, `FORBIDDEN`;
- replay/correlation: `REQUEST_REPLAYED`, `ATTEMPT_ID_REUSED`, `ATTEMPT_RETIRED`, `ROTATION_ID_REUSED`,
  `CLAIM_ACK_MISMATCH`, `ROTATION_ACK_MISMATCH`;
- claim lifecycle: `CLAIM_NOT_FOUND`, `CLAIM_ALREADY_ACTIVE`, `CLAIM_ALREADY_DECIDED`,
  `CLAIM_DENIED`, `CLAIM_CANCELLED`, `CLAIM_EXPIRED`, `CLAIM_CAPACITY_EXCEEDED`;
- identity/workspace: `IDENTITY_KEY_MISMATCH`, `PEON_ALREADY_CLAIMED`,
  `WORKSPACE_MISMATCH`, `ENROLLMENT_METHOD_LOCKED`;
- credential lifecycle: `CREDENTIAL_INVALID`, `CREDENTIAL_REVOKED`, `CREDENTIAL_RETIRED`,
  `CREDENTIAL_GENERATION_MISMATCH`, `ROTATION_ALREADY_ACTIVE`, `ROTATION_EXPIRED`;
- service: `RATE_LIMITED`, `PERSIST_FAILED`, `INTERNAL`.

Bad credentials and unknown IDs exposed to unauthenticated callers both map to `401
UNAUTHENTICATED`, preventing existence probing. Browser code resolution returns a generic
`404 CLAIM_NOT_FOUND` for unknown, expired, denied, cancelled, or already consumed codes.
Internal database, cryptographic, network, and operator details never enter `message`.

## Information-flow policy

| Value | Terminal | Browser/dashboard API | Audit log | Database | URL | Metrics |
|---|---|---|---|---|---|---|
| Operator code and URL | yes, once per attempt plus same-attempt pending replay | code may be submitted; remove after resolve | no code | hash/index plus separately sealed code only while pending | operator code only | no |
| Peon ID, claim/attempt/rotation/delivery/credential IDs | claim/Peon IDs allowed | claim/Peon/credential IDs allowed after auth | yes | yes | only route IDs, never query | no identifiers |
| Display name, platform, architecture, daemon version | yes | yes | display name omitted; version/platform allowed | yes | no | low-cardinality platform/version only |
| Identity public key | fingerprint only | fingerprint only | fingerprint only | public key + fingerprint | no | no |
| Identity private key | never | never | never | never on Overseer | never | never |
| Claim nonce, raw claim token, request signature | never | never | never | nonce/hash/signature only as required for replay/proof | never | never |
| Raw Peon bearer | never | never | never | only encrypted pending delivery; never verifier row | never | never |
| Credential verifier, pepper, delivery key/ciphertext | never | never | never | verifier and sealed delivery only; keys stay outside DB | never | never |
| Workspace and actor IDs | success summary may name workspace, not actor | authorized views only | yes | yes | workspace route ID only | counts only |
| State, timestamps, stable error code | yes | yes | yes | yes | no | yes, low cardinality |
| Source IP and user agent | never | never | security audit only with retention policy | optional security log, not claim row | no | aggregated/rate-limit only |

Routine logs contain only protocol version, state transition, stable error code, and correlation
IDs already allowed above. They never serialize request/response bodies or authorization headers.
Debug logging does not relax this table. Browser responses never include the public key itself,
claim token hash, signed proof, source address, raw or sealed credential, verifier, operator actor,
or denial reason.

## Legacy `/enroll` coexistence and downgrade

Legacy `/api/v1/enroll` remains available only for Peons that do not complete this claim
capability during the mixed-version support window. It keeps its existing pairing phrase,
Overseer-minted `pn_...` token, and callback behavior; it does not become an alternate frame in
`peon-claim-v1`.

Before beginning enrollment, Peon durably creates one `attemptId` and selects one mode:

1. Probe the capability endpoint.
2. Select `claim` only after a valid `claim_capabilities` response.
3. Automatic legacy selection is allowed only after explicit `404` or
   `UNSUPPORTED_CAPABILITY`, before any claim ID or server-side identity lease exists.
4. Network/TLS/redirect/timeout/`5xx`/`429` failures remain retryable claim failures and never
   select legacy.
5. After `claim_created`, switching to legacy requires an explicit local operator cancellation,
   terminal confirmation or expiry, and a **new** attempt ID.

Peon persists the mode lock. While a claim attempt is active or an approved credential awaits
acknowledgement, its inbound legacy `/enroll` returns `409 ENROLLMENT_METHOD_LOCKED` before
accepting or persisting a token. Arming a legacy pairing phrase first selects legacy mode and
prevents claim start for that attempt.

Overseer also holds one active enrollment lease per stable Peon identity. Claim creation acquires
it. Legacy recruitment that later learns the same `peonId` must atomically fail binding, revoke
the just-minted legacy credential, and return `409 ENROLLMENT_METHOD_LOCKED` while the claim lease
exists. Identity/workspace uniqueness prevents two races from committing divergent Peon records.

No client retries a failed action through both paths, no credential is copied from one mode into
the other, and no capability response is inferred from version numbers. Removing legacy
`/enroll` is deferred to OVSR-211 after the mixed-version production window.

## Conformance requirements

The versioned schema is normative for JSON shape; this document is normative for HTTP,
cryptographic, persistence, ordering, and information-flow behavior. Implementations must:

- reject unknown JSON properties and non-canonical enum spellings;
- validate every golden valid fixture against both its named schema definition and the schema
  document root union;
- reject every golden invalid fixture for the expected stable reason;
- keep Peon and Overseer schema, fixture, and security-vector vendors byte-identical;
- execute `security-vectors.json` independently of service code: verify RFC 8785 bytes, SHA-256
  hashes, the Ed25519 signature, all four semantic hashes, lookup restrictions, replay/skew
  ordering, fresh-proof restart recovery, changed bodies/nonces, claim/delivery/metadata/tombstone
  boundaries, ACK result retention, both ACK-versus-cancel race directions, AES-GCM sealing and
  nonce uniqueness, owner/CSRF/audit revocation outcomes, rotation, revocation, terminal cancel
  cleanup, and both claim-versus-legacy race directions;
- test success, denial, cancellation, expiry, semantic replay, changed-body ID reuse,
  request-nonce replay, recovery, rotation timeout, rotation acknowledgement, revocation, restart
  at every persistence boundary, and claim-versus-legacy races;
- never advertise `peon-claim-v1` until all required endpoints, persistence, cryptography,
  cleanup, and generation fencing are active.
