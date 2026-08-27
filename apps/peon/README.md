# Peon

<p align="center">
  <img src="assets/peon.png" alt="Peon" width="640">
</p>

Peon runs coding agents for Overseer. It installs as a background service,
starts on login, and reconnects automatically.

## Install

You need Linux or macOS, Node.js 22+, Git, Python 3 at `/usr/bin/python3`,
and an authenticated Claude Code or Codex CLI.

```sh
npm install -g @rnm-dev/peon
peon start
peon remote on 0.0.0.0:4570
peon settings set publicControlUrl http://my-peon.example.ts.net:4570
peon enroll
```

Enter the printed address and one-time phrase in Overseer's Add Peon dialog.

Run Peon as a regular user, not with `sudo`.

## Tailscale

```sh
peon remote on 0.0.0.0:4570
peon settings set publicControlUrl http://my-peon.example.ts.net:4570
```

`publicControlUrl` can also be an `https://` URL. Fleet requests require
authentication; loopback remains available for the local CLI.

To go local-only again:

```sh
peon remote off
```

## Integrations

```sh
peon integration add work https://heroboard.example.com
```

Peon asks for the API key and checks it for you.

## Commands

```sh
peon status
peon enroll
peon pause
peon resume
peon restart
peon update
peon stop
```

Settings work the same way:

```sh
peon settings
peon settings set agentCommand /path/to/claude
peon settings set codexCommand /path/to/codex
```

`restart` and `update` wait for running work. Pass `--force` to override.

## Troubleshooting

- `peon: command not found` — add the npm global `bin` directory to `PATH`.
- `spawn claude ENOENT` — authenticate Claude Code, then run `peon start` again.
- `Failed to connect to bus` — log in as the Peon user or enable systemd linger.
- Logs are in `~/.local/state/.peon/`.

## Development

```sh
git clone https://github.com/rnm-dev/overseer.git
cd overseer/apps/peon
npm install
npm run dev
```

Run `npm run verify` before submitting a change.

See the [protocol reference](https://github.com/rnm-dev/overseer/blob/master/packages/protocol/PROTOCOL.md)
for the full wire contract.
