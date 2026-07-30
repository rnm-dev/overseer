# Armory over the reverse command gateway

Armory fleet traffic uses `reverse-command-v1` when the Peon advertises the
individual `armory.*` operation. The operator routes choose exactly one path:
the reverse gateway for a negotiated operation, otherwise the legacy Peon HTTP
API. A failure after reverse selection is never retried over HTTP.

## Operations

The bounded read operations are `armory.inventory`, `armory.settings`,
`armory.package`, `armory.configuration`, `armory.mcp`, and
`armory.operation`. Lifecycle operations are `armory.refresh`,
`armory.install`, `armory.update`, `armory.enable`, `armory.disable`,
`armory.configure`, `armory.verify`, `armory.configuration.delete`, and
`armory.uninstall`.

Every request is admitted by the shared Peon reverse-command ledger before it
executes. The command ID and canonical request hash therefore deduplicate
install, update, configuration, hooks, and uninstall across retries, socket
replacement, and Overseer restart. Package-level coordination remains inside
Armory, preserving its lock, transactional staging, dependency, rollback, and
restart-recovery rules.

## Safety and bounds

Control frames contain metadata only. Package archives continue to be fetched
by the Peon from its authenticated catalog selection; archive bytes never enter
the control socket. Results are capped at 48 KiB. Inventory requests are capped
at 100 packages. Operation results expose only ID, package ID, kind, status,
phase, percentage, timestamps, and a stable error code. Free-form operation and
hook messages are replaced with an empty string.

Targets fail closed by operation: package operations accept exactly one
`packageId`, operation polling accepts exactly one `operationId`, and
fleet-wide inventory, settings and refresh accept neither. Stored or overridden
registry URLs cross the socket only when they are credential-free HTTPS URLs.

Configuration values are accepted only in the command request needed to
perform `armory.configure`; they are never copied into the result, durable
projection, audit view, or browser event. Configuration reads expose schema and
configured booleans, not stored values. The shared result allowlist rejects
messages and oversized terminal detail before Overseer commits or publishes it.

Long-running Armory work returns its stable operation ID. The existing Armory
operation store remains authoritative and survives Peon restarts; callers poll
`armory.operation` with that ID. If transport drops after admission, the shared
gateway reconciles the same command ID and replays its terminal result.
