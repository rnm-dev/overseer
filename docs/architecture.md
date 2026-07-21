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
  infrastructure/         # database, external providers, deployment concerns
  modules/
    auth/
    files/
    fleet/
    projects/
    realtime/
    releases/
    sessions/
    workspaces/
  shared/                 # small, domain-neutral primitives only
```

Domain modules such as `sessions` and `projects` live directly under `modules`.
They must not be grouped under abstract containers such as `catalogs`, because
the domain name already describes the capability and its ownership.

The current root-level files are legacy entry points. They may remain as thin
compatibility facades while callers migrate to a module's public entry point.

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
web/src/
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

## Migration policy

1. New capabilities start in the target module structure.
2. Existing code moves when it receives meaningful changes.
3. Preserve a thin compatibility facade when a single move would otherwise
   require unrelated callers to change.
4. Each move keeps behavior stable and passes `npm run verify`.
5. Remove a facade only after all callers use the module's public entry point.

Architecture is a constraint on ownership and dependencies, not a target number
of directories or classes. Prefer the smallest structure that makes those
boundaries explicit.
