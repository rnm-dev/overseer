# Peon is CLI-only

Peon has no operator dashboard and no user authentication of its own. All
human interaction, authentication, authorization and fleet management belong
to Overseer (web or native client).

The Peon package contains:

- the `peon` CLI;
- the daemon and its loopback-only CLI API;
- authenticated Fleet HTTP on the configured external listener;
- outbound reverse control/realtime socket;
- agent, session, project, file and Armory runtimes.

The removed surface includes the static server, browser assets,
magic-link users, login sessions, auth cookies and `peon user ...` commands.
`peon start`, stop, restart and self-update manage only
`peon-daemon.service` (or `dev.peon.daemon` on macOS).

When Fleet HTTP binds beyond loopback, the daemon still rejects every
non-Fleet request whose real socket peer is not loopback. Forwarded headers do
not make a request local. The bearer is a full-administration credential, so
Internet-facing deployments must put the listener behind TLS and restrict
network access to Overseer. Human operator access remains in Overseer.
