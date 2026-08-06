# Armory profiles and project packages

`armory-project-packages-v1` defines reusable typed profiles and the packages
assigned to each project. Its normative machine-readable
[schema](protocol/armory-project-packages-v1/schema.json) and
[fixtures](protocol/armory-project-packages-v1/fixtures.json) are executable
documentation. Production services do not fetch or load them at runtime.

OVSR-356 defines this contract. OVSR-357 through OVSR-361 implement and roll it
out. Peon must not advertise the capability before storage, runtime injection
and every advertised Fleet HTTP route work together.

## Model

Installation and project availability are separate:

- An installed package means verified package code is present on the Peon.
- A profile is a Peon-wide named configuration record with a string `type`,
  such as `google-service-account`. Stored values are write-only.
- A project/package assignment is the only availability switch for that
  package in that project.

There is no package `enabled` field or enable/disable operation. An unassigned
package contributes no MCP process, tools, descriptions, package instructions,
configuration or credentials to a new turn.

Profiles are not package-scoped. A package manifest that needs configuration
declares one accepted profile type and its required field IDs. The same profile
may be assigned to any number of projects and installed packages declaring
that exact type. Assignment validates exact type equality, verified status and
the presence of every field required by the target package.

A credential-free package declares no profile requirement and is assigned with
`profileId: null`. Null is not a default or sentinel profile. A package that
requires a profile rejects null, and a credential-free package rejects a
non-null profile.

## Safe resources

A safe profile contains only:

```json
{
  "profileId": "57ba5e9e-3ed2-4a92-919f-9f60ee69a450",
  "type": "google-service-account",
  "name": "Production Google",
  "status": "verified",
  "configuredFields": { "serviceAccountJson": true }
}
```

`configuredFields` contains booleans only. Reads, logs, errors, projections and
transcripts never contain submitted values, hashes, lengths, prefixes or other
credential oracles.

An assignment is deliberately small:

```json
{
  "projectId": "87b68e30-a923-48b4-9a58-f561a2390083",
  "packageId": "google-drive",
  "profileId": "57ba5e9e-3ed2-4a92-919f-9f60ee69a450"
}
```

Profiles have stable UUIDs. Types are lowercase bounded strings matching
`^[a-z][a-z0-9.-]{0,63}$`. Names are operator-facing and need not identify a
package. Two profiles may have the same type.

## Manifest declaration

A package that needs a profile declares the type and fields it consumes in its
configuration manifest. For example:

```json
{
  "profile": {
    "type": "google-service-account",
    "requiredFields": ["serviceAccountJson"]
  }
}
```

The existing manifest field definitions remain the configuration form and
validation authority. Packages sharing a type use the same semantic field IDs.
V1 does not add a central profile-type registry, inheritance or schema
negotiation. A package cannot read a profile merely because it declares the
same type: Peon supplies values only when an operator assigns that exact
profile to that package in that project.

## Operator surface

Assignment lives in the project's **Tools** tab (`/peons/:peonId/projects/:key/tools`),
whose **Armory** section lists every installed package and the profile it uses in
this project. The earlier `/packages` path redirects there.

One dropdown per package is the whole control, and choosing in it is the
mutation. **Disabled** is the unassigned state and issues `DELETE`; any profile
issues `PUT` immediately. A credential-free package's dropdown is
Disabled/**Enabled**, where Enabled assigns `profileId: null`. There is no
assign, update or remove button and no removal dialog — the section's standing
note explains that a change only affects the project's next turns. The
profile dropdown also offers **Add new profile…**, which opens
`/tools/new-profile?package=<packageId>`: a form that takes a name plus the
package's configuration fields and then creates, configures, verifies and
assigns the profile in one pass. Values stay write-only and are scrubbed after
each settled attempt; a failed configure or verify leaves the created profile
for the Peon's Armory page to finish rather than assigning it.

## Fleet HTTP routes

All reads and mutations use authenticated direct Fleet HTTP. Overseer relays
them and stores no profile or assignment authority.

Profiles:

- `GET|POST /api/v1/armory/profiles`
- `PATCH|DELETE /api/v1/armory/profiles/:profileId`
- `PUT /api/v1/armory/profiles/:profileId/configuration`
- `POST /api/v1/armory/profiles/:profileId/verify`

Assignments:

- `GET /api/v1/armory/projects/:projectId/assignments`
- `PUT|DELETE /api/v1/armory/projects/:projectId/assignments/:packageId`

Lists are bounded to 100 records; V1 does not add cursor pagination. Existing
Fleet HTTP actor attribution, `Peon-Request-Id`, package locks, durable
configuration operations and safe-error rules apply unchanged. This contract
does not define another idempotency ledger, global revision or generic
optimistic-concurrency system.

Deleting a profile referenced by any assignment returns `409 PROFILE_IN_USE`.
The operator must reassign or remove those package assignments first. V1 does
not provide an atomic mass-reassignment request.

## Turn behavior

Peon reads the selected project's assignments before assembling a new provider
turn. Only assigned packages are resolved and injected. The chosen profile and
installed artifact are fixed for that turn; later changes affect the next
turn. This is an implementation invariant rather than another public snapshot
resource.

Runtime reuse must not carry one profile's environment into a turn assigned to
another profile. If committed state is corrupt or cannot be resolved, Peon
fails before agent launch instead of silently falling back to another profile.

## Migration

Migration is atomic and retryable:

1. For every legacy package configuration, create one typed profile using the
   profile type declared by that installed package. Name it after the package
   so the operator can recognize its origin.
2. Do not attempt to compare or deduplicate secret values. Operators may later
   replace several migrated profiles with one shared profile.
3. For every existing project, assign every legacy-enabled installed package.
   Use its migrated profile when required, or null for a credential-free
   package.
4. Create no assignment for a legacy-disabled package.
5. Remove the old enable/disable state after the migration commits.

New projects and newly installed packages create no assignments. Legacy
enable/disable calls against a capable Peon return bounded `410
ARMORY_ACTIVATION_RETIRED` without changing state. Legacy configuration routes
may temporarily address the migrated profile created for that package, but are
compatibility aliases rather than another store.

If an installed legacy package requires configuration but does not declare a
profile type, migration stops with a safe actionable error. It must not invent
a type or discard credentials.

## Stable failures

The public contract needs only feature-specific failures; existing generic
Armory and Fleet failures remain unchanged.

| Status | Code | Meaning |
| --- | --- | --- |
| 404 | `PROJECT_NOT_FOUND` | Immutable project ID is unknown. |
| 404 | `PACKAGE_NOT_INSTALLED` | Assignment target is not installed. |
| 404 | `PROFILE_NOT_FOUND` | Selected profile does not exist. |
| 409 | `PROFILE_IN_USE` | Delete would strand assignments. |
| 409 | `PROFILE_TYPE_MISMATCH` | Profile type differs from the package declaration. |
| 409 | `PROFILE_FIELDS_MISSING` | Required fields are not configured. |
| 409 | `PROFILE_NOT_VERIFIED` | Package requires a verified profile. |
| 409 | `PACKAGE_NOT_READY` | Installed package cannot back an assignment. |
| 409 | `UNSUPPORTED_CAPABILITY` | Peon has not advertised this contract. |
| 410 | `ARMORY_ACTIVATION_RETIRED` | Legacy enable/disable has no effect. |

Errors remain bounded and redacted. Hook output and submitted values cannot be
copied into an error.

## Deliberately left out of V1

- profile-type registry or inheritance;
- default profiles and implicit assignment;
- package or project enable/disable flags;
- global binding revisions and custom compare-and-swap;
- a second request-id/idempotency design;
- cursor pagination for small bounded lists;
- atomic mass reassignment;
- user-, workspace-, environment- or session-scoped profiles;
- runtime fetching of schemas from docs or a website.
