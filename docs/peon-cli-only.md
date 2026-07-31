# Peon is CLI-only

Peon has no operator dashboard and no user authentication of its own. All
human interaction, authentication, authorization and fleet management belong
to Overseer (web or native client).

The Peon package contains:

- the `peon` CLI;
- the daemon and its loopback-only CLI API;
- authenticated legacy Fleet HTTP for older Overseers;
- outbound reverse control/realtime socket;
- agent, session, project, file and Armory runtimes.

The removed surface includes the port 4571 static server, browser assets,
magic-link users, login sessions, auth cookies and `peon user ...` commands.
`peon start`, stop, restart and self-update manage only
`peon-daemon.service` (or `dev.peon.daemon` on macOS). Old dashboard units may
remain on an upgraded machine but are obsolete and should be disabled and
removed during migration.

When legacy Fleet HTTP binds beyond loopback, the daemon still rejects every
non-Fleet request whose real socket peer is not loopback. Forwarded headers do
not make a request local. Operator access must never be restored by exposing
that listener; use Overseer.
