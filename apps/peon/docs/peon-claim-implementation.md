# Peon claim implementation

The Peon half of `peon-claim-v1` lives in `src/daemon/enrollment/`. The frozen
wire and security rules remain in [Peon claim protocol v1](peon-claim-protocol-v1.md);
runtime code must consume that contract without redefining it.

## Durable boundaries

- `identity-ed25519-v1.jwk` holds the stable Peon UUID and Ed25519 private JWK.
  Its containing directory is repaired to mode `0700` and the fallback file is
  mode `0600`.
- `enrollment-v1.json` holds the selected enrollment method, semantic request
  bodies and lowercase SHA-256 hashes, claim authentication material, pending
  credential delivery, rotation state, and safe active-credential metadata.
  Writes use an exclusive temporary file, file `fsync`, atomic rename, parent
  directory `fsync`, and mode `0600`; existing state directories are repaired
  to `0700`.
- Active settings use the same crash-durable rename sequence. Candidate cleanup
  happens only after settings containing the bearer return from file and
  directory `fsync`. A crash after that commit but before candidate cleanup
  replays the same ACK and converges without losing the only recoverable bearer.
- Signed proofs are never persisted. Every start, poll, cancel, ACK, rotation,
  retry, and restart creates a fresh timestamp, request nonce, and Ed25519
  signature over the frozen binding.
- A delivered bearer is persisted before ACK. It remains a `pending` candidate
  until a stable ACK completion or authenticated control-socket `hello_ack`
  proves activation.

## Lifecycle

Peon probes capability support before selecting its durable method lock. Only
an explicit `404` or `UNSUPPORTED_CAPABILITY` may select legacy enrollment;
redirects, TLS/network failures, `429`, and `5xx` remain claim failures. Once a
claim exists, the legacy `/enroll` route is locked.

Claim polling uses the server-provided two-second cadence plus bounded jitter.
Every poll/completion claim ID, rotation delivery/completion ID, bearer
credential ID, and locally knowable generation transition is checked before
durable mutation. Runtime errors use only the frozen code enum, and display
names are truncated to 120 Unicode scalar values.
Terminal denial, cancellation, and expiry erase local claim secrets. Ambiguous
cancel and ACK outcomes retain a persisted candidate and reconcile with the
same semantic ACK carrying a fresh proof. `CREDENTIAL_REVOKED` deletes the
candidate; `CLAIM_NOT_FOUND` after ACK-result retention opens only the normal
control socket with the candidate, and a matching authenticated `hello_ack`
promotes it.

A local cancel never abandons a known server claim merely because the client is
parked after a protocol error: when claim authentication material exists it
sends the signed cancel first. If a pending claim has no delivered candidate,
a lost cancel response followed by the contract's generic post-cleanup
`401 UNAUTHENTICATED` converges to local cancellation. The same response remains
ambiguous when a candidate exists, so that path keeps the candidate and
reconciles through fresh ACK as above.

Rotation persists one next-generation candidate and acknowledges with that
candidate. Promotion updates settings once, causing both control and transfer
socket supervisors to replace their credential generation; their existing
socket-generation checks fence delayed callbacks from the retired sockets.
Explicit `CREDENTIAL_REVOKED` or `CREDENTIAL_INVALID` responses clear only the
credential that was actually rejected.

Transport failures, `5xx`, `429`, `PERSIST_FAILED`, and the contract-required
fresh-proof `CLOCK_SKEW` correction are retryable. Other non-terminal stable
protocol failures enter `parked` with no timer. After the underlying condition
is corrected, an operator resumes explicitly with `peon pair --retry` or the
local dashboard's retry action.

## Secret and encryption boundary

Overseer owns AES-256-GCM sealing of pending delivery rows. Peon never receives
the delivery key, nonce, ciphertext, verifier, or tag: after an authenticated
poll it receives the one plaintext bearer in bounded response memory and writes
it to its private local candidate store before ACK. Routine status, dashboard
responses, and logs expose IDs, generation, state, and stable error codes only;
they never expose claim tokens, signatures, private keys, or bearers. Registrar
error reads stop at 16 KiB and retain only the three stable credential verdicts;
server-supplied bodies and messages never enter state or logs.

## Verification

`src/daemon/__tests__/peonClaimProtocolContract.test.ts` executes the canonical
frames, cryptographic vectors, AES-GCM storage vector, semantic hashes, lookup
policy, and all golden security outcomes independently of runtime services.
`peonClaimClient.test.ts`, `pairingEnrollment.test.ts`, and
`peonCredentialSocketGeneration.test.ts` cover Peon persistence, restarts,
fresh-proof retries, cancel/ACK reconciliation, method locking, revocation, and
two-channel generation replacement. `peonRegistrarSecurity.test.ts` covers
bounded and allowlisted north-bound credential errors.
