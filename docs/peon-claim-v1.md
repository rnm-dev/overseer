# Peon-initiated enrollment contract

OVSR-210 freezes `peon-claim-v1` as the one contract OVSR-145 (Peon) and
OVSR-147 (Overseer) implement. This page records the project-level decisions and
artifact ownership; the normative wire/security contract is
`apps/peon/docs/peon-claim-protocol-v1.md`.

## Canonical and vendored artifacts

Until OVSR-239 introduces `packages/protocol`, the canonical artifacts are:

- `apps/peon/docs/peon-claim-protocol-v1.md` — normative HTTP, cryptographic,
  persistence, lifecycle, security, and information-flow rules;
- `apps/peon/protocol/peon-claim-v1/schema.json` — strict Draft 2020-12 JSON
  schemas;
- `apps/peon/protocol/peon-claim-v1/fixtures.json` — golden success, denial,
  cancellation, expiry, replay, recovery, rotation, and legacy-conflict
  exchanges;
- `apps/peon/protocol/peon-claim-v1/security-vectors.json` — executable RFC
  8785, SHA-256 and Ed25519 vectors plus golden security-state inputs and stable
  results.

Overseer carries byte-identical schema, fixture, and security-vector vendors under
`apps/server/protocol/peon-claim-v1/`. Contract tests in both apps validate the
golden frames against both their named definitions and the schema root union,
reject malformed frames, execute cryptographic and semantic
idempotency vectors, freeze security bounds/error mappings, check browser-safe
payloads, and compare every vendor byte for byte.

Moving these files into `packages/protocol` belongs to OVSR-239. OVSR-210 does
not create the package or make runtime code depend on it.

## Frozen decisions

- Enrollment uses outbound HTTPS short polling every two seconds. V1 has no
  long poll and no claim WebSocket.
- A Peon persists a stable UUID plus Ed25519 identity key before claiming.
  Overseer permanently binds the public-key fingerprint; it never receives the
  private key.
- The terminal shows an eight-character operator code/URL. A separate 256-bit
  claim token authenticates Peon polling and never reaches the operator,
  dashboard, browser, URL, audit log, or metrics.
- Pending claims and pending credential delivery each live for ten minutes.
  Overseer time is authoritative, with a two-minute signed-request clock-skew
  allowance.
- Every retry and restart uses a fresh proof timestamp, nonce and signature.
  Following `reverse-command-v1`, durable semantic hashes are lowercase SHA-256
  over RFC 8785 bytes and exclude proof freshness (and the start ID that keys
  their row), so a committed result survives the two-minute proof window
  without treating a captured signed request as an idempotent retry. ACK
  results remain replayable with fresh proofs for 24 hours.
- Credential delivery is at least once until acknowledgement: every replay
  returns the same credential and delivery ID. A claim never mints a second
  credential because a response or acknowledgement was lost.
- Bearers use `pc1.<credential UUID>.<32-byte base64url secret>`. The normal
  database row holds a versioned HMAC verifier, not plaintext. Only an
  AES-256-GCM sealed pending-delivery row is recoverable, and it is erased at
  acknowledgement, cancellation, denial, or expiry.
- Recovery requires the stable identity private key and an owner approval in
  the already-bound workspace. Losing both identity key and credential requires
  explicit revocation/removal and a new Peon identity.
- Rotation is proven by the active bearer and identity signature. The pending
  next credential can only acknowledge itself. After acknowledgement, the old
  credential cannot create requests or connections; already-open old sockets
  get at most five minutes and are evicted sooner when any new-generation
  control or transfer socket becomes ready.
- Revocation has no grace period and evicts both control and transfer sockets.
- Existing Overseer-driven `/api/v1/enroll` remains legacy-only during the
  mixed-version window. Capability probing may downgrade only on explicit
  unsupported responses before a claim exists. Network/TLS/timeout/`5xx`/`429`
  failures never downgrade. Peon and Overseer both hold an enrollment-method
  lock so one attempt cannot mint identities through both paths.
- Poll/cancel/ACK may perform only the enumerated read-only authentication
  lookup needed to recover a public key, claim nonce and verifier. Delivery
  ciphertext cannot be read or decrypted and no state can mutate until
  timestamp and Ed25519 proof verification succeed.
- Cancel removes its verifier atomically. Its first response can report
  `cancelled`, or observe a not-yet-observed `denied`/`expired` terminal state;
  no authenticated repeat is promised after cleanup.
- Same-attempt start replay returns the sealed original operator code only while
  the claim remains pending. Claim/delivery expiry, 24-hour terminal-metadata
  pruning, and the seven-day tombstone have explicit code-free results; an
  attempt admitted after tombstone removal creates a wholly new claim/code.
- A persisted candidate bearer is the ACK-versus-cancel reconciliation
  authority: fresh ACK returns completion when ACK won and
  `CREDENTIAL_REVOKED` when cancel/expiry won, including after lost responses
  and restart.
- Delivery sealing uses AES-256-GCM with a 96-bit CSPRNG nonce and a uniqueness
  constraint on `(deliveryKeyVersion, nonce)`; retries reuse the stored sealed
  tuple and never re-encrypt.
- Credential and Peon-wide revocation are workspace-owner-only. Cookie
  mutations require the exact trusted Origin, native device bearer calls are
  CSRF-exempt, unknown/cross-workspace targets are concealed before role
  evaluation, and authorized/forbidden requests have frozen transactional audit
  outcomes. Authentication, CSRF and target-concealment failures create no
  business audit record.

## Implementation boundary

OVSR-210 owns only the frozen contract, byte-identical artifacts and reusable
conformance cells. OVSR-145 and OVSR-147 implement the Peon and Overseer sides;
both implementations have completed approved code review against this contract.
That review does not move service code, credential tables, socket
authentication, operator routes, daemon settings or rollout ownership into
OVSR-210.

The reusable harness now treats the 59 golden security outcomes,
mixed-version/no-downgrade decisions and named restart/fault boundaries as a
covered contract cell. Real-machine NAT/TLS enrollment, production-like
mixed-fleet soak and retirement of legacy enrollment remain explicit blocked
operational checks rather than being implied by a green contract suite.

Legacy removal remains OVSR-211 and only follows the published mixed-version
production window. No production deployment is part of OVSR-210.
