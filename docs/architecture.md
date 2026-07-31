# Overseer architecture

Overseer is a modular monolith. Backend and frontend code are organized around
product capabilities, with explicit module boundaries, rather than around a
global stack of controllers, services, and repositories.

The architecture is intentionally evolutionary: existing code moves into the
target structure when it is changed. Large directory-only rewrites are avoided.

## Backend structure

```text
src/
  app/                    # process bootstrap and application composition
  infrastructure/
    db/                   # pool, transactions, migrations
    github/               # external GitHub integration
    peonHttp/             # outbound Peon HTTP client and stream proxies
    push/                 # notification delivery
    releases/             # release storage and publication
    voice/                # speech-to-text and text-polish provider seam
  modules/
    auth/
    access/
    fleet/
    presence/
    projects/
    sessions/
    voice/
    workspaces/
  shared/                 # small, domain-neutral primitives only
```

Domain modules such as `sessions` and `projects` live directly under `modules`.
They must not be grouped under abstract containers such as `catalogs`, because
the domain name already describes the capability and its ownership.

The current root-level files are legacy entry points. They may remain as thin
compatibility facades while callers migrate to a module's public entry point.

### Stable module taxonomy

The top-level taxonomy is deliberately small. New directories must fit one of
these ownership categories rather than being created for a single use case.

- `auth` owns users, devices, OAuth flows, web session cookies, native bearer
  authentication, and the cookie-authenticated CSRF boundary. Web credentials
  stay in a host-only HttpOnly cookie; native/mobile clients retain revocable
  device bearer tokens.
- `access` owns cross-resource authorization policies and grants.
- `fleet` owns Peon enrollment, registry state, and connection lifecycle.
- `presence` owns operator presence state and visibility.
- `projects` owns project projections, metadata, documentation, and membership.
  Browser file links use `/view/:peonId/:projectId/*`: workspace membership is
  derived server-side, bytes stream over authenticated Fleet HTTP, and active
  content is sandboxed away from the authenticated Overseer origin.
- `sessions` owns session projections, reconciliation, accepted-session indexing,
  queries, and session lifecycle rules.
- `voice` owns who may dictate and how much: workspace-membership admission and
  the rolling per-user request and audio quotas. The providers themselves are an
  external system and live in `infrastructure/voice`.
- `workspaces` owns workspaces, membership, and invitations.

Code that communicates with an external system or provides a technical runtime
facility belongs in `infrastructure`, not in a product module. In particular:

- `acceptedSession` is a sessions use case and should move into `sessions`;
- `projectDocs` belongs to `projects`;
- `peonClient` is an outbound transport and should become `infrastructure/peonHttp`;
- connection adapters and WebSocket protocol state machines may remain near app
  composition until a precise `fleet` or infrastructure owner is established.

These are migration destinations, not instructions for a directory-only rewrite.

## Module contract

Every domain module has one public entry point:

```text
modules/sessions/
  index.ts
  sessionTypes.ts
  sessionNormalization.ts
  sessionProjection.ts
  sessionQueries.ts
```

Code outside the module imports from `modules/sessions/index.ts`, never from an
internal implementation file. Internal files may import each other directly.
Avoid barrel files below the module root.

Modules own their domain types, validation, persistence operations, and use
cases. HTTP routes and WebSocket adapters translate transport input and call the
module API; they do not duplicate domain rules or write module tables directly.

## Dependency direction

```text
app -> routes/adapters -> modules -> infrastructure
                              \----> shared
```

- `app` composes the process and transports.
- Transport adapters may depend on public module APIs.
- A module must not import an HTTP route or React component.
- Infrastructure must not depend on product modules.
- Cross-module calls use the target module's public entry point.
- A module must not reach another module through a root compatibility facade.
  For example, use `../workspaces/index.js`, not `../../workspaces.js`.
- Root compatibility facades are for unmigrated root-level callers only. They
  must not become a permanent indirection layer between modules.
- Cyclic runtime dependencies are not allowed. Shared type contracts should be
  moved to the module that owns them or to a small domain-neutral contract file.

Direct module-to-database access is allowed. A repository class is not required
when a few named functions provide a clearer boundary.

## Naming

- Domain directories use plural nouns: `sessions`, `projects`, `workspaces`.
- TypeScript files use camelCase: `sessionProjection.ts`.
- React components use PascalCase: `SessionHeader.tsx`.
- React hooks start with `use`: `useSessionMetadata.ts`.
- Domain types stay with their owner: `sessionTypes.ts`, not a global `types.ts`.
- Tests are colocated with the implementation: `sessionQueries.test.ts`.
- `index.ts` is reserved for a module's public API.
- Names such as `utils`, `helpers`, `common`, and `manager` require a narrower,
  responsibility-based replacement before new code is added.

Use names that describe ownership rather than an implementation pattern:
`sessionProjection` owns the local materialized session projection;
`sessionQueries` reads it; `sessionNormalization` protects its input boundary.

The suffix `Service` is allowed only while a file represents one cohesive
capability. Split it when the name hides multiple independently changing areas.
Prefer ownership-specific names such as `workspaceMembership`,
`workspaceInvitations`, `peonHttpClient`, `peonStreamProxy`, and
`peonFileProxy` over increasingly broad service files.

## Functions and classes

Use functions by default for transformations, queries, route registration, and
stateless use cases. Use a class only when one instance owns a meaningful
lifecycle or state machine, such as a socket connection, protocol synchronizer,
or transfer session.

Do not create classes merely to group static functions or to mirror a filename.
Names such as `SessionService` and `WorkspaceManager` are too broad unless the
object has a precise lifecycle and responsibility.

## Frontend structure

Frontend code follows the same feature-first rule:

```text
apps/web/src/
  app/                    # routes and provider composition
  features/
    auth/
    armory/
    projects/
    sessions/
    settings/
    workspaces/
  realtime/               # transport and protocol adapters
  shared/                 # UI primitives, API client, i18n, generic hooks
```

Page components coordinate feature hooks and components. Protocol state,
request orchestration, and reusable domain transformations belong in dedicated
feature modules rather than in route components.

The frontend has not completed this directory migration. Its existing
`pages/peon/session` feature grouping is a valid intermediate state; new logic
should deepen feature ownership instead of adding more state to route components.

## Architecture fitness checks

The architecture must eventually be enforced by lint or tests rather than by
documentation alone. Checks should reject:

- imports of a module's internal files from outside that module;
- imports of root compatibility facades from inside `src/modules`;
- runtime dependency cycles;
- new root-level domain implementation files;
- generic new filenames such as `utils.ts`, `helpers.ts`, or `manager.ts`.

Type-only cycles should also be removed by moving the shared contract to its
owner, even though they do not create a JavaScript runtime cycle.

## Refactoring priorities

Refactoring follows risk and ownership, not raw line count:

1. Remove module-to-root-facade dependency indirection.
2. Establish `modules/projects` from the current project index and project docs.
3. Move accepted-session indexing into `modules/sessions`.
4. Move outbound Peon HTTP/proxy code into `infrastructure/peonHttp`.
5. Split large realtime files by protocol responsibility while preserving their
   state-machine invariants and characterization tests.
6. Continue extracting state and orchestration from large frontend route
   components into feature hooks and models.

Large protocol state machines are not split merely to satisfy a line limit. A
large file is acceptable when it has one lifecycle, one invariant set, and one
reason to change. Files that mix queries, transport, policy, and UI orchestration
should be split even when they are shorter.

## Migration policy

1. New capabilities start in the target module structure.
2. Existing code moves when it receives meaningful changes.
3. Preserve a thin compatibility facade when a single move would otherwise
   require unrelated callers to change.
4. Each move keeps behavior stable and passes `npm run verify`.
5. Remove a facade only after all callers use the module's public entry point.
6. In the watched development tree, create the new implementation and facade
   before unlinking the old path. Restart and health-check the app explicitly
   after a physical move so the watcher cannot remain down after a transient
   missing-module restart.

Architecture is a constraint on ownership and dependencies, not a target number
of directories or classes. Prefer the smallest structure that makes those
boundaries explicit.
