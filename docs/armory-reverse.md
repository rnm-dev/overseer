# Armory over Fleet HTTP

Armory request/response traffic has one authority: Overseer calls Peon's
authenticated Fleet HTTP API directly through the configured external endpoint. Public browser/mobile
routes, workspace membership checks and Peon ACLs are unchanged. There is no
capability selector, reverse-command path, legacy fallback or retry onto a
second transport.

## Routes

Overseer preserves `/api/workspaces/:wsId/peons/:peonId/armory/*` and maps it
one-for-one onto these Peon Fleet routes:

- `GET /api/v1/armory/packages?q=&installed=&limit=&cursor=`
- `GET /api/v1/armory/settings`
- `GET /api/v1/armory/packages/:id`
- `GET /api/v1/armory/packages/:id/configuration`
- `GET /api/v1/armory/packages/:id/mcp`
- `GET /api/v1/armory/operations/:operationId`
- `POST /api/v1/armory/refresh`
- `POST /api/v1/armory/packages/:id/install`
- `POST /api/v1/armory/packages/:id/update`
- `POST /api/v1/armory/packages/:id/enable`
- `POST /api/v1/armory/packages/:id/disable`
- `PUT /api/v1/armory/packages/:id/configuration`
- `POST /api/v1/armory/packages/:id/configuration/verify`
- `DELETE /api/v1/armory/packages/:id/configuration`
- `DELETE /api/v1/armory/packages/:id`

Every request carries the server-derived `Peon-Actor`; Fleet authentication
uses the Peon's enrolled credential. HTTP retries retain `Peon-Request-Id`.
Peon's durable operation IDs and operation store remain the authority for
long-running work and restart recovery.

## Preserved safety

Inventory stays cursor-bounded and capped at 100 packages. Package,
configuration, MCP and operation responses retain their existing bounded safe
representations. Configuration reads expose schemas and configured booleans,
never stored values. Overseer still strips unsafe configuration failures and
free-form configure diagnostics before returning them to a client.

Package locks, transactional staging, dependency checks, hooks, rollback,
runtime drain/reconcile, durable operation state and interrupted-operation
recovery remain inside Peon. Moving transport does not move those authorities.
Stable Peon HTTP status/code pairs pass through the existing relay.

Armory has no realtime WebSocket projection or event in the current UI. The UI
refreshes authoritative HTTP reads and polls durable operations. If a future
invalidation event is added, it may trigger an HTTP refetch but must not carry
an authoritative Armory result or mutation.

## Removed reverse operations

`armory.inventory`, `armory.settings`, `armory.package`,
`armory.configuration`, `armory.mcp`, `armory.operation`, `armory.refresh`,
`armory.install`, `armory.update`, `armory.enable`, `armory.disable`,
`armory.configure`, `armory.verify`, `armory.configuration.delete`, and
`armory.uninstall` are not `reverse-command-v1` operations and are not
advertised, accepted, persisted or measured by the command gateway.
