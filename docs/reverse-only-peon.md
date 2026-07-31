# Peon reverse-only fleet mode

OVSR-148 adds an explicit, opt-in `fleetMode` setting. It does **not** change
the production default and it does not authorize the reverse-control cutover.

## Modes

- `legacy-mesh` is the migration default for settings files which predate the
  field. Reverse capabilities are preferred where negotiated, while the
  inbound bearer Fleet HTTP API and legacy registration/heartbeat remain
  available as compatibility paths.
- `reverse-only` binds the daemon and dashboard to loopback, rejects every
  inbound Fleet HTTP/enrollment request with `409 REVERSE_ONLY`, and does not
  publish a callback URL or run the legacy registration/heartbeat loop. Local
  dashboard, CLI, MCP and human HTTP routes remain available.

Select a mode locally:

```sh
peon fleet mode reverse-only
peon restart
```

To expose the legacy listener again, first select compatibility mode:

```sh
peon fleet mode legacy-mesh
peon remote on peon.example.mesh
```

`ACA_BIND_HOST` cannot override the safety boundary: daemon and dashboard
startup fail with a bounded diagnostic if reverse-only is combined with a
non-loopback host. Release lookup/download, claim polling, credential rotation
and the control/realtime socket remains a Peon-initiated HTTPS/WSS flow.

## Capability gate and current blockers

Reverse-only is an installation/topology switch, not proof of operation parity.
Each operator operation still selects exactly one negotiated reverse
capability; it must never retry through HTTP after selecting the socket path.
Before enabling the mode for a real Fleet, the required capability families
for that Peon must have passed their operation tests and the NAT/no-inbound
conformance cell.

Available reverse families include socket presence, session/project catalogs,
transcript sync, project/sandbox body reads, file writes, daemon and
runtime projections/queries, reverse commands, Armory/update handlers and base
session artifacts. The exact accepted set remains connection-generation
specific.

The complete cutover remains blocked on the unfinished residual families and
gates recorded in [remaining Peon HTTP control plane](remaining-peon-http-control-plane.md):
session lifecycle/queue parity, remaining project/file operations and legacy
reads, enrollment rollout, security review, full command/transcript/transfer
fault injection, and the OVSR-152 no-inbound soak. Therefore:

- do not make `reverse-only` the default;
- do not disable Overseer compatibility routing for mixed-version Peons;
- do not call a green Peon unit/integration run production-cutover approval;
- do not delete callback fields or legacy routes before the published support
  window completes.

The tests in
`apps/peon/src/daemon/__tests__/reverseOnlyFleetMode.test.ts` cover safe
migration, loopback enforcement, explicit compatibility recovery and proof
that reverse-only starts no legacy callback registration/heartbeat. Root
protocol conformance remains the owner of the cross-process NAT assertion and
the deliberately blocked operation-family cells.
