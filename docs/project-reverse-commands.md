# Project Fleet HTTP control plane

Project requests and mutations have one authority: the authenticated Peon Fleet
HTTP API reached by Overseer through mesh. The public browser/mobile routes,
workspace and project ACL checks, and response shapes are unchanged.

Overseer resolves a mutable public project key to the catalog's immutable
`projectId`, then uses `/api/v1/projects/by-id/:projectId` for detail, settings,
documentation, skills, quick links, update and delete. Creation and directory
suggestion remain collection routes. Mutations carry `Peon-Request-Id`; updates,
quick-link mutations and delete first read the current settings digest and send
it as `Peon-Project-Digest`. Peon rejects a stale or missing digest with
`409 PROJECT_CONFLICT`.

Fleet routes:

- `GET|POST /api/v1/projects`
- `GET /api/v1/projects/suggest-dir`
- `GET /api/v1/projects/by-id/:projectId`
- `GET|PATCH /api/v1/projects/by-id/:projectId/settings`
- `GET /api/v1/projects/by-id/:projectId/docs` and `/docs/*`
- `GET /api/v1/projects/by-id/:projectId/skills`
- `GET|POST /api/v1/projects/by-id/:projectId/quick-links`
- `PATCH|DELETE /api/v1/projects/by-id/:projectId/quick-links/:linkId`
- `DELETE /api/v1/projects/by-id/:projectId`

Delete unregisters the project only. It never removes the project directory or
files, refuses with `409 PROJECT_RUNNING` while a project session runs, and
leaves historical sessions unchanged. After success Overseer immediately calls
`forgetIndexedProject`; the later catalog event is an idempotent invalidation.

`project-catalog-v1` deliberately remains on the authenticated control
WebSocket. Its snapshot/delta/outbox/ACK path feeds realtime projection,
browser events and cache invalidation, but is never request or mutation
authority. There are no `project.*` operations in `reverse-command-v1`, no
transport selector, and no legacy fallback.
