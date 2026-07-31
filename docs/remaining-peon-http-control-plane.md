# Remaining Peon HTTP control plane

This inventory was refreshed for OVSR-292 on 2026-07-31.

## Transport ownership

Direct authenticated Fleet HTTP over mesh is the sole authority for:

- owner-only Peon daemon settings reads and revision-fenced mutations;
- bounded Armory inventory/settings/package/configuration/MCP/operation reads
  and refresh/install/update/enable/disable/configure/verify/configuration
  deletion/uninstall mutations;
- bounded runtime request/response reads: status/load, models/reasoning
  efforts, provider quota/capabilities, fixed-period stats and filtered
  analytics;
- session start, detail, history, follow-up, queue, cancel and selected
  lifecycle operations documented elsewhere;
- filesystem and project directory listings;
- project catalog/detail/settings/documentation/skills/quick links and lifecycle
  mutations (the `project-catalog-v1` socket remains realtime-only);
- sandbox/project file metadata, bodies, Range/download and uploads;
- project file move/delete mutations;
- session artifact metadata, raw/download, preview handoff and watch SSE;
- authenticated update check/apply/status, release metadata and release archive
  bytes.

The control WebSocket remains for projections and realtime
invalidation/events. Update-state notification may remain an event, but check,
apply and status always use Fleet HTTP. Neither update requests nor bytes enter
the reverse-command ledger.

## Removed byte plane

OVSR-292 removed the second transfer WebSocket, its upgrade endpoint,
connection registry, capability negotiation, selectors, coordinators,
generation lifecycle, frames and conformance fixtures. The retired capability
names are not advertised or accepted. There is no selected-socket fallback:
production routes issue exactly one Fleet HTTP request.

## Preserved boundaries

Overseer authenticates and authorizes the public browser/mobile request and
derives `Peon-Actor`. Peon remains authoritative for path/session/project
validation, containment, filesystem permissions, size/checksum limits,
temporary-file cleanup, atomic commit and mutation result.

HTTP streaming preserves backpressure, abort cancellation, Range and download
headers. Update archives retain authenticated release authorization, immutable
version/revision/SHA-256 binding, declared size verification, transactional
install, restart attestation, rollback archive and restart recovery.

## Production call-site rule

Calls to `proxyGet`, `proxyStream`, `proxyUpload`, `proxyFileDownload`,
`proxyFileUpload` and `callPeon` for the file/session-artifact surfaces above
are intentional Fleet HTTP paths. No production source may import a transfer
connection/socket/coordinator or mention the retired capability names.
