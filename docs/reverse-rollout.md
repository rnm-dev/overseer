# Reverse-control rollout controls and gates

OVSR-152 is a staged production cutover, not permission to remove compatibility
routing. This document records the safe local controls and the evidence still
required before any default changes. The operation contracts remain in their
capability-specific documents; this page only governs selection and rollout.

## Controls

`apps/server/src/modules/reverseCommands/transportSelection.ts` chooses exactly one handler
before execution. A selected reverse handler never evaluates or retries the
legacy handler. The global emergency switches remain:

- `OVERSEER_REVERSE_ROUTING=0` selects legacy routing where compatibility is
  available;
- `OVERSEER_LEGACY_CALLBACK_FALLBACK=0` refuses an operation instead of dialing
  a legacy Peon. This must remain unset during the mixed-version support window.

Capability rollout configuration is optional. When absent, it preserves the
existing capability-negotiated behavior. Its format is a comma-separated list:

```text
OVERSEER_REVERSE_CAPABILITY_ROLLOUT=reverse-command-v1:allowlist:2.4.0,runtime-state-v1:cohort:2.3.0:5
OVERSEER_REVERSE_ALLOWLIST_REVERSE_COMMAND_V1=peon-id-1;peon-id-2
```

Each entry is `capability:stage[:minimum-version][:cohort-percent]`. Stages are
`off`, `allowlist`, `cohort`, and `default`. Invalid entries fail closed for the
entire supplied policy; duplicate entries and extra fields are invalid. The
configuration is bounded to 16 KiB, 64 capability entries and 1,000 Peon IDs
per allowlist. Minimum versions use three numeric components. Cohorts are a
stable percentage assignment based on capability and Peon ID; Peon IDs are not
emitted as telemetry labels. The global routing switch is the kill switch for
all families; changing a family to `off` is its independent kill switch.

Every remaining released `reverse-command-v1` route family enters the
production selector before either handler can run. Armory does not: its
request/response traffic has one authenticated Fleet HTTP path. The authenticated control hello
carries the Peon daemon version used by minimum-version rollout rules. Route
tests and the shared transport test must continue to show that unavailable
selection evaluates no callback and that accepted command reconciliation
cannot cross into legacy HTTP.

## Safe telemetry

The selector exposes process-local aggregate counts for selected transport,
selection reason, and legacy callback attempts. Dimensions are fixed
allowlists; they contain no workspace, user, Peon, session, project, command,
path, prompt, token, payload, or error text. In particular,
`reverse-capability-authoritative` callback attempts must remain zero.

These counters are regression and exporter inputs, not durable proof. A
production dashboard still needs bounded metrics for negotiation, command
accept/result latency, replay and duplicate outcomes, cursor lag, projection
freshness, queue pressure, reconnect reason, transfer failure code, and
post-update version attestation. Every dimension must be a fixed capability,
phase, result code, or coarse version family; identifiers and content are
forbidden.

`reverseRolloutReadinessSnapshot()` is the current process-local,
machine-readable diagnostic. It combines only fixed-dimension selector,
command-lifecycle and transfer counters with a reviewed evidence record.
OVSR-151 conformance approval and its deterministic local soak are true, while
`productionEvidence`, production telemetry, production no-inbound soak,
production rollback and security approval remain false. The evaluator requires
every gate simultaneously, so `reverseOnlyDefaultAllowed` remains false. The
real command-status route is wired through accepted reverse reconciliation.
Actual operation submission marks its separate process-local wiring signal when
a shipped route enters the selector. The diagnostic is not an operator API and
contains no fleet or resource identifiers.

Its dashboard definition has five fixed panels: transport selection, callback
attempts, command lifecycle, transfer negotiation and production acceptance.
The first four consume real process counters; production acceptance remains
explicitly unavailable. Fixed-label blocker alerts cover missing production
evidence, missing security approval and unwired submission, while any callback
attempt after reverse capability becomes authoritative is critical. There are
no dynamic resource labels or raw error strings.

Transfer socket claims now contribute actual negotiated-capability and
initial/replacement connection counts. Unknown capability names collapse to
`other`; no Peon identity or handshake payload becomes a label. Control-socket
negotiation/reconnect causes, transfer failure codes, cursor lag, freshness,
queue pressure and version attestation remain absent until their owning,
currently changing call sites provide stable sources.

## Per-capability readiness record

No family advances unless one evidence bundle names the exact capability and
versions and contains:

1. unit/integration parity plus the security and conformance suites;
2. an exclusive-route assertion with zero dual execution;
3. bounded error and latency budgets agreed before the observation;
4. reconnect/restart fault results for every accepted-command boundary;
5. a production-like no-inbound soak with DNS and firewall enforcement;
6. safe telemetry showing callback attempts are zero for capable cohort members;
7. update/restart attestation and mixed-version fallback results;
8. a tested rollback using the same command ID for accepted-command
   reconciliation, with no duplicate effect.

The stages are internal allowlist, small deterministic cohort, larger cohorts,
then default. A stage pauses or rolls back on any security regression, dual
execution, unbounded queue/lag, missing attestation, unexplained callback,
error-budget breach, or latency-budget breach.

## Rollback

For a capability that has not admitted an operation, change its stage to `off`
or set the global routing switch to `0`, then restart the Overseer process and
verify selection telemetry. For an accepted reverse command, do not submit a
new legacy action: reconcile the original command ID through status/replay
until terminal. The selector models this as `acceptedReverseCommand`: it keeps
the reverse reconciliation handler authoritative even when the rollout or
global routing switch is off, and never evaluates the legacy handler. Rollback
changes future command selection only. Production proof still requires the
gateway/call sites to pass this accepted state into the selector and a fault
exercise to demonstrate one durable effect.

Keep `OVERSEER_LEGACY_CALLBACK_FALLBACK` enabled throughout rollback and the
support window. If a no-inbound Peon cannot serve legacy HTTP, the safe result
is unavailable; restoring an inbound listener is a separately authorized
operator action.

## Support window

The mixed-version support window has not started. It starts only after the
default-routing acceptance evidence above is reviewed and recorded with an
explicit start date, supported minimum versions, owner, and expiry date.
Throughout it, older Peons retain exclusive legacy routing and rollback remains
available. Operators must be given migration, credential recovery, callback
diagnostics, and version-update instructions before the date is announced.

OVSR-211 may remove callback code and recoverable legacy credentials only after
the published window expires and fleet telemetry shows no supported legacy
use. Tailscale remains part of legacy setup until the complete no-inbound soak
and security gates pass.

## Current acceptance evidence and blockers

As of 2026-07-30, OVSR-151 is independently approved at 49/49 conformance tests,
75/75 focused real-Peon tests and a deterministic 60,000-tick local soak. The
reviewed soak artifact explicitly says `productionEvidence: false`; it is local
fault/load evidence, not a production observation.

`docs/reverse-fleet-security.md` does not approve cutover, and production
telemetry, the sustained no-inbound soak and the accepted-command rollback
exercise have not been recorded. Therefore no production cohort,
callback-default change, support-window start, Tailscale removal, deployment,
or completion claim is authorized.
