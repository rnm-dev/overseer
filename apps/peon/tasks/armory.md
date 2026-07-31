# Build Armory: installable tools and a unified Peon MCP

## Objective

Add **Armory**, a managed capability system that lets Peon discover, install, configure, enable, update, and uninstall tools from an official public registry.

An Armory package may:

- expose MCP tools to agents;
- depend on a local CLI or other runtime asset;
- require provider-specific credentials or configuration;
- verify that its bundled runtime, configuration, and remote access work;
- materialize configuration in a provider-specific location such as an isolated `.aws` directory.

Peon must expose one stable local MCP server to every project-linked agent session. That server combines Peon's existing project-management tools with the tools from all installed and enabled Armory packages. Agents must not need a new MCP configuration for each package.

The first release is a **trusted-package system backed by Peon's official public registry**. It is not a sandbox for arbitrary third-party code.

## User outcome

An operator can open **Settings → Armory**, browse available tools, install one, provide any required configuration, verify it, and enable it. The same operations, except secret entry, are available through the `peon armory` CLI. An agent can discover and install packages when policy allows it, then use the package's MCP tools through Peon's existing MCP endpoint.

A successful example flow is:

1. The operator or agent searches for an AWS or Google Analytics package.
2. Peon installs the versioned Armory package transactionally.
3. The package uses only runtime dependencies bundled in its immutable release archive.
4. Armory reports `needs_configuration` if credentials are required.
5. Overseer renders the package-defined form and passes submitted values to the package's configuration hook without exposing them to agents or transcripts.
6. The package writes configuration to its declared managed location and verifies access.
7. Peon starts the package's MCP child process and includes its namespaced tools in `tools/list` on Peon's single MCP endpoint.
8. Future agent sessions can call those tools without receiving a separate MCP server configuration.

## Implementation status — 2026-07-15

The repository currently contains the Armory domain/storage foundation, catalog client, transactional archive installer foundation, hook/configuration runner, and a read-oriented API suitable for an Overseer marketplace. The official catalog currently returns zero packages, so consumers must implement a valid empty-catalog state.

### Completed in Peon

- Strict V1 catalog, manifest, operation, activation, configuration-field, credential-metadata, ownership, and hook-event contracts.
- XDG data/state/config paths, atomic JSON stores, mode-`0600` credential persistence, cleanup, recovery, and operation locking.
- Official catalog fetch with validation, ETag cache, bounded requests, approved-host policy, and last-known-good offline behavior.
- Safe archive download/extraction, digest verification, manifest validation, side-by-side package placement, and atomic activation foundation.
- Crash-consistent installation with fsynced package trees and state directories, per-install transaction journals, orphan cleanup on restart, and process-wide serialization for independent state-store instances.
- Package-owned configuration interface: manifest-declared fields plus configure/verify child hooks receiving one validated stdin event.
- Configuration validation, secret redaction, managed-home materialization, declared host-write confirmation, ownership tracking, verification, and safe deletion.
- Shared Armory inventory that merges catalog packages with independently persisted installed state and keeps installed packages visible during registry failure.
- Fleet/Overseer bearer reads and operator reads for inventory, full package detail, configuration metadata, Armory settings, and operation status.
- Operator-only `PATCH` for Armory settings and `PUT`/`DELETE` for package configuration. Fleet bearer requests cannot mutate either surface.
- Search, installed filtering, bounded opaque-cursor pagination, update detection, live/cached/unavailable registry metadata, stable error envelopes, and no secret values in responses.
- Optional package-scoped square PNG/WebP icons propagated through catalog, inventory, and detail responses with approved-host/path enforcement.

### Implemented API

```text
GET    /api/v1/armory/catalog?q=&installed=&limit=&cursor=   operator alias
GET    /api/v1/armory/packages?q=&installed=&limit=&cursor=  operator + Overseer
GET    /api/v1/armory/packages/:id                           operator + Overseer
GET    /api/v1/armory/packages/:id/configuration             operator + Overseer, metadata only
GET    /api/v1/armory/settings                               operator + Overseer
GET    /api/v1/armory/operations/:id                         operator + Overseer
POST   /api/v1/armory/refresh                                operator + Overseer
POST   /api/v1/armory/packages/:id/install                    operator + Overseer
POST   /api/v1/armory/packages/:id/enable                     operator + Overseer
POST   /api/v1/armory/packages/:id/disable                    operator + Overseer
DELETE /api/v1/armory/packages/:id                            operator + Overseer, preserves configuration
PATCH  /api/v1/armory/settings                               operator only
PUT    /api/v1/armory/packages/:id/configuration             operator only
DELETE /api/v1/armory/packages/:id/configuration             operator only
```

Package detail returns the complete root-catalog entry, including all versions/platforms/archive metadata, alongside local installed state. Configuration reads return field definitions, boolean configured-field metadata, and declared host-write paths; they never return submitted values. Configuration writes return `202` with an asynchronous operation and never echo submitted values.

The copy-ready read-only Overseer UI task is in `tasks/overseer-armory-marketplace.md`.

### Changes from the original draft

- V1 package archives are self-contained. Manifest `dependencies` must remain empty; Armory does not install or remove external/root-owned executables.
- Package configuration is standardized as manifest-declared UI fields plus package-owned configure/verify hooks, rather than a provider-specific API implemented inside Peon.
- Armory remains separate from task `IntegrationPlugin` implementations such as Heroboard.
- The same safe read representation is mounted behind operator and fleet authentication, while settings/configuration mutations are registered only for the operator profile.
- Configuration and configuration-deletion operations persist distinct `configure` and `delete_configuration` operation kinds.
- Catalog packages may declare an optional square `iconUrl`; clients must preserve a square slot and render a deterministic name/ID fallback when it is absent or fails.

### Intentionally still incomplete

- Official catalog content/package publication; the current marketplace is empty.
- Update, verify, purge, and rollback control API routes.
- Complete lifecycle orchestration around update and rollback.
- Unified MCP gateway, package process supervision, namespaced tool proxying, runtime health, exposed-tool reporting, and list-change notifications.
- Armory counts in `/api/v1/status`, Overseer Armory UI, CLI commands, per-route multipart file upload, and final end-to-end release verification.

### Verification baseline

- `npm run typecheck` passes.
- `npm test` passes with 144 tests.
- `npm run compile` passes.
- Live read-only smoke checks return `200` for Armory settings/catalog and stable `404 PACKAGE_NOT_ACTIVE` for configuration metadata on a non-installed package.

## Terminology

- **Armory**: the complete registry, installer, lifecycle manager, UI, CLI, and MCP aggregation feature.
- **Package**: a versioned installable capability obtained from the registry.
- **Dependency**: a local binary or runtime required by a package, such as `aws` or `gcloud`.
- **Configuration**: package-specific fields, files, OAuth state, or other material required before use.
- **Managed home**: a package-owned filesystem root used to isolate provider files from the operator's real home directory.
- **Enabled**: the package is healthy and its MCP tools should be exposed.
- **Operation**: a persisted asynchronous install, update, verify, or uninstall job with progress and an outcome.

## Current Peon integration points

Build on the current architecture rather than creating a parallel control plane:

- `src/daemon/projectMcp.ts` already serves Peon's loopback-only streamable HTTP MCP at `/mcp`.
- `src/daemon/sessions.ts` currently writes per-session MCP configuration for Peon and the selected task integration.
- `src/daemon/controlServer.ts` is the authenticated control API used by Overseer and CLI.
- `src/cli/peon.ts` owns the existing command surface and hidden-input behavior.
- `src/daemon/credentialStore.ts` demonstrates secret metadata and mode-`0600` persistence, but its single-string credential model is not sufficient as the complete Armory configuration abstraction.
- `src/daemon/xdgPaths.ts` has config and state paths; add an XDG data path for installed package contents.

The existing `IntegrationPlugin` abstraction represents task backends such as Heroboard. Armory packages are a different concept and must have their own types and registry. Do not overload `IntegrationPlugin`.

## V1 product decisions

1. Packages come only from a configured official Peon registry URL. V1 does not accept arbitrary URLs, Git repositories, or locally supplied archives.
2. The registry is public and contains an index plus immutable versioned package archives.
3. Every archive has a mandatory SHA-256 digest. A package version is immutable once published.
4. Packages are trusted code. Hooks and MCP servers always run as child processes, never inside the daemon process, but process isolation is for reliability and lifecycle control—not a security sandbox.
5. Installed and enabled packages are global to this Peon instance in V1. Per-project loadouts are a follow-up; structure persisted state so project scoping can be added without changing package identity.
6. V1 supports one active configuration profile per installed package.
7. Armory never asks an agent to supply secrets. Secret-bearing configuration is accepted only through authenticated control API routes used by Overseer or CLI.
8. Package-provided prompt text is not inserted into Peon's system or role instructions in V1. MCP tool descriptions are the package's agent guidance.
9. The default credential destination is a package-managed home. Writing to an operator-owned path requires a manifest declaration and an explicit warning in the UI.
10. Uninstall preserves configuration by default. An explicit purge option removes package-owned configuration. It must never remove a pre-existing external CLI or undeclared user file.

## Filesystem layout and persistence

Add `dataDir()` to `src/daemon/xdgPaths.ts`, using `XDG_DATA_HOME` or `~/.local/share`, consistent with the existing `.peon` application directory name.

Use the following logical layout:

```text
~/.local/share/.peon/armory/
  packages/<package-id>/<version>/       extracted immutable package
  active/<package-id>                    atomic pointer or activation record
  homes/<package-id>/                    managed HOME and provider files
  staging/<operation-id>/                incomplete download/extraction

~/.local/state/.peon/armory/
  installed.json                         installed version, status, enablement
  operations/<operation-id>.json         operation status and safe progress
  logs/<package-id>.log                   redacted lifecycle/runtime logs

~/.config/.peon/
  armory-settings.json                    registry and policy configuration
  armory-credentials.json                 V1 secret store, mode 0600
```

Writes to state and credential files must use a temporary sibling file, mode `0600` for credential-bearing files, followed by atomic rename. Validate persisted JSON and recover with a clear error instead of crashing the daemon on malformed state.

The installed record must include at least:

```ts
interface InstalledArmoryPackage {
  id: string;
  version: string;
  enabled: boolean;
  state:
    | "installing"
    | "needs_configuration"
    | "verifying"
    | "ready"
    | "error"
    | "removing";
  installedAt: number;
  updatedAt: number;
  sourceDigest: string;
  configurationStatus: "not_required" | "missing" | "unverified" | "verified" | "invalid";
  lastError: string | null;
  activeOperationId: string | null;
}
```

Only one mutating operation may run for a package at a time. Conflicting operations return HTTP `409` and a stable `OPERATION_IN_PROGRESS` code.

## Armory repository, registry, and package contract

V1 Armory is the separate public GitHub repository **`rnm-dev/armory`**. It is the source of truth for official package source, commit history, the package catalog, schemas, tests, and local release tooling. It does not require a database, continuously running registry service, pull-request workflow, branch protection, or CI service.

Peon's compiled default registry URL is:

```text
https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json
```

Allow an environment or daemon setting override for development and tests, but never allow an agent MCP call to change the registry URL. Production UI must visibly identify a non-default registry.

### Repository layout

The root `armory.json` is the complete machine-readable package listing. Package source lives beneath `packages/<id>`. Schemas and build/publish tooling live in the same repository:

```text
armory/
  armory.json                          root catalog consumed by Peon
  packages/
    google-analytics/
      armory.package.json              package manifest and permissions
      package.json
      package-lock.json
      src/
        mcp.ts                          stdio MCP server
        hooks/
          install.ts                    optional lifecycle work
          configure.ts                  optional credential materialization
          verify.ts                     optional provider verification
          uninstall.ts                  optional cleanup preparation
        shared/
      assets/                           optional non-code package assets
      tests/
    aws/
      armory.package.json
      package.json
      package-lock.json
      src/
      tests/
  schemas/
    armory-v1.schema.json
    package-v1.schema.json
    hook-message-v1.schema.json
  scripts/
    validate.mjs
    build-package.mjs
    publish-package.mjs
```

Package directories contain source and tests; Peon never installs them from the mutable default branch. A maintainer runs the checked-in local tooling to compile and bundle a package into an immutable archive attached to a GitHub Release. The root catalog points to that archive.

### Root `armory.json`

Use an object with a schema version and a package array. Arrays make ordering explicit and schema validation straightforward; package IDs remain unique keys logically.

```json
{
  "schemaVersion": 1,
  "name": "rnm-dev/armory",
  "updatedAt": "2026-07-14T12:00:00.000Z",
  "packages": [
    {
      "id": "google-analytics",
      "displayName": "Google Analytics",
      "iconUrl": "https://raw.githubusercontent.com/rnm-dev/armory/main/packages/google-analytics/assets/icon.png",
      "summary": "Read properties, reports, and realtime analytics.",
      "publisher": "rnm-dev",
      "documentationUrl": "https://github.com/rnm-dev/armory/tree/main/packages/google-analytics",
      "latest": "1.0.0",
      "requirements": {
        "credentials": true,
        "hostWrites": false
      },
      "versions": [
        {
          "version": "1.0.0",
          "minPeonVersion": "0.0.1",
          "platforms": [
            { "os": "darwin", "arch": "arm64" },
            { "os": "darwin", "arch": "x64" },
            { "os": "linux", "arch": "x64" },
            { "os": "linux", "arch": "arm64" }
          ],
          "archive": {
            "url": "https://github.com/rnm-dev/armory/releases/download/google-analytics-v1.0.0/google-analytics-1.0.0.tar.gz",
            "size": 184320,
            "sha256": "<64 lowercase hex characters>"
          }
        }
      ]
    }
  ]
}
```

Catalog validation rules include:

- package IDs match `^[a-z0-9][a-z0-9-]{0,62}$` and are unique;
- semantic versions are valid and unique within a package;
- `latest` references a listed version rather than merely the largest string;
- URLs are HTTPS and, under official-registry policy, use approved GitHub hosts;
- optional package icons are square PNG/WebP assets served from the package's approved `assets/` path; clients render an ID/name fallback when absent or unavailable;
- digests contain exactly 64 lowercase hexadecimal characters;
- archive size is positive and below the configured maximum;
- timestamps are valid RFC 3339 strings;
- platform values and Peon compatibility ranges are recognized;
- unknown fields are rejected for schema V1 so misspellings cannot silently weaken requirements.

The listing contains enough summary data to render search results without fetching every archive or source manifest. The archive's `armory.package.json` remains authoritative for runtime details; Peon verifies that its ID, version, platform claims, and summarized permissions agree with the catalog before executing it.

Registry fetches use `ETag`/`If-None-Match`, a bounded timeout and response size, and an on-disk last-known-good cache. A GitHub or network outage may prevent search/update discovery but must not prevent listing, starting, or using installed packages. Show when catalog data is cached and its last successful refresh time.

Peon reads the catalog from the raw GitHub URL but installs only immutable GitHub Release archives. It must not clone the repository, execute package files from `main`, depend on the GitHub API, or construct release URLs that are absent from the catalog.

### Release archive layout

Each release archive is self-contained and has exactly one logical root:

```text
google-analytics-1.0.0/
  armory.package.json
  dist/
    mcp.js
    hooks/
      install.js
      configure.js
      verify.js
      uninstall.js
  assets/
  LICENSE
  THIRD_PARTY_NOTICES
```

Only declared files are needed at runtime. Bundle Node dependencies into `dist` or otherwise include them in the archive; installation must not run `npm install` against mutable registry state. Exclude source maps containing local paths or source content unless deliberately published.

Reject absolute archive entries, `..` traversal, escaping symlinks/hardlinks, special device files, duplicate normalized paths, excessive file counts, oversized expanded content, and archives whose single root or manifest does not match the selected package/version.

### Package manifest

`armory.package.json` describes the installed runtime, not catalog presentation. Manifest shape:

```ts
interface ArmoryManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  minPeonVersion: string;
  platforms: Array<{ os: "darwin" | "linux"; arch: "x64" | "arm64" }>;
  permissions: {
    networkHosts: string[];
    hostPaths: Array<{ path: string; mode: "read" | "write"; purpose: string }>;
  };
  dependencies: [];
  configuration?: {
    fields: ArmoryConfigurationField[];
    handler: ArmoryCommand;
    verifyHandler?: ArmoryCommand;
    managedPaths: string[];
  };
  lifecycle?: {
    postInstall?: ArmoryCommand;
    preUninstall?: ArmoryCommand;
  };
  mcp: {
    command: ArmoryCommand;
    toolPrefix: string;
    startupTimeoutMs?: number;
    callTimeoutMs?: number;
  };
}

interface ArmoryCommand {
  executable: string;
  args: string[];
}
```

All manifest-relative executable paths must resolve inside the active package directory. Validate the manifest before running any package code. Manifest ID and version must exactly match the selected registry entry.

For the expected bundled Node package, commands look like:

```json
{
  "configuration": {
    "handler": { "executable": "node", "args": ["dist/hooks/configure.js"] },
    "verifyHandler": { "executable": "node", "args": ["dist/hooks/verify.js"] }
  },
  "mcp": {
    "command": { "executable": "node", "args": ["dist/mcp.js"] },
    "toolPrefix": "google_analytics"
  }
}
```

`node` may resolve to the Node executable already running Peon; all other executables are validated package-relative paths. V1 packages must bundle their runtime dependencies and cannot resolve arbitrary executables from `PATH`.

### Hook protocol

Lifecycle and configuration hooks are short-lived child processes using newline-delimited JSON. Peon writes exactly one `input` message to stdin, then closes stdin. The hook may write bounded progress events followed by exactly one terminal result to stdout:

```json
{"protocolVersion":1,"type":"input","operation":"configure","package":{"id":"aws","version":"1.0.0","dir":"<package-dir>","home":"<managed-home>"},"platform":{"os":"darwin","arch":"arm64"},"configuration":{"accessKeyId":"<secret>","secretAccessKey":"<secret>","region":"us-east-1"}}
{"protocolVersion":1,"type":"progress","phase":"writing_configuration","message":"Writing managed AWS configuration","percent":60}
{"protocolVersion":1,"type":"result","ok":true,"message":"AWS configuration is ready","ownedPaths":[".aws/config",".aws/credentials"]}
```

The first line above is Peon-to-hook; the remaining lines are hook-to-Peon. Configuration values may appear only in the stdin input message. A hook must never echo credentials in progress, result, stderr, or errors. Peon validates every output message, allows exactly one result, bounds line count and byte size, rejects undeclared/escaping `ownedPaths`, and treats EOF without a result as failure.

Standard hook operations are `post_install`, `configure`, `verify`, and `pre_uninstall`. Operation-specific input and result shapes live in `hook-message-v1.schema.json`. Hooks do not alter Armory's persisted lifecycle state directly; they report results and Peon performs all state transitions.

The long-running `dist/mcp.js` process speaks standard MCP over stdio and must not write non-protocol output to stdout. Diagnostic output goes to stderr and is subject to Peon's redaction and size limits.

### Manual repository publishing workflow

GitHub is used in three distinct ways:

1. **Source and history:** implementations live under `packages/`; maintainers may commit directly to `main`.
2. **Static catalog:** the root `armory.json` is fetched directly from the default branch and cached by Peon.
3. **Immutable distribution:** a maintainer runs the local release tooling, which builds archives and attaches them to GitHub Releases; the catalog points to those exact assets.

The local publish command must:

- validate `armory.json`, every manifest, and hook fixture message against checked-in schemas;
- ensure package IDs and versions agree across directory, manifest, tag, archive root, and catalog entry;
- run package tests on supported platforms where practical;
- build from a clean checkout and locked dependencies;
- produce deterministic archives where possible;
- calculate archive size and SHA-256 after building;
- upload an immutable release asset using a tag such as `<package-id>-v<version>`;
- refuse to replace an already-published package version or release asset;
- update the root catalog only after the referenced asset is reachable and its downloaded digest matches;
- validate the complete catalog again before committing/publishing its update.

The official repository's write access and the maintainer credentials used for manual releases are the V1 publisher trust boundary. SHA-256 detects corruption and mismatch but does not protect against compromise of the repository, a maintainer machine, or release credentials when the attacker can change both archive and catalog. V1 deliberately has no required pull requests, branch protection, or CI checks. Before accepting community publishers or mirrors, add signed package metadata using a public key pinned in Peon, protected release environments, mandatory review, and key rotation/revocation rules.

OAuth callbacks, paid/private packages, download analytics, publisher accounts, moderation, and user submissions may require a service later. None is required for the static official V1 registry.

### Bundled runtime dependencies

V1 packages are self-contained. They must bundle runtime dependencies into their immutable release archive and declare `dependencies: []`. Peon never searches the operator's `PATH`, downloads shared tools, invokes a system package manager, or manages external executables. `node` resolves to Peon's running Node executable; any other command executable must be a validated package-relative file. Commands use `spawn` argument arrays, a controlled environment, an explicit working directory, timeouts, and bounded output. Peon never uses shell command strings or places credentials in arguments.

### Configuration and credentials

Configuration fields support at least:

```ts
type ArmoryConfigurationField = {
  id: string;
  label: string;
  help?: string;
  type: "text" | "secret" | "select" | "file";
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  validation?: { pattern?: string; maxLength?: number };
};
```

Overseer retrieves the schema but never existing secret values. Responses expose only field-level `configured: boolean` metadata. Values from `secret` and `file` fields are redacted recursively from structured logs and errors.

Pass submitted values to the configuration handler over a one-use JSON message on stdin. The handler returns safe structured output on stdout. Do not put values in environment variables, arguments, operation files, or logs.

Launch configuration hooks with:

- `PEON_ARMORY_PACKAGE_DIR`;
- `PEON_ARMORY_HOME`;
- provider-specific file environment declared by the package;
- a minimal inherited environment with a controlled `PATH`.

By default, a package materializes files beneath `PEON_ARMORY_HOME`. For example, an AWS package should set `AWS_SHARED_CREDENTIALS_FILE` and `AWS_CONFIG_FILE` to files below its managed home rather than modifying the operator's real `~/.aws`.

If a manifest requests a host path such as `~/.aws`, show the exact path and write permission before installation/configuration. Record every file that Armory created. Never delete or replace a pre-existing file unless the package explicitly implements a safe merge/backup operation and the operator confirms it.

OAuth and device authorization are not required for the first package, but the API and operation model must be extensible to return an `authorization_url`, device code metadata, or callback state later. Do not model all credentials as a single API-key string.

## Tool lifecycle

### Install

1. Resolve the recommended or requested version and platform.
2. Create a persisted operation and acquire the package lock.
3. Download into the staging directory with size and timeout limits.
4. Verify SHA-256 before extraction.
5. Extract safely and validate the manifest.
6. Run an optional `postInstall` hook in a child process.
7. Health-check the MCP server without exposing it yet.
8. Atomically activate the package version.
9. Set state to `needs_configuration` or `ready`.
10. Enable automatically only when configuration and MCP health pass.
11. Retain safe operation progress and remove staging data.

Any failure before activation leaves the previous active version untouched. A first-time failed install leaves no active package and records an actionable error.

### Configure and verify

Configuration stops the MCP child before changing provider files. On success, run the package verification hook and MCP health check, update only safe metadata, and restart the MCP child when enabled. Invalid credentials set `configurationStatus: "invalid"` without deleting submitted configuration automatically.

### Enable and disable

Enable requires verified configuration when required and a passing MCP health check. Disable prevents new calls, stops the child process gracefully, then kills it after a timeout. Installed files and configuration remain.

### Update and rollback

Install the new version beside the old version. Verify compatibility, configuration, and MCP startup before atomically switching activation. Keep the immediately previous version until the new version has remained healthy. If activation or startup fails, restore the previous version and report that rollback occurred.

### Uninstall

1. Reject or wait while another package operation or tool invocation is active.
2. Disable the package and stop its MCP process.
3. Run `preUninstall` with a timeout.
4. Remove package versions and activation state.
5. Preserve managed configuration by default.
6. With `purge: true`, delete only recorded package-owned configuration paths and stored Armory secrets.
7. Never remove unrecorded host files.

Daemon restart recovery must identify incomplete operations, clean abandoned staging directories, and restore each package to the last atomically activated version. It must not blindly rerun a credential or lifecycle hook after a crash.

## Unified MCP protocol

Keep `/mcp` as the one server configured for project-linked agents. Refactor its server construction into a unified Peon MCP server containing:

- existing project metadata/publication tools;
- Armory management tools;
- proxied tools from installed, enabled, healthy package MCP child processes.

Continue to reject non-loopback connections and browser-origin requests.

### Package MCP supervision

Each enabled package runs as a supervised stdio MCP child process. Peon owns startup, initialization, `tools/list`, calls, cancellation, timeout, shutdown, stderr capture, and restart backoff. The daemon must remain healthy if a package crashes or emits malformed protocol messages.

Prefix exposed package tool names deterministically, for example:

```text
armory__google_analytics__run_report
armory__aws__list_buckets
```

Reject duplicate names, invalid schemas, reserved Peon names, or a package whose returned prefix differs from its manifest. Preserve MCP tool annotations where valid. Tool results pass through, but transport/protocol errors become safe MCP errors containing package ID and an actionable summary.

Use per-package call timeouts, bounded result sizes, cancellation propagation, and a concurrency limit. Track active calls so disable/update/uninstall cannot terminate a tool midway without a clear conflict or drain timeout.

When the enabled tool set changes, emit MCP tool-list-changed notifications for connected clients that support them. Because coding-agent clients may cache `tools/list`, return an explicit operation result explaining that a newly installed tool may require a new agent turn or session. Test actual behavior for both supported agent backends; do not promise same-turn discovery unless verified.

### Armory management tools

Expose a small, stable management surface:

- `armory_search`: search official catalog metadata; read-only.
- `armory_get`: return package requirements, permissions, and local status; read-only.
- `armory_install`: install an official package when policy permits; destructive/open-world.
- `armory_enable`: enable a ready installed package.
- `armory_disable`: disable a package.
- `armory_uninstall`: uninstall a package but never purge credentials/configuration from an agent call.

Do not expose credential submission, configuration file upload, OAuth tokens, `purge`, arbitrary registry URLs, arbitrary versions outside policy, or raw lifecycle hook execution through MCP.

V1 agent install policy is an allowlist of package IDs from the official registry. If a package is not allowed, return an MCP error that says installation requires an operator in Settings → Armory. Never infer approval merely because an agent asked.

## Control API

All routes use the existing `/api/v1` authentication gate and return `{ error, code }` on failure. Mutations should return `202` with an operation for asynchronous work unless validation fails before an operation begins.

### Catalog and status

```text
GET  /api/v1/armory/catalog?q=&installed=&limit=&cursor=
GET  /api/v1/armory/packages/:id
GET  /api/v1/armory/packages/:id/configuration
GET  /api/v1/armory/operations/:operationId
GET  /api/v1/armory/settings
```

Package detail combines registry metadata, installed state, configuration status, declared permissions, update availability, and safe recent error information. Registry unavailability must not prevent viewing or using already-installed packages.

### Lifecycle mutations

```text
POST   /api/v1/armory/packages/:id/install
       { "version"?: string }

POST   /api/v1/armory/packages/:id/update
       { "version"?: string }

POST   /api/v1/armory/packages/:id/enable
POST   /api/v1/armory/packages/:id/disable
POST   /api/v1/armory/packages/:id/verify

DELETE /api/v1/armory/packages/:id
       { "purge"?: boolean }
```

### Configuration

```text
PUT    /api/v1/armory/packages/:id/configuration
       { "values": Record<string, string>, "confirmHostWrites"?: boolean }

DELETE /api/v1/armory/packages/:id/configuration

PATCH  /api/v1/armory/settings
       { "registryUrl"?: string, "agentInstallAllowlist"?: string[] }
```

Never echo submitted configuration values. A success response contains only configured field IDs, verification status, and an operation ID. Apply stricter request-body size limits to these routes, especially file fields. Prefer a dedicated multipart upload endpoint for files rather than base64 in JSON if needed by the first package.

Operation representation:

```ts
interface ArmoryOperation {
  id: string;
  packageId: string;
  kind: "install" | "update" | "configure" | "verify" | "enable" | "disable" | "uninstall";
  status: "queued" | "running" | "success" | "failure" | "needs_human";
  phase: string;
  progress: number | null;
  message: string;
  errorCode: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}
```

Messages are safe for UI/CLI display and contain no command output until redacted. Retain a bounded operation history.

## CLI commands

Add an `Armory` section to `peon --help`:

```text
peon armory search [query]
peon armory list [--installed]
peon armory show <id>
peon armory install <id> [--version <version>]
peon armory configure <id>
peon armory verify <id>
peon armory enable <id>
peon armory disable <id>
peon armory update <id> [--version <version>]
peon armory uninstall <id> [--purge]
```

The CLI talks to the daemon API; it does not implement package lifecycle separately. Mutating commands poll their operation until terminal state and print phase changes. Exit codes are `0` for success, `1` for operation failure, `2` for invalid usage, and `3` for `needs_human`.

`configure` retrieves the package schema and prompts dynamically. Use hidden input for `secret` fields. Do not support secret `--field=value` arguments, because shell history and process listings would expose them. For non-interactive input, accept a JSON object from stdin only when an explicit `--stdin` flag is present and never print it. File fields prompt for a source path and stream the file to the daemon.

Add `--json` to read-only commands and operation results so automation can consume stable response objects.

If the daemon is unavailable, commands should report the control URL and connection error. They must not silently fall back to modifying Armory files directly.

## Dashboard screens

Add an **Armory** tab to `SettingsView` at `/settings/armory`.

### Armory catalog/list

Show:

- search input;
- Available / Installed filter;
- package name, summary, installed version, latest version;
- status badge: Not installed, Installing, Needs setup, Ready, Enabled, Error, Update available;
- key requirement badges such as CLI, Credentials, OAuth, Host filesystem;
- Install or Open action.

The screen must still render installed packages when the remote registry is unavailable and show a non-blocking catalog error.

### Package detail

Route: `/settings/armory/:id`

Show:

- description and publisher;
- installed/latest version;
- bundled-runtime validation;
- permissions and exact requested host paths;
- configuration status without secret values;
- MCP runtime health and number/list of exposed tools;
- last safe error and operation progress;
- Install, Configure, Verify, Enable/Disable, Update, and Uninstall actions as appropriate.

Disable impossible actions with a reason. Destructive uninstall requires confirmation. Purge is a separate unchecked option explaining exactly which managed paths will be deleted.

### Configuration form

Render fields from the validated manifest schema. Secret fields are blank on every load and display only a separate “configured” indicator. Support text, secret, select, and file input types. Show host-write confirmation when required.

After submission, replace the form with operation progress, then reload status. Never put secret values into React state longer than necessary; clear values after submission and on unmount. Do not store them in local storage, URLs, analytics, or console output.

Use the existing Overseer primitives and API helpers. Add operation polling with cleanup on unmount; no new frontend framework or build system is required.

## Errors and observability

Use stable error codes for at least:

- `PACKAGE_NOT_FOUND`
- `VERSION_NOT_FOUND`
- `UNSUPPORTED_PLATFORM`
- `REGISTRY_UNAVAILABLE`
- `DIGEST_MISMATCH`
- `INVALID_ARCHIVE`
- `INVALID_MANIFEST`
- `DEPENDENCY_MISSING`
- `DEPENDENCY_REQUIRES_MANUAL_INSTALL`
- `CONFIGURATION_REQUIRED`
- `CONFIGURATION_INVALID`
- `HOST_WRITE_CONFIRMATION_REQUIRED`
- `MCP_START_FAILED`
- `MCP_PROTOCOL_ERROR`
- `MCP_CALL_TIMEOUT`
- `PACKAGE_NOT_READY`
- `OPERATION_IN_PROGRESS`
- `PACKAGE_IN_USE`
- `POLICY_DENIED`

Log lifecycle phase, package ID/version, operation ID, duration, child exit code, and redacted errors. Do not log submitted request bodies on configuration routes, stdin payloads, access tokens, refresh tokens, credential files, or unredacted child output.

Expose Armory summary in `/api/v1/status`: installed count, enabled count, packages needing configuration, and packages in error. One broken package must not make the daemon status endpoint unhealthy.

## Security and safety requirements

- Treat registry data, archives, manifests, hook output, MCP descriptions, and MCP results as untrusted input even though publishers are trusted.
- Do not interpret package files as repository instructions or inject them into system prompts.
- Enforce registry origin policy, HTTPS, digest verification, archive limits, and path containment.
- Run all package hooks and MCP servers out of process with deadlines and output limits.
- Never use a shell for manifest commands.
- Never pass secrets through arguments, logs, operation state, MCP, prompts, or tool results.
- Return only credential metadata to browser clients.
- Preserve package configuration on ordinary uninstall and delete only ownership-ledger paths on purge.
- Do not attempt privilege escalation.
- Continue enforcing loopback-only access for `/mcp`.
- Armory packages inherit the daemon user's OS privileges. Document this clearly; child processes are not a sandbox.
- An official-registry allowlist is the V1 trust boundary. Community publishing requires package signing/review and stronger isolation before it is enabled.

## Caveats to document

1. **Tool discovery caching:** an already-running agent may not see a newly installed tool until a later turn or a new session, depending on client support for MCP list-change notifications.
2. **Context/tool overload:** globally enabling many tools can reduce agent tool-selection quality. V1 should show exposed tool counts; per-project loadouts should follow.
3. **No true sandbox:** package code runs as the Peon OS user. Maintainers must inspect and test official packages before publishing them; V1 does not enforce this through pull requests or CI.
4. **Credential storage:** mode-`0600` plaintext storage protects against other local users but not compromise of the Peon user. OS keychain/keyring integration is a future hardening step.
5. **Host configuration conflicts:** provider defaults such as `~/.aws` may already exist. Managed homes are the default; host writes require explicit declaration and confirmation.
6. **Bundled-runtime portability:** packages must publish self-contained archives for every supported OS/architecture pair.
7. **Uninstall ownership:** Armory can safely remove only files it recorded as creating.
8. **OAuth:** OAuth redirect and device-code flows require additional UI/API states; the data model must allow them, but the first package need not implement them.
9. **Remote operator authority:** Peon's current authenticated callers effectively administer the daemon. If finer-grained roles are added, all Armory mutations and credential routes must require an administrator role.
10. **Package schema evolution:** manifests and registry indexes require explicit schema versions and migration/compatibility behavior.

## Implementation task list

Complete these groups in order. A group is complete only when its tests pass and its public types/contracts are stable enough for the next group. Keep the Armory repository and Peon changes in separate commits and release flows.

### 0. Freeze the V1 contracts

- [x] Confirm `rnm-dev/armory` as the official repository and `https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json` as Peon's compiled default catalog URL.
- [x] Reserve `schemaVersion: 1` for the root catalog, package manifest, and hook message protocol.
- [x] Finalize package ID, semantic-version, platform, compatibility-range, archive, permission, configuration-field, command, and hook-message types.
- [x] Define maximum catalog bytes, archive download bytes, expanded bytes, file count, hook output bytes, MCP result bytes, startup duration, lifecycle duration, and tool-call duration.
- [x] Define the exact allowed GitHub hosts for official catalog documentation and release URLs.
- [x] Define the V1 agent-install allowlist configuration and its secure default.
- [x] Confirm that installed package enablement is global in V1 and document per-project loadouts as a follow-up.
- [x] Confirm that Armory never runs `sudo`, accepts sudo passwords, invokes system package managers silently, or exposes privileged installation through MCP.
- [x] Confirm that ordinary uninstall preserves configuration and only explicit operator-side `purge` removes Armory-owned configuration.

The frozen normative contract for this phase is
[`docs/armory-v1-contracts.md`](../docs/armory-v1-contracts.md).

### 1. Bootstrap `rnm-dev/armory`

- [x] Create the public `rnm-dev/armory` repository. V1 permits direct commits to `main` and has no branch protection, required pull requests, or required checks.
- [x] Add the root `armory.json` with an empty valid package array.
- [x] Add `schemas/armory-v1.schema.json` for the root catalog.
- [x] Add `schemas/package-v1.schema.json` for `armory.package.json`.
- [x] Add `schemas/hook-message-v1.schema.json` covering input, progress, and terminal result events for every hook operation.
- [x] Add shared TypeScript types generated from or tested against the JSON schemas so runtime schemas and package author types cannot drift unnoticed.
- [x] Add `scripts/validate.mjs` to validate the complete repository, unique IDs/versions, `latest` references, package directory names, manifests, URLs, digests, and compatibility ranges.
- [x] Add a deterministic archive builder that emits one package root, normalized paths/modes/timestamps, bundled runtime dependencies, license notices, and no undeclared development files.
- [x] Add a release publisher that refuses an existing tag/version, uploads the archive, downloads it again, verifies its digest, and only then prepares the `armory.json` update.
- [x] Make the local release publisher create immutable GitHub Releases with tags named `<package-id>-v<version>`; publishing is a manual maintainer action, not CI.
- [x] Document the local pre-publish sequence for schema validation, locked installs, typechecking, tests, clean builds, and archive inspection.
- [x] Add contributor documentation for package structure, tool naming, hooks, secret handling, local testing, versioning, and manual release verification.

### 2. Add deterministic fixture packages

- [x] Add `packages/fixture-echo` with no dependencies or credentials and one stdio MCP echo tool.
- [x] Add a self-contained `packages/fixture-configured` with text/secret/select/file configuration examples, configure and verify hooks, and one MCP tool.
- [x] Ensure fixtures never contact public services, inspect the real user home, or require root.
- [x] Add valid and intentionally invalid archive fixtures for traversal, escaping links, duplicate paths, size limits, malformed manifests, digest mismatch, hook protocol errors, MCP crashes, timeouts, and oversized results.
- [x] Keep fixture packages out of the production root catalog or mark them explicitly unavailable outside test catalogs.

### 3. Add Armory domain types and XDG storage to Peon

- [x] Add `dataDir()` to `src/daemon/xdgPaths.ts` using `XDG_DATA_HOME` or `~/.local/share` and Peon's existing `.peon` directory convention.
- [x] Create an `src/daemon/armory/` module boundary; do not add Armory behavior to the task-integration plugin abstraction.
- [x] Add strict runtime validators for catalog, manifest, installed record, operation, credential metadata, ownership, and hook events.
- [x] Add atomic JSON stores for installed state, operation history, settings/policy, credentials, and the ownership ledger.
- [x] Add mode-`0600` structured secret storage without changing existing Cloudflare or integration credential behavior.
- [x] Never deserialize persisted lifecycle state directly into executable commands; revalidate it against the active manifest and registry policy.
- [x] Add bounded operation-history retention and safe cleanup of old logs/staging directories.
- [x] Add tests using isolated XDG roots for atomic writes, malformed state, migration defaults, path containment, concurrent updates, and process restart.

### 4. Implement the catalog client

- [x] Fetch the configured root catalog over HTTPS with timeouts, redirect limits, content-length/streaming limits, and approved-host validation.
- [x] Implement `ETag`/`If-None-Match` and persist a last-known-good catalog plus fetch timestamp.
- [x] Validate the complete response before replacing the cache.
- [x] Preserve installed package usability when refresh fails.
- [x] Implement package search, package detail, compatible-version resolution, latest-version resolution, and update detection.
- [x] Reject incompatible Peon versions, unsupported platforms, duplicate records, unknown schema versions, invalid release hosts, and malformed digests.
- [x] Expose whether catalog data is live or cached and the last refresh error without leaking internal request details.
- [x] Add deterministic HTTP fixture tests for success, `304`, redirects, timeout, oversized response, invalid catalog, stale cache, and no-cache failure.

### 5. Implement safe archive download and activation

- [x] Create persisted asynchronous operations with package-level locks and stable phases/error codes.
- [x] Download release assets into per-operation staging directories with byte and time limits.
- [x] Compute SHA-256 while streaming and reject mismatch before extraction.
- [x] Safely inspect/extract tar archives, rejecting absolute/traversal paths, escaping links, special files, duplicates, too many files, and expanded-size excess.
- [x] Require the single archive root and manifest ID/version to match the catalog selection.
- [x] Validate all manifest commands and managed paths before any child process starts.
- [x] Install package versions side by side and switch an atomic activation record only after all checks pass.
- [x] Keep the previous active version available for rollback.
- [x] Remove staging content on success and safe failure; retain only bounded diagnostic metadata.
- [x] Recover interrupted downloads/extractions at daemon startup without rerunning hooks.

### 6. Require self-contained package archives

- [x] Require manifests to declare `dependencies: []`.
- [x] Require packages to bundle all runtime dependencies in their immutable archive.
- [x] Allow only Peon's Node executable or validated package-relative executables.
- [x] Reject `dependency:` commands, external `PATH` lookup, shared downloads, privilege helpers, and system-package-manager execution in V1.
- [x] Remove dependency ownership/reference state and dependency-specific lifecycle/UI requirements.

### 7. Implement the hook runner and configuration system

- [x] Run every lifecycle/configuration hook as a short-lived child with controlled cwd, environment, executable resolution, timeout, output cap, and kill escalation.
- [x] Write exactly one validated input event to stdin and close it.
- [x] Parse bounded NDJSON progress/result events; require exactly one terminal result.
- [x] Treat protocol text on stdout, malformed JSON, duplicate results, EOF without result, nonzero exit, timeout, and escaping owned paths as operation failures.
- [x] Redact submitted `secret` and `file` values recursively from progress, stderr, errors, logs, operation state, and HTTP responses.
- [x] Render and validate text, secret, select, and file configuration fields from manifests.
- [x] Pass `secret` and `file` configuration only in the one-use stdin event—not arguments, environment, files outside the package handler, or persisted operations.
- [x] Launch hooks with `PEON_ARMORY_PACKAGE_DIR`, `PEON_ARMORY_HOME`, controlled `PATH`, and declared provider file variables.
- [x] Default provider materialization to the managed home.
- [x] Require explicit operator confirmation for declared host writes and record every Armory-created path in the ownership ledger.
- [x] Refuse deletion/replacement of a pre-existing host file unless a future separately designed merge/backup policy allows it.
- [x] Store only safe configured-field metadata and verification results in ordinary state.
- [x] Stop an enabled package's MCP child before reconfiguration and restart it only after successful verification/health check.
- [x] Implement configuration deletion separately from package uninstall.
- [x] Test redaction with secrets embedded in nested JSON, stderr, thrown errors, progress text, and child output fragments.

### 8. Implement complete package lifecycle orchestration

- [ ] Implement install phases: resolve, download, verify digest, extract, validate, post-install, MCP health check, activate, configure-state decision, enable decision, cleanup.
- [ ] Implement configure and verify state transitions, including invalid credentials without automatic deletion.
- [ ] Implement enable readiness gates and MCP startup verification.
- [ ] Implement graceful disable with active-call drain, timeout, and forced child termination.
- [ ] Implement side-by-side update, compatibility/configuration validation, atomic activation, health observation, and automatic rollback.
- [x] Implement uninstall with active-operation/call conflicts, pre-uninstall hook, package removal, configuration preservation, and restart recovery that never blindly replays the hook.
- [ ] Implement explicit purge that removes only credential records and ownership-ledger paths belonging to the package.
- [ ] Ensure every failure produces a stable code, safe message, retained previous version where applicable, and deterministic recoverable state.
- [ ] Reconcile activated packages and interrupted operations on daemon startup without replaying non-idempotent hooks.
- [ ] Add concurrency tests for simultaneous install/update/configure/enable/uninstall requests.

### 9. Refactor Peon's MCP endpoint into a gateway

- [ ] Extract existing project/publication MCP tool registration without changing tool names, schemas, descriptions, annotations, or loopback/browser-origin protections.
- [ ] Implement one supervised stdio MCP child per enabled package with initialization, list, call, cancellation, shutdown, stderr capture, crash detection, and exponential restart backoff.
- [ ] Validate every child tool schema and enforce `armory__<manifest-prefix>__<tool-name>` namespacing.
- [ ] Reject duplicate, invalid, reserved, or prefix-mismatched tool names.
- [ ] Proxy tool calls/results with per-package timeouts, cancellation, result-size limits, concurrency limits, and safe transport errors.
- [x] Track active calls so disable and uninstall drain in-flight calls before stopping the child; update reuses the same runtime stop boundary.
- [ ] Emit MCP tool-list-changed notifications when package availability changes.
- [ ] Add stable management tools for search, get, policy-controlled install, enable, disable, and non-purging uninstall.
- [ ] Prohibit credentials, configuration values, purge, registry changes, arbitrary URLs/versions, and raw hook execution through MCP.
- [ ] Preserve `mcp__peon__*` session permission behavior and remove the need to add one MCP config entry per Armory package.
- [ ] Verify actual dynamic-discovery behavior with both Claude Code and Codex; return accurate restart/new-turn guidance where clients cache tools.
- [ ] Add regression tests proving existing project metadata and publication tools behave identically.

### 10. Add the control API

- [x] Add catalog search/list and package-detail routes.
- [x] Add package configuration-schema/status routes that never return secret values.
- [ ] Add install, update, configure, verify, enable, disable, uninstall, and purge-backed uninstall operations.
- [x] Add operation-status retrieval with bounded safe progress.
- [ ] Add strict per-route body limits and multipart handling for configuration file fields.
- [ ] Return `202` for started asynchronous work, `409` for conflicts, and consistent `{ error, code }` failures.
- [ ] Apply the existing operator authentication gate and document current administrator-equivalent authority.
- [ ] Add Armory installed/enabled/needs-configuration/error counts to `/api/v1/status` without making one broken package fail daemon health.
- [ ] Ensure request logging and error middleware never serialize configuration request bodies.
- [ ] Add API tests for authentication, validation, lifecycle operations, conflicts, redaction, cached catalog behavior, and failure codes.

### 11. Add `peon armory` CLI commands

- [ ] Add Armory commands and examples to CLI usage.
- [ ] Implement search, list, show, install, configure, verify, enable, disable, update, and uninstall through the daemon API only.
- [ ] Add `--json` to read-only output and terminal operation results.
- [ ] Poll asynchronous operations, print phase changes once, and map success/failure/needs-human to documented exit codes.
- [ ] Generate configure prompts from the package schema and use hidden input for every `secret` field.
- [ ] Support configuration files by reading a prompted local path and streaming content without logging it.
- [ ] Require explicit `--stdin` for non-interactive configuration JSON and never echo its content.
- [ ] Add `--purge` only to the operator CLI uninstall command, with an explicit path/configuration warning.
- [ ] Report the daemon control URL and connection error when unavailable; never edit Armory state directly as fallback.
- [ ] Add CLI tests for parsing, output, prompts, secret handling, operation polling, exit codes, and unreachable daemon.

### 12. Add Settings → Armory UI

- [ ] Add the Armory Settings tab and `/settings/armory` routing.
- [ ] Build catalog search plus Available/Installed filters.
- [ ] Build package cards with version, status, update, credential, OAuth, and host-write indicators.
- [ ] Preserve the installed view and show a cached/offline notice when GitHub catalog refresh fails.
- [ ] Build `/settings/armory/:id` detail with publisher, permissions, exact host paths, configuration status, runtime health, exposed tools, update state, and safe last error.
- [ ] Gate Install/Configure/Verify/Enable/Disable/Update/Uninstall actions by lifecycle state and display the reason for disabled actions.
- [ ] Render dynamic text, secret, select, and file fields with accessible labels and validation.
- [ ] Keep secret fields blank on load, show only configured metadata, and clear values after submit and component unmount.
- [ ] Add explicit host-write confirmation showing exact paths.
- [ ] Add operation progress polling and stop polling on unmount or terminal state.
- [ ] Add a Verify again action for configuration and runtime health.
- [ ] Add uninstall confirmation with a separate unchecked purge option and exact owned-path summary.
- [ ] Use existing React globals, primitives, API helpers, styling, and routing conventions; add no frontend build system.
- [ ] Verify responsive layout, keyboard navigation, focus restoration, error announcements, and loading/empty/offline states.

### 13. Recovery, security, and observability pass

- [ ] Audit every filesystem join and deletion for containment under the expected package, staging, home, or ownership-ledger root.
- [ ] Audit every process spawn for shell avoidance, executable provenance, controlled environment, timeout, output bounds, and kill behavior.
- [ ] Audit API, CLI, operation, logger, child stderr, MCP errors/results, and UI state for secret exposure.
- [ ] Add startup reconciliation for active versions, orphan children, stale locks, abandoned staging, and interrupted operations.
- [ ] Add bounded redacted logs keyed by package and operation.
- [ ] Add package crash counters/backoff and stop restart loops after a threshold while leaving the daemon healthy.
- [ ] Add status/diagnostic output sufficient to distinguish catalog, configuration, hook, MCP startup, and MCP call failures.
- [ ] Document that official packages inherit the Peon user's OS privileges and are not sandboxed.
- [ ] Document that packages requiring external or root-installed executables are unsupported in V1.
- [ ] Document the GitHub repository write-access, maintainer-machine, and release-credential trust boundaries, including the lack of enforced review/CI and the limitations of checksum-only authenticity.

### 14. End-to-end release gate

- [ ] Start from an empty isolated XDG environment and install `fixture-echo` through the CLI, call its tool through Peon's MCP, disable it, update it, roll it back under induced failure, and uninstall it.
- [ ] Install `fixture-configured` through Overseer, submit credentials, verify it, use its MCP tool, uninstall without purge, reinstall with preserved config, then purge and verify owned files are gone.
- [ ] Restart the daemon during download, extraction, configuration, active MCP runtime, update, and uninstall; verify deterministic safe recovery.
- [ ] Run the full existing and new `npm test`, `npm run typecheck`, and `npm run compile` checks.
- [ ] Verify Heroboard polling/task sessions, manual sessions, project setup, publication, Claude Code, Codex, operator authentication, and existing CLI commands have no regression.
- [ ] Publish V1 documentation for operators and a package-author guide for the official Armory repository.
- [ ] Do not publish a real provider package until the fixture release gate passes on supported macOS and Linux targets.

## Testing requirements

Create a deterministic fixture registry and at least two fixture packages:

- a no-credential echo package exposing one MCP tool;
- a self-contained package with secret/text configuration fields.

Tests must not contact the public registry or real provider APIs.

### Unit tests

- manifest and registry validation;
- package/version/platform resolution;
- SHA-256 verification and mismatch handling;
- archive traversal, escaping symlink, duplicate path, and size-limit rejection;
- atomic installed-state persistence and malformed-state recovery;
- rejection of non-empty dependency declarations and external executable lookup;
- configuration schema validation and secret redaction;
- operation locking and valid state transitions;
- purge ownership ledger behavior;
- tool-name prefixing and collision rejection;
- timeout, output limit, and child crash handling.

### API tests

- catalog and installed status responses;
- asynchronous install/update/verify/uninstall operation flow;
- conflicts return `409` with stable codes;
- configuration values are never present in responses or operation files;
- enable is rejected until configuration and MCP are healthy;
- registry failure does not hide installed packages;
- uninstall preserves config; purge deletes only managed paths;
- remote unauthenticated callers cannot access Armory APIs under the existing auth model.

### MCP integration tests

- existing Peon project tools remain available;
- an enabled fixture package appears under its required prefix;
- calls are proxied and results preserved;
- disabled/uninstalled package tools disappear;
- package crashes, malformed messages, timeouts, and oversized results become safe MCP errors without crashing Peon;
- list-change notification is emitted after enable/disable;
- management tools obey install policy and never accept credentials/purge.

### CLI tests

- usage and argument validation;
- search/list/show formatting and `--json`;
- mutating commands poll operations and propagate terminal exit codes;
- secret configuration uses hidden prompts and is not printed;
- non-interactive configuration requires explicit `--stdin`;
- daemon-unavailable error identifies the control URL.

### Dashboard tests

Follow the repository's existing frontend test conventions if present. At minimum verify manually with fixture API data:

- catalog, filters, and registry-unavailable state;
- package detail and lifecycle action gating;
- dynamic configuration form and secret clearing;
- install/configure/verify/enable progress;
- uninstall confirmation and separate purge option;
- responsive layout and accessible labels/focus behavior.

Run `npm test`, `npm run typecheck`, and `npm run compile` before completion.

## Acceptance criteria

- [ ] Settings contains an Armory tab with catalog, installed status, package detail, configuration, lifecycle actions, and operation progress.
- [ ] The CLI implements the documented `peon armory` commands through the daemon API.
- [ ] Peon installs official registry packages transactionally with platform validation and digest verification.
- [x] V1 packages are self-contained and non-empty dependency declarations are rejected.
- [ ] Package-defined configuration forms support secret values without returning or logging them.
- [ ] Provider-specific files default to a package-managed home; host writes are declared and confirmed.
- [ ] Install, configure, verify, enable, disable, update/rollback, uninstall, purge, crash recovery, and conflict states behave as specified.
- [ ] Enabled package MCP servers run as supervised child processes and cannot crash the daemon.
- [ ] Agents receive one Peon MCP server containing existing Peon tools, Armory management tools, and namespaced enabled-package tools.
- [ ] Existing project setup, metadata, publication, Heroboard integration, Claude Code, and Codex flows continue to work.
- [ ] Agent MCP tools cannot submit credentials, purge configuration, bypass registry policy, or run arbitrary hooks.
- [ ] All new state is persisted atomically under the documented XDG directories.
- [ ] Tests cover lifecycle, API, CLI, credential redaction, archive safety, unified MCP proxying, and failure recovery.
- [ ] User-facing documentation explicitly states the trust boundary, tool-discovery caveat, managed-home behavior, and uninstall ownership rules.

## Suggested implementation slices

1. **Domain and storage:** manifest/index validation, XDG data path, installed state, operation model, registry client, fixture registry.
2. **Transactional lifecycle:** safe archive handling, hooks, configuration runner, verification, enable/disable/update/uninstall/recovery.
3. **MCP gateway:** package supervisor, tool aggregation/proxying, management tools, list-change events, session compatibility.
4. **Control API and CLI:** lifecycle/configuration endpoints, operation polling, complete `peon armory` command family.
5. **Dashboard:** Settings tab, catalog/detail screens, dynamic forms, progress, confirmations, error states.
6. **Hardening:** redaction audit, limits/timeouts, rollback and restart tests, documentation, end-to-end verification with fixture packages.

Each slice should land with tests and preserve all existing behavior. Do not begin with a real AWS or Google package; prove the lifecycle and secret handling with deterministic fixtures, then add the first production package as a separate task.
