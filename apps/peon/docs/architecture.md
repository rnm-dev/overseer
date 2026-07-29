# Peon architecture

## Purpose

Peon is a modular monolith. It is deployed as one Node.js application, but its source is
organized into feature modules with explicit public boundaries. The goal is to keep feature
ownership and dependency direction stable as the daemon grows, without introducing a separate
package or process for every concern.

This document is normative for new daemon code. Existing code may temporarily differ while the
incremental migration described below is in progress.

## Architectural principles

1. Organize business code by feature, not by technical artifact type.
2. Keep transports thin. HTTP, WebSocket, MCP, and CLI code translate requests and responses;
   they do not own business rules or mutate stores directly.
3. Each feature exposes a small public API through its `index.ts`. Code outside the feature does
   not import its internal files.
4. Dependencies point toward contracts and application services. A feature must not import a
   higher-level transport or composition root.
5. Cross-feature dependencies use explicit interfaces and constructor injection. Features do
   not resolve each other's process-wide singletons internally.
6. Prefer incremental extraction with preserved behavior over a big-bang directory rewrite.

## Target source layout

```text
src/
  daemon/
    bootstrap/
      daemon.ts
      compositionRoot.ts

    http/
      human/projects.ts
      fleetRouter.ts
      mcpRouter.ts
      errors.ts

    projects/
      index.ts
      contracts.ts
      service.ts
      state.ts
      catalog.ts
      docs.ts
      skills.ts

    settings/
      index.ts
      settingsTypes.ts
      settingsService.ts
      settingsStore.ts

    sessions/
      index.ts
      sessionContracts.ts
      sessionService.ts
      sessionRepository.ts
      sessionRunner.ts
      sessionQueue.ts
      sessionRecovery.ts
      transcriptRepository.ts

    agents/
      index.ts
      agentContracts.ts
      agentRegistry.ts
      agentExecutor.ts
      providers/
        claudeCode.ts
        codex.ts
        codexAppServer.ts
      runtimes/
        codexAppServerRuntime.ts

    overseer/
      index.ts
      enrollment.ts
      registrar.ts
      socket/
        socketSupervisor.ts
        socketOutbox.ts
        protocol.ts
        channels/

    armory/
      ...

  dashboard/
  cli/
  shared/
```

This is a destination map, not a requirement to create empty directories. Add a directory only
when code belonging to that boundary exists.

## Dependency direction

The normal call direction is:

```text
bootstrap / composition root
              |
              v
HTTP / WebSocket / MCP / CLI adapters
              |
              v
application services
              |
              v
domain contracts and store/runtime ports
              |
              v
persistence stores, provider runtimes, and external clients
```

The composition root is the only place that creates process-wide instances and connects one
feature to another. For example, `ProjectService` may require a `ProjectSessionIndex` interface
to prevent deleting an active project and to propagate a renamed project key. The interface is
owned by the projects module, implemented by the sessions module, and injected by the composition
root. The projects module must not import the sessions singleton.

Allowed dependencies:

- transports may depend on feature public APIs;
- application services may depend on their own contracts and injected ports;
- stores may depend on filesystem primitives and their own feature contracts;
- provider adapters may depend on agent contracts and their provider runtime;
- the composition root may depend on every module it wires together.

Forbidden dependencies:

- feature modules importing HTTP, Express, WebSocket, or CLI request types;
- routers mutating feature stores directly;
- stores calling routers, services, or external transports;
- one feature importing another feature's internal file;
- feature modules importing each other's global singleton instances;
- generic dependency buckets such as `utils.ts`, `helpers.ts`, or `manager.ts`.

## Public module boundaries

Every mature feature has an `index.ts` that exports only supported cross-feature contracts and
operations. Internal persistence helpers, filesystem details, and implementation-only error types
remain private to the feature.

Use imports such as:

```ts
import { projectService, type ProjectRecord } from "./projects/index.js";
import { settings, type DaemonSettings } from "./settings/index.js";
```

Do not use imports such as:

```ts
import { projectService } from "./projects/service.js";
import { SettingsStore } from "./settings/settingsStore.js";
```

Tests inside a feature may import its internal files. Integration tests outside the feature should
use the public API unless they specifically verify an implementation boundary such as atomic
persistence.

## Naming conventions

| Suffix | Responsibility |
|---|---|
| `*Service` | Application operations, validation, and orchestration for one feature |
| `*Store` | Durable or in-memory state persistence with no transport knowledge |
| `*Repository` | Persistence for aggregate data with richer query or transaction behavior |
| `*Runtime` | Lifecycle of a long-lived external process or provider connection |
| `*Client` | Outbound calls to an external HTTP or service API |
| `*Router` | HTTP route registration and transport translation |
| `*Channel` | One negotiated WebSocket protocol capability |
| `*Registry` | Registration and lookup of implementations |
| `*Coordinator` | A state machine that coordinates several services or runtimes |
| `*Contracts` | Stable interfaces and cross-boundary data shapes |
| `*Types` | Feature-local data types without runtime behavior |

Names describe ownership rather than implementation history. Use `ProjectStore`, not
`ProjectStateStore`; the stored object is state, while the component's responsibility is storage.

Avoid `Manager`, `Handler`, `Helper`, `Common`, and `Utils`. If one of those words seems necessary,
identify the actual responsibility before adding the file.

## Classes and functions

Use a class when the component has at least one of these properties:

- owned mutable state;
- an explicit lifecycle such as start, stop, reconnect, or dispose;
- injected dependencies that need isolated test instances;
- invariants maintained across several operations.

Use plain functions for validation, parsing, formatting, mapping, and other stateless operations.
Do not create a class solely to namespace related functions.

Process-wide singletons are instantiated and exported only from a feature's public entry point or
the composition root. Implementation files should export constructors so tests can create isolated
instances.

## Projects module

The projects module owns:

- project identity and metadata;
- project persistence and catalog events;
- project create, update, rename, and delete rules;
- project documentation and skills discovery;
- durable project quick links and their validation;
- project catalog snapshots used by Overseer synchronization.

It does not own:

- Express response envelopes;
- session persistence or process lifecycle;
- generic host filesystem browsing;
- WebSocket connection supervision.

`ProjectService` is the application boundary. Human and fleet routers may use different error
envelopes, but both call the same service operations. `ProjectStore` owns atomic persistence and
catalog events. WebSocket project channels live under `overseer/socket/channels` and consume the
projects module's public contracts.

## Settings module

The settings module owns:

- `DaemonSettings` and its defaults;
- durable settings persistence;
- validation and normalization of supported settings changes;
- safe views that exclude secrets where required.

`SettingsStore` only reads and writes the durable settings record. `SettingsService` owns mutation
rules such as model compatibility, URL relationships, clearing optional values, and selecting the
safe fleet-visible subset. HTTP routers must not reconstruct those rules independently.

Consumers that only read settings should depend on a narrow `SettingsReader` contract when
practical. Components that react to changes may additionally depend on a subscription contract.

## Transport rules

Human and fleet APIs are separate transport profiles over the same application services:

- human routes own cookie/loopback authentication and human-oriented response shapes;
- fleet routes own bearer/protocol authentication and stable machine error codes;
- profile-specific representation is allowed;
- duplicated validation or state mutation is not allowed.

Routers should normally contain only request parsing, authentication/authorization, service calls,
and response/error mapping. A route body that implements persistence, filesystem safety, state
transitions, or cross-feature coordination indicates missing application logic.

## File size and cohesion

Line count is a warning, not an architectural boundary:

- review production files that exceed roughly 400 lines;
- require an explicit cohesion justification above roughly 700 lines;
- split earlier when a file has multiple reasons to change;
- do not split a cohesive protocol state machine merely to satisfy a line target.

A file should usually contain one primary exported component plus small private helpers. A UI file
may contain several tightly related leaf components, but independently stateful screens belong in
separate files.

## Verification requirements

Every module migration must:

1. preserve public HTTP, WebSocket, CLI, and persistence contracts;
2. update all source and test imports without compatibility shims unless an external contract
   requires one;
3. add or retain tests at the service boundary;
4. include at least one integration test when two transports share an application operation;
5. pass `npm run typecheck` and `npm test`;
6. run `npm run compile` and include regenerated `dist/` output after source changes;
7. pass `git diff --check`.

An architecture guard complements these checks but does not replace TypeScript or runtime tests.
The guard must validate boundaries for every mature feature module, not only the absence of legacy
filenames. At minimum it should reject:

- production imports of feature internals instead of the feature's `index.ts`;
- compatibility shims left behind after their consumers have migrated;
- imports from a feature back into a higher-level transport;
- forbidden generic buckets such as new `utils`, `helpers`, or `manager` modules;
- direct cross-feature singleton imports where an injected port is required.

The check should use parsed import specifiers or an equivalently reliable mechanism. Searching
individual source lines for a short list of historical filenames is not a sufficient module-boundary
check and can pass while the repository does not typecheck.

## Migration audit: 2026-07-24

The feature-first direction is working: `projects/`, `settings/`, `sessions/`, and `overseer/`
now exist as recognizable modules, naming is substantially more consistent, and the former
1,394-line session implementation has been divided into service, runtime, recovery, state,
preview, and constants concerns. The repository remains in an incremental migration state, but
the current checkpoint passes typecheck, the full test suite, compilation, and the architecture
guard.

### Immediate build blockers

There are no known build blockers. `npm run compile` refreshes generated modules and removes only
proven orphan `dist/daemon` files whose corresponding source no longer exists. Typecheck, the
architecture guard, the full test suite, compilation, and `git diff --check` remain the operational
checkpoint.

### Settings dependency cycle

The settings module no longer imports `agentRegistry` directly for model/agent validation. The
root compatibility shim is gone, and production consumers use `settings/index.ts`.

### Composition root

`bootstrap/compositionRoot.ts` now creates the shared project service, session orchestration
service, Armory stores/runtime, and the dependency objects supplied to human and fleet routers.
Router factories retain explicit fallback construction for isolated tests and compatibility, while
the daemon entry point always uses the shared composition. Remaining process-wide services should
move into this root as their modules mature.

### Projects boundary

The project store, service, contracts, catalog, documentation, and skills discovery now live under
`daemon/projects/`. Production consumers use `projects/index.ts`, project-to-session coordination
uses an injected `ProjectSessionIndex`, and the former root compatibility files are gone.

### Settings boundary

Settings types, persistence, mutation rules, and safe views have been separated. The compatibility shim
`daemon/settings.ts` has now been removed, and all known consumers (CLI, dashboard, tests) have been moved to
`daemon/settings/index.js`. The runtime cycle described above has also been removed.

### Sessions boundary and artifact growth

Splitting the original sessions implementation has improved navigation and ownership, but the
current files remain intermediate boundaries:

- `sessions/service.ts` and `sessions/runtime.ts` remain large;
- `sessions/state.ts` owns process-wide state behind narrow collection operations;
- the cohesive transcript/session-artifact repository has moved under `sessions/`;
- `sessions/index.ts` now has an explicit supported export list.
- `sessions/contracts.ts` now defines explicit reader/catalog, lifecycle, queue, and
  transcript/event contracts for the process-wide singleton.

The transcript append queue, index, and paged reader share an ordering invariant and may remain a
single cohesive repository. Inventory calculation, summary persistence, and transcript-derived
preview helpers can still be extracted when they acquire independent change pressure.

### Files boundary

Filesystem safety primitives now live in `daemon/files/` as a transport-neutral feature boundary.
The feature owns shared raw-path resolution, root containment checks, directory listing, and
read/metadata preview behavior. Route-local upload, stream, watcher, and protocol translation code
remains in transport modules.

- `daemon/files/contracts.ts` defines the feature contracts and shared boundary data shapes.
- `daemon/files/service.ts` implements a transport-neutral filesystem service with injectable
  filesystem backends for isolated testing.
- `daemon/files/index.ts` is the public entry point, exposing the feature contracts and shared
  helpers used by routes.

### Agents boundary and migration scope

`daemon/agents/registry.ts` and `daemon/agents/executor.ts` now host the feature entry logic for
driver registration, run dispatch, and transcript normalization.

`codexAppServerRuntime.ts` now lives under `daemon/agents/runtimes/`.
`modelCatalog.ts`, `providerCapabilities.ts`, and `providerQuota.ts` remain at the root for this
pass to keep provider-wide ownership stable. They consume narrow contracts from
`daemon/agents/index.js`, with no compatibility shim fallback.

### HTTP transport remains oversized

`agentApi.ts` and `controlServer.ts` are still the two largest daemon transport files. The module
migration has reduced some duplicated business logic, but these files still register many unrelated
routes and retain filesystem mutation logic. Do not split them by arbitrary line count.
Machine-facing project and session JSON routes now live in `src/daemon/http/fleet/projects.ts`
and `src/daemon/http/fleet/sessions.ts`. Human project and session JSON routes live in
`src/daemon/http/human/projects.ts` and `src/daemon/http/human/sessions.ts`. Transcript, file,
preview, presence, and streaming endpoints remain in the top-level transports where their
lifecycle coupling still needs a dedicated boundary.

### Architecture guard gap

The new `check-architecture-imports.mjs` enforces boundary imports across
Projects, Settings, Sessions, Files, Overseer, Armory, and Agents using parsed import specifiers. It checks
daemon, CLI, and dashboard consumers and requires production imports to cross feature
boundaries only via the feature `index` entry points.

2026-07-24 follow-up:
- `armory/operationManager.ts` was renamed to `armory/operationCoordinator.ts` and the class
  was reclassified as `ArmoryOperationCoordinator` to reflect durable coordination/locking/journaling
  responsibilities.
- `daemon/files/` now owns shared filesystem helpers used by project/file routes, including
  containment-safe resolution, directory listing, and text/read metadata behavior.
- Parsed architecture guard checks now reject generic `utils`, `helpers`, and `manager` as path segments
  and exact file names inside mature features, including `armory`.

### Stabilization order

Completed stabilization steps:

1. restore typecheck and the full test suite; ✅
2. remove settings and projects compatibility shims; ✅
3. introduce the composition root and shared project/session/Armory services; ✅
4. finish the Projects and Settings public boundaries; ✅
5. replace the project-specific guard with a parsed, feature-neutral boundary check; ✅
6. regenerate `dist/`, remove proven orphan outputs, and verify the diff; ✅
7. rename Armory operation coordination from Manager to Coordinator and tighten generic-bucket checks for
   mature feature modules; ✅
8. migrate `agentRegistry`/`agentExecutor` and the Codex app-server runtime into `daemon/agents/`
   with a public `index` boundary; ✅
9. move filesystem safety/read behavior into `daemon/files/` and wire shared service construction
   through `createDaemonCompositionRoot`; ✅

Continue with HTTP route extraction and remaining provider ownership before further fine-grained
session splitting.

## Incremental migration plan

### Phase 1: projects

1. Move project service, store, docs, skills, and catalog into `daemon/projects/`. ✅ Done.
2. Rename `ProjectStateStore` to `ProjectStore` and `projectState` to `projectStore`. ✅ Done.
3. Add `projects/index.ts` as the only production import path from outside the module. ✅ Done.
4. Replace the projects-to-sessions singleton dependency with an injected
   `ProjectSessionIndex` port. ✅ Done.
5. Keep project WebSocket channels in the Overseer transport area and import only public project
   contracts from them. ✅ Done.

### Phase 2: settings

1. Split settings types, persistence, and application mutation rules. ✅ Done.
2. Add `settings/index.ts` as the public boundary. ✅ Done.
3. Move duplicated human/fleet validation and safe-view construction into `SettingsService`. ✅ Done.
4. Convert consumers to narrow reader/subscription contracts where this improves test isolation.
   ✅ Done for `PeonSocketSupervisor`, `PeonRegistrar`, and `UpdateChecker`.

### Phase 1: filesystem

1. move shared safe path resolution, directory listing, and read-preview behavior into
   `daemon/files/` as a mature feature boundary. ✅ Done.
2. require production imports to use `files/index` and reject direct feature-internal
   `files/service` imports. ✅ Done.
3. wire one shared `FileAccessService` instance through `createDaemonCompositionRoot` and consume it
   in `agentApi`/`controlServer` without changing route bodies/responses. ✅ Done.

### Phase 2a: fleet project file routes

1. extract fleet GET/PUT/PATCH/DELETE `/projects/:key/files*` from `agentApi.ts` into
   `daemon/http/fleet/files.ts`. ✅ Done.
2. consume transport operations through injected `projectFileReader` and `FileAccessContract`
   so transport wiring and validation can be tested in isolation. ✅ Done.

### Phase 2b: human filesystem routes

1. extract `GET /api/v1/fs`, `GET /api/v1/fs/stream`, and `GET /api/v1/fs/file`
   from `controlServer.ts` into `daemon/http/human/files.ts` behind a narrow
   `attachHumanFilesystemRoutes(...)`. ✅ Done.
2. preserve dashboard auth profile selection in `controlServer.ts` and keep route
   behavior (root checks, traversal/escape handling, directory listing, file-view
   translation, SSE watcher behavior and cleanup) unchanged by the extraction. ✅ Done.

### Phase 2c: fleet session file/preview routes

1. extract `/sessions/:id/files`, `/sessions/:id/file`,
   `/sessions/:id/file/raw`, `/sessions/:id/file/stream`, and
   `/sessions/:id/preview` from `agentApi.ts` into
   `daemon/http/fleet/sessionFiles.ts` behind `attachFleetSessionFileRoutes(router, deps)`. ✅

2. preserve byte-for-byte fleet contract behavior while moving only boundary-owned
   constants/helpers, including:
   - `UNKNOWN_SESSION`/`BAD_REQUEST`/`IS_DIRECTORY` envelope codes and messages;
   - MIME sniff whitelist and preview response headers (`Content-Type`,
     `X-Content-Type-Options`, `Cache-Control`);
   - unsandboxed `resolveFromDir` behavior;
   - `POST /sessions/:id/preview` actor attribution and status code;
   - file stream SSE event names/data, 150ms coalescing, watcher error emission,
     and request-close cleanup.

3. keep `agentApi.ts` as transport wiring only:
   - `GET /sessions/:id/transcript` remains in `agentApi.ts` for now;
   - `GET /sessions/:id/stream` remains in `agentApi.ts` (live transcript SSE);
   - flat `/files/{*rest}` upload/download/stat routes stay in `agentApi.ts`;
   - all remaining session/fleet JSON routes stay in `http/fleet/sessions.ts`;
   - all project routes stay in `http/fleet/projects.ts`.

### Later phases

1. Group Overseer registration, socket supervision, protocol, outbox, and channels. ✅ Done.
2. Split session persistence, turn execution, queueing, and recovery behind a session service.
   ✅ Session implementation lives in `src/daemon/sessions/` with
   `src/daemon/sessions/index.ts` as the public boundary and
   `src/daemon/sessions/service.ts` as the implementation.
   ✅ Session service internals are split into focused state/constant/preview
   modules (`src/daemon/sessions/state.ts`, `src/daemon/sessions/constants.ts`,
   `src/daemon/sessions/preview.ts`) to reduce coupling.
   ✅ Runtime execution and restart-recovery helpers live in
   `src/daemon/sessions/runtime.ts` and `src/daemon/sessions/recovery.ts`.
   ✅ `src/daemon/sessions/contracts.ts` defines explicit, responsibility-segmented session
   application contracts and wiring in `compositionRoot`, `controlServer`, and `agentApi` uses
   the narrowest applicable slices without route/path/body changes.
3. Separate human, fleet, and MCP transports from daemon bootstrap.
4. Extract stable agent contracts from the registry and group provider runtimes.

Each phase must leave the repository releasable. Do not combine unrelated module moves into one
large rename-only change.
