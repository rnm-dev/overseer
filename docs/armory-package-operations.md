# Armory package runtime operations

Peon advertises `armory-package-operations-v1` only when every endpoint on this
page is available. Overseer proxies them over authenticated Fleet HTTP; they do
not use reverse commands or introduce another socket.

## Compatibility preflight

`GET /api/v1/armory/packages/:packageId/preflight?version=<semver>` is a
side-effect-free catalog check. It checks catalog and version presence,
OS/architecture, minimum Peon version and the archive-size bound. It does not
download or execute package code. The bounded response contains only
`{ packageId, version, compatible, checks }`; each check is
`{ id, status, code }`.

## Diagnose

`POST /api/v1/armory/packages/:packageId/diagnose` performs an installed
manifest and MCP handshake self-test. Optional `{ projectId }` selects and
validates that project's typed profile first. Responses contain stable check
codes, never hook output, stderr, arguments or profile values.

## Usage

`GET /api/v1/armory/packages/:packageId/usage` returns process-lifetime,
package-level aggregates: calls, failures, timeouts, total duration, current
calls, active turn leases, running runtimes, last use and `resetAt`. Counters are
not split by tool or profile and retain no inputs or results. They reset when
Peon restarts and are operational telemetry, not billing data.

## Drain, restart and project reload

These mutations are durable operations under the existing per-package lock:

- `POST /api/v1/armory/packages/:packageId/drain`
- `POST /api/v1/armory/packages/:packageId/restart`
- `POST /api/v1/armory/projects/:projectId/assignments/:packageId/reload`

`GET /api/v1/armory/packages/:packageId/drain` reports `accepting` or
`draining`, active calls and active leases.

Drain first refuses new turn bindings, then waits for immutable in-flight turn
leases and their calls. It uses the same bounded timeout as update and uninstall.
A completed drain closes children and removes their isolated runtime homes;
later turns may start the selected package lazily.

Restart additionally performs a clean handshake for credential-free packages.
Profile-backed packages stay lazy, so Peon never guesses a global credential.
Project reload validates the assignment, drains the package, and makes the next
project turn resolve a fresh artifact/profile selection.
