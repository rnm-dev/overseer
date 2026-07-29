# Overseer task: Armory package configuration

## Objective

Add package-defined configuration forms to the existing Overseer Armory marketplace. An operator must be able to open an installed package that needs configuration, enter the fields declared by its Armory manifest, submit them to the selected Peon, and follow the asynchronous configure-and-verify operation to completion.

This task covers configuration only. Do not add install, update, enable, disable, uninstall, purge, registry-policy editing, or a separate manual verification action.

## User outcome

An Overseer operator can:

1. Open an installed Armory package on a selected Peon.
2. See whether it is missing, unverified, verified, or invalid configuration.
3. Render the package's declared `text`, `secret`, `select`, and `file` fields.
4. See which fields are already configured without receiving their stored values.
5. Submit configuration through Overseer's existing server-side Peon proxy.
6. Follow configure and verification progress until the operation succeeds or fails.
7. See the refreshed package state after completion.
8. Delete package configuration through an explicit confirmation flow.

The first real package is `heroboard`. Its form contains one required `secret` `apiKey` field. A successful submission runs both its configure and verify hooks and changes the package from `needs_configuration` to `ready` with `configurationStatus: "verified"`.

## Peon API

Use the selected Peon's existing fleet API client and bearer/protocol headers. Browser code must call Overseer, not a Peon directly.

### Read configuration schema

```text
GET /api/v1/armory/packages/:id/configuration
```

Response:

```ts
interface ArmoryConfigurationSchema {
  packageId: string;
  fields: Array<{
    id: string;
    label: string;
    help?: string;
    type: "text" | "secret" | "select" | "file";
    required: boolean;
    options?: Array<{ value: string; label: string }>;
    validation?: {
      pattern?: string;
      maxLength?: number;
    };
  }>;
  configured: Record<string, boolean>;
  hostWrites: string[];
}
```

The response never contains configured values. `configured[field.id] === true` means only that a stored value exists.

Relevant stable errors:

- `404 PACKAGE_NOT_ACTIVE`: the package is not actively installed.
- `400 MANIFEST_INVALID`: the active package manifest cannot be read or validated.

### Submit configuration

```text
PUT /api/v1/armory/packages/:id/configuration
Content-Type: application/json

{
  "values": Record<string, string>,
  "confirmHostWrites"?: boolean
}
```

Success returns `202`:

```ts
{
  operation: {
    id: string;
    packageId: string;
    kind: "configure";
    status: "queued" | "running" | "success" | "failure" | "needs_human";
    phase: string;
    progress: number | null;
    message: string;
    errorCode: string | null;
    startedAt: number | null;
    finishedAt: number | null;
  };
}
```

The submitted values and secret fields must never appear in the response, client logs, analytics, query strings, URLs, notifications, error reports, or persisted Overseer state.

Configuration submission automatically runs the package's configure hook and optional verify hook. Peon does not currently expose a separate manual `POST .../verify` route, so do not render a standalone Verify button in this task.

Relevant stable errors include:

- `400 CONFIGURATION_FIELD_REQUIRED`
- `400 CONFIGURATION_FIELD_UNKNOWN`
- `400 CONFIGURATION_FIELD_INVALID`
- `400 CONFIGURATION_NOT_SUPPORTED`
- `400 HOST_WRITE_CONFIRMATION_REQUIRED`
- `400 HOST_PATH_PREEXISTS`
- `404 PACKAGE_NOT_ACTIVE`
- `409 OPERATION_IN_PROGRESS`

Display the safe Peon error message and preserve the entered form values after an immediate validation failure. Clear `secret` and `file` values after the request is accepted or when the operator leaves the package.

### Poll operation

```text
GET /api/v1/armory/operations/:operationId
```

Response:

```ts
{ operation: ArmoryOperation }
```

Poll while status is `queued` or `running`. Stop on `success`, `failure`, or `needs_human`, on Peon selection change, on package change, and when the view unmounts. Use bounded polling with the existing Overseer conventions; do not create overlapping requests.

On terminal completion, refetch:

```text
GET /api/v1/armory/packages/:id
GET /api/v1/armory/packages/:id/configuration
```

Do not infer final package state solely from the operation response.

### Delete configuration

```text
DELETE /api/v1/armory/packages/:id/configuration
Content-Type: application/json

{
  "includeHost"?: boolean,
  "confirmHostWrites"?: boolean
}
```

Success returns `202` with a `delete_configuration` operation. The default action must omit both flags and delete only Armory-managed configuration while disabling the package. If `hostWrites` is non-empty, list the exact declared paths and require a separate explicit confirmation before sending `includeHost: true` and `confirmHostWrites: true`.

This action deletes configuration, not the installed package.

## UI behavior

### Package detail

Add a Configuration section to the installed-package detail view.

Render a status treatment for:

- `missing`: configuration is required;
- `unverified`: configuration exists but has not passed verification;
- `verified`: configuration is ready;
- `invalid`: the last configure or verify attempt failed;
- `not_required`: no form is required.

Use the package detail's `installed.configurationStatus` as the lifecycle status and the configuration endpoint's `configured` map only for per-field markers.

Catalog availability must not gate configuration. A locally installed package with `available: false` and `catalog: null` is still configurable from its active manifest. This is currently the normal state for the locally installed Heroboard package until its release is published to the official catalog.

### Field rendering

- `text`: ordinary text input.
- `secret`: password-style input with no prefilled value and no fake placeholder value.
- `select`: select control populated only from the declared options.
- `file`: file picker whose selected file is read into the submitted string value. Enforce `validation.maxLength` before submission and do not retain file contents after acceptance or navigation.
- `required`: show the existing required-field treatment and validate non-empty values before submission.
- `help`: render adjacent accessible help text.
- `validation.pattern`: use for client feedback, but treat Peon validation as authoritative. Handle malformed patterns defensively without breaking the page.
- `configured[field.id]`: show a neutral “Configured” marker. Never synthesize or retrieve the stored value.

For an already configured `secret` field, leaving the new input empty means no replacement value was supplied. Because Peon's current configure API validates the complete submitted configuration rather than patching individual fields, require all required fields on every submission and explain that secrets must be re-entered when updating configuration.

### Host-write confirmation

When `hostWrites` is non-empty:

1. Show the exact paths before submission.
2. Explain that the package may write outside its managed Armory home.
3. Require an unchecked-by-default confirmation control.
4. Send `confirmHostWrites: true` only after confirmation.

Do not infer or shorten filesystem paths.

### Operation progress

After a `202` response:

- disable duplicate submission and deletion actions;
- show the operation phase, safe message, and determinate progress when non-null;
- allow navigating away without leaving background timers behind;
- recover display state from the operation endpoint if the package detail remains open;
- show terminal failure with `errorCode` and safe message;
- on success, clear all form values and refresh package/configuration state.

## Security requirements

- Never expose Peon bearer credentials to browser code if Overseer already proxies Peon requests server-side.
- Never log configuration request bodies.
- Never place configuration values in URLs, cache keys, telemetry, toasts, exception metadata, or persisted client state.
- Mark configuration proxy responses and pages containing entered secrets as non-cacheable where applicable.
- Ensure generic request-debug tooling redacts `values` recursively.
- Do not echo a submitted value in client-side validation messages.
- Cancel stale requests when switching Peons or packages so one Peon's configuration state cannot appear under another Peon.
- Preserve Peon's stable error codes instead of replacing them with generic server errors.

## Empty and degraded states

- Package not installed: do not show a form; present the existing installed-state treatment.
- No declared fields and `not_required`: show “No configuration required.”
- Peon offline: use Overseer's existing selected-Peon connection error treatment.
- Schema request failure: show a retry action without losing package detail.
- Operation polling interrupted: keep the operation ID in in-memory view state and offer Retry status; never resubmit configuration automatically.
- Package/catalog absent but installed locally: continue using configuration metadata from Peon.

## Tests

Add tests with mocked Overseer-to-Peon responses for:

- Heroboard's required secret `apiKey` form;
- text, secret, select, and file field rendering;
- configured markers without values or fake secret placeholders;
- required, select-option, pattern, and maximum-length validation;
- submission through the selected Peon's server-side proxy;
- no submitted values in rendered output, logs, URLs, telemetry, or stored state;
- `202` operation progress from queued through configure/verify to success;
- terminal operation failure with stable error code;
- `409 OPERATION_IN_PROGRESS` preventing duplicate submission;
- refresh of package detail and configuration metadata after success;
- configuration of an installed-only package with `catalog: null`;
- Peon/package switching canceling stale schema and polling requests;
- ordinary managed configuration deletion;
- exact host-write warning and explicit confirmation behavior;
- no install, enable, disable, update, uninstall, purge, or standalone verify action added by this task.

## Acceptance criteria

- [ ] Installed package detail renders configuration status and manifest-defined fields.
- [ ] Heroboard renders one required secret API-key field while exposing no stored value.
- [ ] Forms work for installed-only packages even when the package is absent from the catalog.
- [ ] Configuration is submitted only through Overseer's authenticated Peon proxy.
- [ ] Accepted submissions show asynchronous configure/verify progress and refresh terminal state.
- [ ] `secret` and `file` values are cleared after acceptance and never logged, persisted, echoed, or placed in URLs.
- [ ] Configured markers reveal only boolean presence.
- [ ] Host writes require exact-path disclosure and explicit confirmation.
- [ ] Configuration deletion has a separate confirmation flow and does not uninstall the package.
- [ ] Stable Peon validation and operation errors are rendered safely.
- [ ] Stale requests and polling are canceled across Peon/package navigation.
- [ ] Tests cover field rendering, security boundaries, async progress, installed-only state, deletion, and degraded states.
