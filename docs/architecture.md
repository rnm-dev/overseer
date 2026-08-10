# Overseer architecture

Overseer is a modular monolith. Backend and frontend code are organized around
product capabilities, with explicit module boundaries, rather than around a
global stack of controllers, services, and repositories.

The architecture is intentionally evolutionary: existing code moves into the
target structure when it is changed. Large directory-only rewrites are avoided.

## Backend structure

```text
src/
  index.ts                # the process entry point, and the only root file
  app/                    # process bootstrap and application composition
  adapters/               # WebSocket transports and protocol state machines
  routes/                 # HTTP transport
  infrastructure/
    db/                   # pool, transactions, migrations
    github/               # external GitHub integration
    peonHttp/             # outbound Peon HTTP client, stream proxies, file sandbox
    push/                 # notification delivery
    releases/             # release storage and publication
    voice/                # speech-to-text and text-polish provider seam
  modules/
    auth/
    access/
    fleet/
    notifications/
    presence/
    projects/
    reverseCommands/
    sessions/
    themes/
    voice/
    workspaces/
  shared/                 # small, domain-neutral primitives only
```

Domain modules such as `sessions` and `projects` live directly under `modules`.
They must not be grouped under abstract containers such as `catalogs`, because
the domain name already describes the capability and its ownership.

The source root holds `index.ts` and nothing else. The compatibility facades
that once lived beside it are gone, and `scripts/check-architecture.mjs` keeps
the root closed: a new capability starts in a module, an adapter, or
infrastructure.

### Stable module taxonomy

The top-level taxonomy is deliberately small. New directories must fit one of
these ownership categories rather than being created for a single use case.

- `auth` owns users, devices, OAuth flows, web session cookies, native bearer
  authentication, and the cookie-authenticated CSRF boundary. Web credentials
  stay in a host-only HttpOnly cookie; native/mobile clients retain revocable
  device bearer tokens.
- `access` owns cross-resource authorization policies and grants.
- `fleet` owns Peon enrollment, registry state, connection lifecycle, and the
  durable runtime-state projection.
- `notifications` owns who is told about what: push fan-out policy and the iOS
  Live Activity aggregate. The delivery transports are an external system and
  live in `infrastructure/push`.
- `reverseCommands` owns the durable reverse command gateway, its registry, and
  the transport-selection and rollout-readiness rules around it.
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
facility belongs in `infrastructure`, not in a product module.

`adapters` holds the WebSocket transports and the protocol state machines that
ride them: the operator live socket, the Peon socket and its authentication
handshake, and the session and transcript synchronizers. They are transports,
not a domain, so a module must not import them — the dependency runs the other
way, exactly as it does for `routes`.

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

## WebSocket upgrades

Every `upgrade` listener must claim the requests it owns **synchronously** —
`claimUpgrade(req)` from `adapters/upgradeGuard.ts`, before any `await` — and
`attachUpgradeFallback` is registered last in `index.ts`, after every real
handler, where it refuses whatever nobody claimed with `400` and destroys the
socket. A handler that claims a request owns closing it, including when its
authentication never returns; `armUpgradeTimeout` bounds that wait.

This is not tidiness. Once any `upgrade` listener exists, Node stops destroying
unhandled upgrade sockets itself, so a listener that just `return`s on a foreign
path leaks the descriptor for the life of the process. A retired endpoint that
an outdated Peon still dials every 40 seconds accumulated 1,657 CLOSE_WAIT
sockets in one production day, every one of them still held by Node.

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
  app/                    # App.tsx, main.tsx, index.css
  features/
    armory/
    auth/
    fleet/                # a Peon as an operator sees it
    projects/
    sessions/
    settings/
    stats/
    themes/
    workspaces/
  realtime/               # live socket, presence, audio focus
  shared/                 # UI primitives, API client, i18n, generic hooks
```

A feature owns its pages, its hooks, its API calls and its models together, and
its tests sit beside them. There is no `pages/` or `components/` directory: a
route component is a file in the feature it belongs to, and a component shared
by several features lives in `shared/`.

Page components coordinate feature hooks and components. Protocol state,
request orchestration, and reusable domain transformations belong in dedicated
feature modules rather than in route components.

The directory migration is done; what remains is depth, not layout. Several
route components still hold state and orchestration that belongs in feature
hooks and models — `features/sessions/PeonSessionDetail.tsx` most of all.

## Architecture fitness checks

The architecture is enforced by `scripts/check-architecture.mjs`, which
`npm run verify` runs through `npm run architecture:check`. Its allowances live
in `scripts/architecture-policy.json`, and every list in that file is now empty
except the root entry point. It rejects:

- imports of a module's internal files from outside that module;
- imports of root files from inside `src/modules`;
- imports of routes, adapters, or app composition from inside `src/modules`;
- imports of product modules from inside `src/infrastructure`;
- runtime dependency cycles;
- new root-level implementation files;
- generic new filenames such as `utils.ts`, `helpers.ts`, or `manager.ts`.

A file added to an allowance list is a debt, not a decision: the lists exist so
a migration can land in steps, and they are expected to shrink back to empty.

Type-only cycles should also be removed by moving the shared contract to its
owner, even though they do not create a JavaScript runtime cycle.

## Refactoring priorities

Refactoring follows risk and ownership, not raw line count:

Priorities 1–4 — removing the root facades, establishing `modules/projects`,
moving accepted-session indexing into `modules/sessions`, and moving outbound
Peon HTTP into `infrastructure/peonHttp` — are done. What remains:

1. Split large realtime files by protocol responsibility while preserving their
   state-machine invariants and characterization tests. `adapters/liveSocket.ts`
   and `adapters/peonSessionSync.ts` are the two that mix several protocols.
2. Continue extracting state and orchestration from large frontend route
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
