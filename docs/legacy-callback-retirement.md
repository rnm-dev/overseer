# Legacy callback retirement gate

OVSR-211 is **blocked** as of 2026-07-30. This is a dependency decision, not a
statement that the reverse transport is broken. Final deletion is destructive
and may begin only after all of the following evidence exists:

| Gate | Required evidence | Audit result |
| --- | --- | --- |
| OVSR-152 | Heroboard status is Released, with its acceptance evidence | Blocked: In Progress |
| Security clearance | OVSR-150 Released, no unresolved critical/high cutover finding, approved public-boundary suite | Blocked: OVSR-150 In Progress |
| Conformance clearance | OVSR-151 Released, complete supported-version matrix and all operation-family NAT/fault cells green | Blocked: OVSR-151 In Progress |
| Production no-inbound soak | Dated production cohort, duration, blocked Peon ingress, operation-family coverage, telemetry result | Missing |
| Rollback exercise | Dated production-like exercise showing fallback and accepted-command reconciliation without duplicate effects | Missing |
| Mixed-version support window | Published start/end, supported versions and operator migration notice | Missing |
| Window completion | Audit date is on or after the published end | Cannot start until the window is published |
| Post-window telemetry | Dated zero callback selections and attempts for every supported version and operation family | Missing |

The executable record is
`packages/protocol-conformance/fixtures/legacy-callback-retirement-gate-v1.json`.
Its conformance test fails if the decision is changed to `ready` without
evidence for every gate, with invalid window dates, or before the support-window
end. While blocked, it also protects representative compatibility anchors,
legacy schema declarations and local dashboard/CLI control anchors from
accidental deletion.

## Removal inventory

The final change must treat these as one coordinated compatibility boundary:

- Overseer routing and dialing: `peonClient.ts`, `transportSelection.ts`,
  registry `baseUrl`/`legacyCallbackUrl`, callback-attempt telemetry and all
  `callPeon`/proxy/SSE fallback branches inventoried in
  [remaining Peon HTTP control plane](remaining-peon-http-control-plane.md).
- Overseer recruitment and presence: operator-driven `/enroll`, Peon
  `/register` and `/heartbeat`, callback URL synthesis, health probes and
  reconciliation.
- Stored compatibility state: legacy `pn_` credential material, Peon callback
  address/port/public URL, pinned-address metadata and the migrations that
  created them. Historical migrations must not simply be edited; cleanup needs
  a new reversible migration and a verified retained backup.
- Peon compatibility: inbound fleet bearer middleware/routes, legacy
  `/api/v1/enroll`, `peonRegistrar` registration/heartbeat, retired callback mode,
  remote-listener settings, callback credential fields and obsolete dashboard
  status/actions.
- Configuration and documentation:
  `OVERSEER_PEON_CALLBACK_URL`, `OVERSEER_REVERSE_ROUTING`,
  `OVERSEER_LEGACY_CALLBACK_FALLBACK`, deployment secrets/config, protocol
  compatibility text, installation, recovery and troubleshooting guidance.

Local dashboard, CLI and MCP HTTP on loopback are explicitly outside removal
scope.

## Migration and rollback checklist

Before code or schema deletion:

1. Freeze the supported Peon/Overseer version matrix at the published window
   end and prove every supported operation selects reverse transport.
2. Export aggregate production callback selection/attempt counts by safe
   capability and version labels; retain the dated query and result.
3. Re-run NAT/no-inbound conformance across commands, transcripts, projections,
   transfers, enrollment, reconnect and restart boundaries.
4. Take and verify a restorable database backup; inventory rows containing
   callback addresses and legacy credentials without exporting their secrets.
5. Exercise application and data rollback on a production-like copy. Prove
   accepted command reconciliation does not duplicate effects.
6. Land code removal before destructive data cleanup. Observe one release with
   legacy columns retained but unused, then use a new migration to remove them.
7. Preserve the prior application image and compatible schema restore path for
   the documented rollback interval.

The exact unblock condition is: OVSR-152 is Released; dated production
no-inbound soak and rollback evidence are attached; OVSR-150 and OVSR-151 are
Released with their full security and conformance acceptance evidence; the
public mixed-version window has a start and end; that end has passed; and
post-window telemetry shows zero callback selection/attempts for every
supported version and operation family. The current rollout evidence and
explicitly unfinished cells are recorded in
[reverse-only rollout](reverse-rollout.md),
[reverse fleet security](reverse-fleet-security.md), and the
[protocol conformance harness](protocol-conformance-harness.md).
