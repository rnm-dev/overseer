# Overseer task: Armory marketplace browser

## Objective

Add a read-only Armory marketplace to Overseer, opened from the existing Armory pill. The marketplace must browse the official package catalog exposed by each connected Peon and show its local installed/configuration state.

This slice is presentation and discovery only. Do not add Install, Update, Enable, Disable, Verify, Configure, or Uninstall actions yet: Peon does not expose the complete lifecycle API.

## User outcome

An Overseer operator can:

1. Open the Armory marketplace from a Peon's Armory pill.
2. See available and installed packages for that Peon.
3. Search packages and switch between Available and Installed views.
4. Open a package detail view with catalog versions/platforms, requirements, local state, and safe configuration-field metadata.
5. Understand whether catalog data is live, cached, unavailable, or empty.
6. Inspect Armory registry policy without seeing credentials or configuration values.

## Peon API

Use the selected Peon's existing fleet API client and bearer/protocol headers. Do not call Peon directly from browser code if Overseer already proxies Peon requests server-side.

### Marketplace list

```text
GET /api/v1/armory/packages?q=&installed=&limit=&cursor=
```

Query parameters:

- `q`: optional case-insensitive catalog search.
- `installed`: optional `true`/`false` or `1`/`0`; use `true` for the Installed view and omit it for Available.
- `limit`: integer from 1 through 100.
- `cursor`: opaque `nextCursor` returned by the prior response. Never parse or construct it in Overseer.

Response shape:

```ts
interface ArmoryInventoryResponse {
  registry: {
    url: string;
    official: boolean;
    source: "live" | "cached" | "unavailable";
    fetchedAt: number | null;
    catalogUpdatedAt: string | null;
    error: { code: string; message: string } | null;
  };
  packages: ArmoryPackageSummary[];
  total: number;
  nextCursor: string | null;
}

interface ArmoryPackageSummary {
  id: string;
  available: boolean;
  displayName: string | null;
  iconUrl: string | null;
  summary: string | null;
  publisher: string | null;
  documentationUrl: string | null;
  latestVersion: string | null;
  requirements: {
    credentials: boolean;
    hostWrites: boolean;
  } | null;
  installed: {
    id: string;
    version: string;
    enabled: boolean;
    state: "installing" | "needs_configuration" | "verifying" | "ready" | "error" | "removing";
    installedAt: number;
    updatedAt: number;
    sourceDigest: string;
    configurationStatus: "not_required" | "missing" | "unverified" | "verified" | "invalid";
    lastError: string | null;
    activeOperationId: string | null;
  } | null;
  updateAvailable: boolean | null;
}
```

An installed package may remain in the response with `available: false` and null catalog presentation fields when the registry is unavailable or no longer lists it. Render a durable fallback based on `id` and installed state; do not hide it.

### Package detail

```text
GET /api/v1/armory/packages/:id
```

The response contains:

```ts
{
  registry: ArmoryInventoryResponse["registry"];
  package: ArmoryPackageSummary;
  catalog: {
    id: string;
    displayName: string;
    iconUrl?: string;
    summary: string;
    publisher: "rnm-dev";
    documentationUrl: string;
    latest: string;
    requirements: { credentials: boolean; hostWrites: boolean };
    versions: Array<{
      version: string;
      minPeonVersion: string;
      platforms: Array<{ os: "darwin" | "linux"; arch: "x64" | "arm64" }>;
      archive: { url: string; size: number; sha256: string };
    }>;
  } | null;
}
```

Treat `catalog: null` as a valid installed-only detail state.

### Configuration metadata

```text
GET /api/v1/armory/packages/:id/configuration
```

Response shape:

```ts
{
  packageId: string;
  fields: Array<{
    id: string;
    label: string;
    help?: string;
    type: "text" | "secret" | "select" | "file";
    required: boolean;
    options?: Array<{ value: string; label: string }>;
    validation?: { pattern?: string; maxLength?: number };
  }>;
  configured: Record<string, boolean>;
  hostWrites: string[];
}
```

This endpoint never returns configured values. Show only a neutral “Configured” marker derived from `configured[field.id]`. Never create placeholder or fake secret values. A `404 PACKAGE_NOT_ACTIVE` means the package is not installed/active; it is normal for a catalog-only package and should not show an error banner.

### Armory policy

```text
GET /api/v1/armory/settings
```

Response shape:

```ts
{
  registryUrl: string;
  effectiveRegistryUrl: string;
  registryOverridden: boolean;
  agentInstallAllowlist: string[];
}
```

Display a visible non-default registry notice when `registryOverridden` is true or the inventory reports `official: false`. This slice must not mutate these settings.

### Errors

Peon errors use:

```ts
{ error: string; code: string }
```

Preserve the stable `code` in Overseer's server/client error model. Show the safe `error` message to the operator where actionable.

## UI requirements

### Armory pill

- Keep the existing pill styling and navigation conventions.
- Clicking the pill opens the marketplace scoped to the selected Peon.
- Show the inventory `total` when known.
- Do not imply packages can be installed in this slice.

### Marketplace screen

- Header: “Armory”, selected Peon identity, search input, Available/Installed filters.
- Package cards: display name with ID fallback, summary, publisher, installed/latest versions, and compact status badges.
- Render `iconUrl` as a square package icon with a consistent fixed size and rounded treatment matching Overseer. Preserve the image's aspect ratio with `object-fit: cover`; never stretch it.
- If `iconUrl` is null, fails to load, or is blocked, render a deterministic square fallback derived from display name/ID. Broken images must not shift card layout.
- Status badges should distinguish Not installed, Installed, Needs setup, Ready, Enabled, Error, and Update available using the returned fields.
- Paginate with `nextCursor`; reset pagination when search, filter, or selected Peon changes.
- Debounce search and cancel/ignore stale requests so results from a previous Peon/query cannot overwrite current state.

### Package detail

- Show description, publisher, documentation link, requirements, installed state, safe last error, configuration status, and update availability.
- Show all catalog versions and supported OS/architecture pairs.
- Show configuration fields read-only, including help text, type, required marker, configured marker, select choices, and host-write paths.
- Never render archive SHA-256 as a primary UI element; it may appear in a technical disclosure.
- Do not render configuration inputs or lifecycle buttons in this slice.

### Empty and degraded states

- `total: 0`, registry available: explain that the official catalog currently has no published packages. This is not a connection failure.
- `source: "cached"`: show a non-blocking cached-data notice with `fetchedAt`.
- `source: "unavailable"` with installed packages: keep installed packages visible and show a non-blocking registry warning.
- `source: "unavailable"` with no packages: show a retryable registry error state.
- Peon offline/unreachable: use Overseer's existing per-Peon connection error treatment.
- Switching Peons must clear stale package detail and pagination state.

## Out of scope

- Peon lifecycle mutations or fake action buttons.
- Configuration submission or secret handling.
- Armory settings mutation.
- Runtime/MCP health and exposed tool names; Peon does not expose them yet.
- Cross-Peon aggregation. Marketplace state is scoped to one selected Peon.
- Publishing packages into `rnm-dev/armory`.

## Tests

Add tests using mocked Overseer-to-Peon responses for:

- pill navigation and selected-Peon scoping;
- available and installed filters;
- debounced search and stale-request protection;
- cursor pagination and reset behavior;
- package detail with complete catalog metadata;
- square icon rendering plus null and load-error fallbacks;
- installed-only package with `catalog: null`;
- configuration fields showing configured metadata but no values;
- official empty catalog;
- cached registry notice;
- unavailable registry while installed packages remain visible;
- stable Peon error-code propagation;
- no lifecycle/configuration mutation requests emitted by this UI.

## Acceptance criteria

- [ ] The Armory pill opens a marketplace scoped to the selected Peon.
- [ ] Available and Installed views use the Peon Armory inventory API.
- [ ] Search and cursor pagination work without stale cross-query or cross-Peon results.
- [ ] Package detail renders full catalog versions/platforms and local installed state.
- [ ] Package cards and detail render square icons without layout shift and provide deterministic fallbacks.
- [ ] Package configuration metadata renders without values or editable controls.
- [ ] Empty, cached, unavailable, installed-only, and Peon-offline states are distinct and tested.
- [ ] No unsupported lifecycle or configuration mutations are shown or called.
- [ ] Existing Overseer navigation, responsive behavior, and accessibility conventions are preserved.
