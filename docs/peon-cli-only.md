# Peon is CLI-only

Peon has no operator dashboard and no user authentication of its own. All
human interaction, authentication, authorization and fleet management belong
to Overseer (web or native client).

The in-development [Windows desktop controller](peon-desktop.md) is a local
tray wrapper for process lifecycle, setup and status. It adds no Peon user
model or operator dashboard; it calls the same authoritative Peon services.

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

## Enrollment

There is one path. The local operator runs `peon enroll` to arm a single-use,
15-minute pairing phrase, then enters the Peon's reachable address and that
phrase in Overseer; Overseer mints the workspace credential and sends it to the
Peon's authenticated `POST /api/v1/enroll` route. `peon pair` remains a CLI
alias. The retired outbound `peon-claim-v1` service, the operator-code page,
credential rotation, recovery and dual-mode locks have all been removed.

When legacy Fleet HTTP binds beyond loopback, the daemon still rejects every
non-Fleet request whose real socket peer is not loopback. Forwarded headers do
not make a request local. Operator access must never be restored by exposing
that listener; use Overseer.
