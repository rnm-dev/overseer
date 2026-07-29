# Operator presence

The shared workspace WebSocket receives an ephemeral presence snapshot and
subsequent `presence` frames. Presence stays in memory and is never written to
the offline database.

## Location lifecycle

Each workspace connection starts at `workspace` scope. Navigation changes the
location sent with `presence:set`:

- Opening a Peon changes that workspace to `peon` scope.
- Opening a session changes it to `session` scope.
- Returning from a session restores `peon` scope.
- Returning from the Peon screen restores `workspace` scope.

The desired location stays attached to the workspace socket and is sent again
after reconnecting or after the server requests a presence retry. Ordinary
socket pings keep the server-side presence entry alive.

## Viewer projections

The UI deduplicates viewers by case-insensitive email and sorts them by GitHub
login, falling back to email:

- Fleet Peon rows show all viewers whose entry belongs to that Peon, including
  viewers inside one of its sessions.
- Session rows show only viewers in that exact session.
- The floating overlay at the transcript's upper-right corner shows only
  viewers in that exact session.

All three surfaces use the shared compact avatar stack: at most three avatars,
then a `+N` overflow badge. Avatars overlap by six logical pixels and use the
same dark border and translucent fel ring as the web client. Tooltips expose
individual names, while the combined viewer list is available to assistive
technology. Viewer additions and removals animate with a short scale-and-fade
transition, while the stack width adjusts smoothly. The floating transcript
variant uses 28 logical-pixel avatars with a soft dark shadow that keeps them
legible over transcript text; Peon and session rows remain compact.
