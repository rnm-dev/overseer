# Reverse runtime capabilities

`runtime-state-v1` is the realtime runtime projection. Bounded request/response
runtime reads use authenticated Fleet HTTP over mesh.

## `runtime-state-v1`

The Peon publishes one complete, replaceable `runtime_state` document through
the shared durable outbox. It has an independent process epoch, monotonic
revision and SHA-256 digest. A new process epoch is authoritative after a
restart or update. Unsent state may be coalesced under the `runtime-state`
coalesce key; an already assigned durable cursor is immutable.

The projection contains only paused state and active/total capacity, daemon
version/revision, provider availability and public capabilities, supported
models/reasoning modes, and freshness metadata. It excludes paths, environment,
credentials, provider authentication replies and unrestricted metrics.
Overseer commits state and the shared durable inbox cursor together before
acknowledging it. Projection consumers report `fresh`, `stale`, or `offline`.
Heartbeat and runtime invalidation/events remain on the control WebSocket.
HTTP query responses are never fed back into this projection.

## Bounded runtime queries

Every operator-triggered runtime query uses exactly one authenticated Peon
Fleet HTTP request through mesh:

- `GET /api/v1/status`;
- `GET /api/v1/models`;
- `GET /api/v1/quota/:provider?refresh=1`;
- `GET /api/v1/capabilities/:provider?refresh=1`;
- `GET /api/v1/stats?period=day|yesterday|week|month`;
- `GET /api/v1/analytics` with the existing bounded filters and cursors.

Overseer still owns browser/mobile authentication, workspace ACL and owner-only
analytics/quota authorization, and forwards the canonical `Peon-Actor`. Peon
keeps provider validation, period/filter/cursor bounds, result redaction and
stable Fleet error envelopes. There is no reverse-command fallback or runtime
query ledger.

Status/capacity/load, daemon revision, provider availability/public
capabilities and models/reasoning efforts continue to be published in
`runtime-state-v1` for fleet-wide realtime views. An explicit public API read,
however, is an HTTP query and never treats the projection as its request
response.
