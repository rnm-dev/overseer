# Peon settings

Peon detail exposes owner-only General, Agent, and Armory settings.

## General

General loads the Peon's proxied `/settings` and `/status` responses after the
cached fleet identity has rendered. It provides:

- Peon self-update status, manual update checks, installation, and restart
  polling;
- the Overseer-side callback address, editable while the Peon is
  offline;
- Peon name, file-transfer root, and heartbeat interval;
- owner-confirmed Peon removal.

Connection edits use `PATCH /workspaces/:workspaceId/peons/:peonId` and update
the Overseer registry rather than the Peon. The remaining fields use the
owner-only proxied `GET/PATCH .../settings` routes. Removal revokes the Peon's
workspace credential through `DELETE .../peons/:peonId`.

Registry-backed connection repair and removal stay available when remote
settings return 404 or fail to load. Nullable values from `GET /settings` stay
absent from partial PATCH payloads until the operator supplies a value, and
heartbeat input is validated against the Peon's `1000`–`60000` millisecond
contract before submission.

Update restart polling is cancelled when the Settings controller is disposed.
If the Peon does not return within the bounded polling window, the UI leaves
the restarting state and reports a recoverable connection error.

## Agent

Agent loads the Peon's `/models` catalog alongside settings and mirrors the
web client's provider-aware default selection:

- the visible model always resolves to a concrete model supported by the
  selected provider;
- `aiDefaultModel` is sent only for `claude-code`, matching the current Peon
  compatibility contract;
- Soul Markdown is read and saved through the `soul` property on
  `GET/PATCH .../settings`; an empty string clears it.

Peons that return 404 for settings render an unsupported-version state. Other
load and mutation failures stay on the current screen with retry or inline
error feedback.

The Agent section also contains the owner-only provider update panel. It uses
`GET .../ai/cli-updates` and `POST .../ai/cli-updates/:provider` exactly as
exposed by Overseer. Overseer owns route compatibility; mobile does not probe
alternate Peon endpoints.
Codex and Claude Code status snapshots are cached per Overseer connection,
workspace, and Peon. Cached versions remain visible offline, while refresh and
update actions are disabled. Active updates poll the list every two seconds.
A final 404 is rendered as an unsupported-version state; other
errors retain cached values and expose retry feedback.

## Armory

Armory provides the package lifecycle:

- cached-first paginated inventory from `GET .../armory/packages`, using the
  server's opaque cursor until the complete catalog is loaded;
- catalog refresh through `POST .../armory/refresh`;
- install, update, uninstall, enable, and disable through the corresponding
  package routes;
- operation progress through `GET .../armory/operations/:operationId`.

Inventory snapshots are stored in the connection-scoped Drift database and
render while offline. Registry source, cached/unavailable catalog state, and
non-default registry use remain visible. Mutations are disabled offline and
while another lifecycle operation is active. Every mutation requires a mobile
confirmation sheet. Uninstall confirmation preserves the server contract:
the package runtime is removed, while credentials, managed home,
configuration, and ownership metadata remain.

Enable stays unavailable until the package reports verified or non-required
configuration. A 404 renders an unsupported-version state; transport and
registry failures retain cached inventory with retry controls.

Armory does not manage package configuration, credentials, host-write deletion,
or MCP tool discovery. Project and session file browsing remains read-only.
