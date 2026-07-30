# Reverse-only rollout controls and gates

OVSR-152 is a staged production cutover, not permission to remove compatibility
routing. This document records the safe local controls and the evidence still
required before any default changes. The operation contracts remain in their
capability-specific documents; this page only governs selection and rollout.

## Controls

`apps/server/src/modules/transportSelection.ts` chooses exactly one handler
before execution. A selected reverse handler never evaluates or retries the
legacy handler. The global emergency switches remain:

- `OVERSEER_REVERSE_ROUTING=0` selects legacy routing where compatibility is
  available;
- `OVERSEER_LEGACY_CALLBACK_FALLBACK=0` refuses an operation instead of dialing
  a legacy Peon. This must remain unset during the mixed-version support window.

Capability rollout configuration is optional. When absent, it preserves the
existing capability-negotiated behavior. Its format is a comma-separated list:

```text
OVERSEER_REVERSE_CAPABILITY_ROLLOUT=reverse-command-v1:allowlist:2.4.0,folder-listing-v1:cohort:2.3.0:5
OVERSEER_REVERSE_ALLOWLIST_REVERSE_COMMAND_V1=peon-id-1;peon-id-2
```

Each entry is `capability:stage[:minimum-version][:cohort-percent]`. Stages are
`off`, `allowlist`, `cohort`, and `default`. Invalid entries fail closed for the
named capability. Minimum versions use three numeric components. Cohorts are a
stable percentage assignment based on capability and Peon ID; Peon IDs are not
emitted as telemetry labels. The global routing switch is the kill switch for
all families; changing a family to `off` is its independent kill switch.

The selector is a seam, not proof that every route uses it. Before a capability
enters a canary, its production call sites must be audited or mechanically
tested to show that all operations enter this selector and that no route has a
second fallback after reverse admission.

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
until terminal. Rollback changes future selection only.

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

## Current blocked acceptance evidence

As of 2026-07-30, `docs/reverse-fleet-security.md` does not approve cutover and
`docs/protocol-conformance-harness.md` lists rollout, full reverse-command,
claim, transcript and write extension cells as unfinished. The selector is not
yet wired through all production call sites. Therefore no production cohort,
callback-default change, support-window start, Tailscale removal, deployment,
or completion claim is authorized.
