# Armory V1 contracts

Status: frozen for schema version 1. Changes that make an existing valid document
invalid, change lifecycle meaning, or weaken a security boundary require a new
schema or protocol version. Additive implementation details may be introduced only
where this contract explicitly permits them.

## Registry identity and trust boundary

- The official source repository is `rnm-dev/armory`.
- The compiled default catalog URL is
  `https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json`.
- Operators may override it with the `registryUrl` daemon setting or the
  `PEON_ARMORY_REGISTRY_URL` environment variable (environment wins). Overrides
  are development/test inputs in V1 and must be labelled non-official in operator
  surfaces.
- The root catalog, package manifest, and hook protocol each use the integer
  `schemaVersion`/`protocolVersion` value `1`. No other value is accepted by V1.
- Official packages are publisher-controlled, trusted code running as the Peon OS
  user. Maintainers publish them manually; V1 has no required pull requests, branch
  protection, or CI checks. Child processes provide lifecycle isolation, not a
  security sandbox.
- Installed state and enablement are global to the Peon instance in V1. Package
  identity is still the unscoped `(id, version)` pair so a future project loadout
  can select from global installations without redefining identity.

The exact host policy for the compiled official registry is:

| Use | Allowed HTTPS host |
| --- | --- |
| Catalog fetch | `raw.githubusercontent.com` |
| Documentation URL | `github.com` |
| Release archive URL presented by the catalog | `github.com` |
| Redirect target while downloading a release | `release-assets.githubusercontent.com`, `objects.githubusercontent.com`, or `github-releases.githubusercontent.com` |

Host comparison is case-insensitive after URL parsing. User information, non-HTTPS
schemes, non-default ports, IP literals, encoded hostnames, and subdomain suffix
matches are rejected. The default catalog path must be exactly the compiled URL;
archive URLs must use `/rnm-dev/armory/releases/download/`; documentation URLs must
remain below `/rnm-dev/armory/`. Development registry overrides are operator-side
settings and are visibly non-official; an agent cannot set or change one.

## Common lexical types

- `PackageId`: `^[a-z0-9][a-z0-9-]{0,62}$`.
- `ToolPrefix`: `^[a-z][a-z0-9_]{0,62}$`.
- `FieldId`: `^[A-Za-z][A-Za-z0-9_]{0,62}$`.
- `SemanticVersion`: a complete SemVer 2.0.0 version without a leading `v`,
  surrounding whitespace, or a partial/wildcard form. Prereleases and build
  metadata use the SemVer grammar; prereleases are valid only when explicitly
  requested or referenced, and `latest` must reference a stable version.
- `CompatibilityRange`: a non-empty npm/node-semver range of at most 256 UTF-8
  bytes. URLs, Git references, dist-tags, and empty/`*` ranges are rejected.
- `RelativePackagePath`: a non-empty POSIX relative path. It cannot contain an
  empty, `.`, or `..` segment, a backslash, NUL, drive prefix, or leading slash.
- `Sha256`: exactly 64 lowercase hexadecimal characters.
- `Platform`: `{ os: "darwin" | "linux"; arch: "x64" | "arm64" }`.

IDs and versions are compared byte-for-byte after validation; they are never
case-folded or normalized. Unknown object fields are rejected throughout V1.

## Catalog contract

```ts
interface ArmoryCatalogV1 {
  schemaVersion: 1;
  name: "rnm-dev/armory";
  updatedAt: string; // RFC 3339 UTC instant
  packages: ArmoryCatalogPackageV1[];
}

interface ArmoryCatalogPackageV1 {
  id: PackageId;
  displayName: string;
  iconUrl?: string; // approved square PNG/WebP marketplace asset
  summary: string;
  publisher: "rnm-dev";
  documentationUrl: string;
  latest: SemanticVersion;
  requirements: {
    credentials: boolean;
    hostWrites: boolean;
  };
  capabilities: { mcp: boolean };
  versions: ArmoryCatalogVersionV1[];
}

interface ArmoryCatalogVersionV1 {
  version: SemanticVersion;
  minPeonVersion: SemanticVersion;
  platforms: Platform[];
  archive: ArmoryArchiveV1;
}

interface ArmoryArchiveV1 {
  url: string;
  size: number; // positive safe integer, not greater than MAX_ARCHIVE_DOWNLOAD_BYTES
  sha256: Sha256;
}
```

Package IDs are unique, versions are unique within a package, platforms are unique
within a version, and `latest` names one listed stable version. `minPeonVersion` is
an inclusive minimum, not a range. Catalog order is presentation order and has no
precedence meaning.

## Package manifest contract

```ts
interface ArmoryManifestV1 {
  schemaVersion: 1;
  id: PackageId;
  version: SemanticVersion;
  minPeonVersion: SemanticVersion;
  platforms: Platform[];
  permissions: ArmoryPermissionsV1;
  dependencies: [];
  configuration?: ArmoryConfigurationV1;
  lifecycle?: {
    postInstall?: ArmoryCommandV1;
    preUninstall?: ArmoryCommandV1;
  };
  mcp?: {
    command: ArmoryCommandV1;
    toolPrefix: ToolPrefix;
    startupTimeoutMs?: number;
    callTimeoutMs?: number;
  };
}

interface ArmoryPermissionsV1 {
  networkHosts: string[];
  hostPaths: Array<{
    path: string;
    mode: "read" | "write";
    purpose: string;
  }>;
}

interface ArmoryCommandV1 {
  executable: "node" | RelativePackagePath;
  args: string[];
}
```

`mcp` is an optional capability. Packages that omit it may still provide
configuration or lifecycle behavior, but Peon never mounts them into agent MCP
configuration. Catalog summaries expose `capabilities: { mcp: boolean }`, and
installation rejects a manifest whose MCP presence disagrees with that catalog bit.

`networkHosts` contains lowercase ASCII DNS names or a single-label wildcard such
as `*.example.com`, without schemes, ports, paths, IP literals, or a bare `*`.
`hostPaths` are absolute paths or `~/` paths resolved against the daemon user's real
home. They must be declared before use, displayed exactly after resolution, and are
never implicit permission to write. Duplicate permission entries are rejected.

`node` resolves to `process.execPath`; a relative executable is contained in the
active package directory. Arguments are literal strings. Commands never use a shell,
search the operator's `PATH`, or contain credentials.

The manifest and catalog must agree on ID, version, minimum Peon version, platforms,
and summarized requirements. `credentials` means at least one secret, file, or required
configuration field, and `hostWrites` reflects at least one write-mode host path.

### Configuration fields

```ts
interface ArmoryConfigurationV1 {
  fields: ArmoryConfigurationFieldV1[];
  handler: ArmoryCommandV1;
  verifyHandler?: ArmoryCommandV1;
  managedPaths: RelativePackagePath[];
  environment?: Record<string, RelativePackagePath>;
}

interface ArmoryConfigurationFieldV1 {
  id: FieldId;
  label: string;
  help?: string;
  type: "text" | "secret" | "select" | "file";
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  validation?: { pattern?: string; maxLength?: number };
}
```

Field IDs and select option values are unique. `options` is required only for
`select` and must be non-empty. `secret` and `file` fields are intrinsically redacted
during hook execution and transport. Patterns are
ECMAScript regular-expression sources of at most 512 UTF-8 bytes, without flags;
`maxLength` is a positive safe integer no greater than 1 MiB. `managedPaths` and
environment values resolve beneath the package managed home. Environment keys must
match `^[A-Z][A-Z0-9_]{0,127}$` and cannot replace Peon's reserved `PEON_ARMORY_*`
variables or `PATH`.

### Bundled runtime dependencies

V1 manifests must declare `dependencies: []`. Packages bundle all runtime libraries
and executables into their immutable release archive for each supported platform.
Peon does not discover external executables, download shared tools, invoke system
package managers, or maintain dependency ownership/reference state. Packages that
require an external or root-installed executable are unsupported in V1.

## Hook protocol contract

Peon writes exactly one NDJSON input line and closes stdin. A hook writes zero or
more progress lines and exactly one final result line. Every line has
`protocolVersion: 1`; unknown fields or message types are rejected.

```ts
interface ArmoryHookPackageV1 {
  id: PackageId;
  version: SemanticVersion;
  dir: string;
  home: string;
}

type ArmoryHookInputV1 = {
  protocolVersion: 1;
  type: "input";
  operation: "post_install" | "configure" | "verify" | "pre_uninstall";
  package: ArmoryHookPackageV1;
  platform: Platform;
  configuration?: Record<FieldId, string>;
};

interface ArmoryHookProgressV1 {
  protocolVersion: 1;
  type: "progress";
  phase: string;
  message: string;
  percent: number | null; // integer 0..100 when non-null
}

interface ArmoryHookResultV1 {
  protocolVersion: 1;
  type: "result";
  ok: boolean;
  message: string;
  errorCode?: string;
  ownedPaths?: string[];
}
```

`configuration` is required only for `configure` and must contain exactly the
validated submitted fields. It is never persisted in an operation. `errorCode` is
required when `ok` is false and forbidden when true. `ownedPaths` is allowed only
on a successful `post_install` or `configure` result and must be unique. A relative
value is resolved beneath the managed home; an absolute or `~/` value must be
contained by a write-mode manifest host path confirmed for this operation. Every
resolved path must be declared and pass containment checks before it reaches the
ownership ledger.
Progress and result strings are safe display text after recursive secret redaction.
EOF before a result, output after a result, multiple results, malformed JSON,
non-zero exit, or a limit violation fails the operation.

## Resource limits

These are inclusive V1 hard maxima. Package-provided timeout overrides may only
lower the relevant limit.

| Constant | Value |
| --- | ---: |
| `MAX_CATALOG_BYTES` | 4 MiB |
| `MAX_ARCHIVE_DOWNLOAD_BYTES` | 256 MiB |
| `MAX_ARCHIVE_EXPANDED_BYTES` | 1 GiB |
| `MAX_ARCHIVE_FILE_COUNT` | 10,000 |
| `MAX_HOOK_OUTPUT_BYTES` | 1 MiB total stdout and 1 MiB total stderr |
| `MAX_MCP_RESULT_BYTES` | 16 MiB |
| `MAX_MCP_STARTUP_MS` | 15,000 ms |
| `MAX_LIFECYCLE_MS` | 120,000 ms |
| `MAX_TOOL_CALL_MS` | 60,000 ms |

Catalog fetches time out after 15 seconds and permit at most three redirects.
Archive downloads time out after 5 minutes and permit at most five redirects. All
byte limits apply while streaming even when `Content-Length` is absent or false.
Expanded-byte and file-count limits apply before each archive entry is written.

## Policy and destructive operations

V1 settings contain an operator-managed `agentInstallAllowlist: PackageId[]`. Its
secure default is the empty array, so agent-initiated installation is denied until
an operator names a package from the official registry. The setting cannot contain
wildcards and cannot be changed through MCP. Search/get, enable, disable, and
non-purging uninstall remain subject to their separately defined readiness and
authorization rules; allowlisting a package grants installation only.

Armory never runs `sudo`, accepts a sudo password, invokes `apt`, `dnf`, `yum`,
`pacman`, Homebrew, or another system package manager on the operator's behalf, or
exposes privileged installation through MCP. Packages that require those facilities
are rejected as unsupported in V1.

Ordinary uninstall removes package-owned runtime content while preserving the
managed home and stored configuration. Only an explicit operator-side `purge` from
the authenticated control API, Overseer, or CLI may remove stored credentials and
paths proven by the ownership ledger to belong to that package. MCP uninstall can
never purge. Undeclared or pre-existing user files are never removed.

Per-project enablement/loadouts, signed community registries, OS keychain storage,
OAuth flows, and external dependency installation are explicitly outside V1.
