# Armory over Fleet HTTP

Armory request/response traffic has one authority: Overseer calls Peon's
authenticated Fleet HTTP API directly through mesh. Public browser/mobile
routes, workspace membership checks and Peon ACLs are unchanged. There is no
reverse-command path, transport selector, legacy fallback or retry onto a
second transport. The new profile/assignment resource family is gated by the
exact `armory-project-packages-v1` capability; absence means upgrade required,
not a fallback onto global activation. Its canonical model is [Armory project
packages](armory-project-packages.md).

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
- `PUT /api/v1/armory/packages/:id/configuration`
- `POST /api/v1/armory/packages/:id/configuration/verify`
- `DELETE /api/v1/armory/packages/:id/configuration`
- `DELETE /api/v1/armory/packages/:id`

After `armory-project-packages-v1` is advertised, Peon additionally owns:

- `GET|POST /api/v1/armory/profiles`
- `PATCH|DELETE /api/v1/armory/profiles/:profileId`
- `PUT /api/v1/armory/profiles/:profileId/configuration`
- `POST /api/v1/armory/profiles/:profileId/verify`
- `GET /api/v1/armory/projects/:projectId/assignments`
- `PUT|DELETE /api/v1/armory/projects/:projectId/assignments/:packageId`

The authenticated public counterparts remain under the workspace and Peon
scope:

- `GET|POST .../armory/profiles`
- `PATCH|DELETE .../armory/profiles/:profileId`
- `PUT .../armory/profiles/:profileId/configuration`
- `POST .../armory/profiles/:profileId/verify`
- `GET .../armory/projects/:projectId/assignments`
- `PUT|DELETE .../armory/projects/:projectId/assignments/:packageId`

Overseer validates lowercase UUID profile/project IDs, package and field IDs,
strict bounded bodies, and the 100-record list limits before or after the Fleet
call as appropriate. Project assignment routes additionally enforce the
caller's immutable-project grant; inaccessible projects use the existing
`404 UNKNOWN_PROJECT` concealment before Peon is contacted. Successful results
are rebuilt from the contract's safe fields, so an unexpected `values` or
diagnostics member cannot cross the public boundary.

The old `POST .../enable` and `POST .../disable` routes belong only to legacy
Peons. For a Peon advertising the new capability, Overseer returns bounded `410
ARMORY_ACTIVATION_RETIRED` without contacting Peon; Peon independently provides
the same side-effect-free response at its Fleet boundary. Legacy configuration
routes may temporarily address the migrated profile created from that
package's old configuration; they are aliases, not another store.

Every request carries the server-derived `Peon-Actor`; Fleet authentication
uses the Peon's enrolled credential. Typed-profile and assignment mutations
forward the caller's stable `Peon-Request-Id`; when one is absent the existing
Fleet client generates one, without adding another idempotency ledger. Peon's
durable operation IDs and operation store remain the authority for profile
configure/verify polling, long-running work and restart recovery.

## Preserved safety

Inventory stays cursor-bounded and capped at 100 packages. Package,
configuration, MCP and operation responses retain their existing bounded safe
representations. Configuration reads expose schemas and configured booleans,
never stored values. Overseer still strips unsafe configuration failures and
free-form configure diagnostics before returning them to a client. The typed
profile boundary also normalizes configuration/verification errors and
operation results to allowlisted codes and safe fields. Submitted profile
values exist only in the authenticated configure request body while it is
relayed; Overseer does not store, cache, project, log or return them.

Package locks, transactional staging, dependency checks, hooks, rollback,
profile/assignment revisions, runtime drain/reconcile, durable operation state
and interrupted-operation recovery remain inside Peon. Moving transport does
not move those authorities. Stable Peon HTTP status/code pairs pass through the
existing relay. Configuration values flow only on writes and are never stored
or logged by Overseer.

The committed activation record is the authority for whether a package is
installed; `installed.json` is a rebuildable query projection. After operation
recovery and before migration/runtime startup, Peon restores missing projection
rows from valid activations and removes projection-only rows plus their stale
project assignments. Profiles and credentials are preserved. Inventory safe
view resolution is isolated per package, so a missing or unreadable package can
degrade its own card but cannot reject the rest of the catalog.

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
