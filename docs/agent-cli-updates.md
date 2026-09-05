# Agent CLI updates

Peon exposes one durable update workflow for coding-agent CLIs, while each
`AgentDriver` owns the provider-specific updater. The manager owns persistence,
serialization, background supervision, logs and HTTP responses; the driver
owns installation inspection, release lookup, applying the update and version
verification.

## Supported installation boundary

Automatic update is allowed only after the configured command resolves to an
executable whose owner Peon can identify:

- the provider's expected global npm package;
- a Homebrew Cellar or Cask installation;
- a provider-native version store, currently Claude Code under
  `.local/share/claude/versions`;
- a native ELF, Mach-O or PE standalone executable.

Every otherwise supported executable must also identify itself as the expected
provider in its `--version` output. Native magic alone is not sufficient to
authorize a self-update.

Paths owned by Nix, asdf, Volta, mise, Devbox or pnpm are externally managed.
Peon reports their installed version but refuses to mutate them. Scripts and
wrappers whose ownership cannot be established are `unknown` and receive the
same safe refusal. A configured wrapper must not be followed by guessing which
package the operator intended to update.

The release comparison currently uses the provider's official npm package as
the stable release catalog, independently of how the executable was installed.
The provider CLI's own `update` command performs the mutation, so native and
standalone layouts keep their provider-defined installation semantics.

## Durable state and API

Each provider state includes `currentVersion`, `latestVersion`,
`updateAvailable`, `installationKind`, `updateSupported`, `updateReason`,
`checkedAt`, `checkError` and the durable `operation`. Old schema-v1 state files
load with the three installation fields set to `null` until the next check.

Public provider IDs are `codex` and `claude-code`; `codex-app-server` remains
the internal runtime/driver ID. Both aliases are accepted at Peon's local API
boundary, but responses use the public ID.

An apply worker receives both the executable path and resolved real path that
were inspected. It re-resolves the executable and refuses the update if the
target changed after admission, invokes the driver updater, reads that same
command's version afterward and fails the
operation if the version is unreadable or remains below the version selected by
the preceding check. Failed or interrupted workers retain their log path and
error in the durable operation.

Peon refuses to begin an agent CLI update while any session is active. After
admission and before the worker starts, the driver shuts down a persistent
runtime such as Codex app-server; the next turn starts it from the verified new
executable. One serialized manager admits updates, so two provider updates
cannot cross this preparation boundary concurrently.

## Extending another driver

A new driver advertises `capabilities.cliUpdate` only when it provides an
`AgentCliUpdater`. Reuse `createSelfUpdatingCliUpdater` only for a CLI whose
stable releases are mirrored by an npm package and whose `update` command knows
how to update every installation kind the driver marks as supported. Otherwise
implement the four updater operations directly and keep the manager
provider-neutral.
