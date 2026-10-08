# Session pins

Operators can pin sessions using the session row's context menu. Pinned rows show only a
tiny muted pin beside the title; there is no separate row button.
Pins belong to the signed-in operator within a workspace, not to the whole
workspace. They persist across browsers and reloads in Overseer's database.

Pinned sessions sort before ordinary sessions in flat lists. Grouped Peon
sidebars show a separate pinned section above projects. The pins endpoint
returns the accessible indexed session rows, so older pinned sessions remain
visible even when they are outside the loaded history page. Current live rows
win over pin-fetch metadata. Project cards include that project's pins.

Authenticated workspace routes:

- `GET /workspaces/:wsId/session-pins` returns `{ sessions }` for the caller.
- `PUT /workspaces/:wsId/session-pins/:peonId/:sid` pins a session.
- `DELETE /workspaces/:wsId/session-pins/:peonId/:sid` unpins it.

Every read and mutation checks current indexed-session access, including Peon
and project grants. No client-supplied user identity is accepted. Guest session
credentials cannot change workspace preferences. Pin/unpin is idempotent;
a transactional advisory lock enforces 50 pins per operator per workspace.
Ordinary session deletion clears pins for every operator.

Web mutations update local ordering after backend acceptance and refresh other
mounted lists. Window focus reloads preferences changed elsewhere. Pin state
is kept separately from canonical session projections, so live session updates
do not erase it. Requests from an old workspace are ignored.

Migration 046 creates `session_pins` and removes the mistakenly introduced
message-pin table. Migration 045 is retained for forward migration compatibility;
the message-pin UI and routes are removed. Peon changes are not required.
