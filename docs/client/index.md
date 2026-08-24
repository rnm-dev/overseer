# Overseer client

Overseer client is the cross-platform Flutter app for monitoring Peons and working with
agent sessions on iOS, Android, macOS, Windows, and Linux. Navigation, session
lists, transcripts, drafts, and selected operational data remain useful
offline and reconcile when the server is reachable.

## Current scope

The app supports:

- multiple Overseer connections with isolated credentials and Drift caches;
- device-locale English and Russian UI for the app shell, connection/auth
  flow, and session composer, with English fallback;
- native GitHub sign-in and secure device-token storage;
- cached-first workspaces, Peons, projects, sessions, and transcripts;
- resumable workspace and transcript WebSocket updates;
- project creation, project detail, files, settings, skills, and member access;
- new sessions and follow-ups with attachments, retry-safe submission, and the
  Peon-owned queue;
- transcript tools plus dedicated read-only attachment and preview detail
  surfaces backed by the shared file viewers;
- route-scoped operator presence;
- Peon statistics, settings, provider updates, Soul editing, and Armory package
  lifecycle;
- Android and iOS push registration, shared foreground notification UI, and
  cached-first Peon/session tap and deep-link routing through connection and
  authentication restoration;

Known platform and deployment limits live with the relevant feature
documentation instead of in this overview.

## Sources of truth

Use the current Overseer server contract first:

- `../../apps/server/src/app/server.ts` and `../../apps/server/src/routes/` for REST;
- `../../apps/server/src/adapters/liveSocket.ts` for `/api/ws`;
- server tests for edge cases and compatibility behavior.

The web client at `../../apps/web` is the visual reference. Preserve
mobile touch targets while matching its hierarchy, colors, status lights,
spacing, and interaction states.

When references disagree, the server contract wins.

## Start here

Install dependencies and use the project launcher:

```sh
flutter pub get
./run
```

For routine development, use the `dev` flavor:

```sh
./run --platform android --flavor dev
```

The launcher can select a platform, device, flavor, and additional
`flutter run` arguments. See [running-app.md](running-app.md) for its complete
interface and [platform-support.md](platform-support.md) for native
prerequisites, flavors, OAuth callbacks, and release checks.
Use [testflight.md](testflight.md) for production iOS signing, archive,
App Store Connect metadata, upload, and smoke-test preparation.
Use [app-store-demo-workspace.md](app-store-demo-workspace.md) for the isolated,
fictional development dataset used in public App Store screenshots.

Before committing:

```sh
dart format --output=none --set-exit-if-changed lib test integration_test tool
flutter analyze
flutter test
```

The repository does not use GitHub Actions. See
[verification.md](verification.md) for the local quality gates, native-host
ownership, and credential rules.

After changing Drift, Freezed, or JSON-serializable declarations:

```sh
dart run build_runner build --delete-conflicting-outputs
```

After UI changes, validate affected screens on a real device with MobAI and
send the final screenshots to the user for review.

## Project map

```text
lib/
  app/        composition, routing, and theme
  core/       app-wide infrastructure
  features/   product features, grouped vertically
  shared/     reusable, domain-neutral UI and utilities
test/         unit and widget tests
integration_test/
android/ ios/ macos/ windows/ linux/
```

Read [architecture.md](architecture.md) before changing dependency boundaries
or data flow.

Use [ui-kit.md](ui-kit.md) when adding or changing surfaces, cards, actions,
inputs, list rows, or status treatments.

Feature documentation:

- [fleet.md](fleet.md): cached workspaces and Peons plus multi-Overseer live
  runtime lifecycle;
- [sessions.md](sessions.md): session cache, pagination, and live state;
- [transcripts.md](transcripts.md): transcript cache, composer, queue, and tail;
- [plugin-inquiries.md](plugin-inquiries.md): managed-plugin confirmation,
  recovery, terminal states, and security boundaries;
- [voice-input.md](voice-input.md): native dictation capture, upload, composer
  behavior, and real-device QA;
- [localization.md](localization.md): locale resolution, translation resources,
  current coverage, and migration rules;
- [themes.md](themes.md): bundled theme packages and device-local,
  per-Overseer selection;
- [project-detail.md](project-detail.md): project navigation and settings;
- [project-files.md](project-files.md): project tree and shared file viewer;
- [peon-settings.md](peon-settings.md): General, Agent, and Armory settings;
- [ai-stats.md](ai-stats.md): usage, quota, capabilities, and privacy;
- [presence.md](presence.md): route-scoped operator presence;
- [push-notifications.md](push-notifications.md): FCM lifecycle and deployment;

## Non-negotiable behavior

- Device tokens stay in secure platform storage, are namespaced by Overseer
  connection, and never enter logs, fixtures, analytics, or Drift.
- Cached state renders first; REST and WebSocket data reconcile it afterward.
- Each workspace persists and resumes its increasing live cursor.
- Follow-up commands retain stable identifiers and per-session ordering across
  retries.
- Connectivity is a hint, not proof that the API is reachable.
- Authentication is invalidated only by an explicit `401` from Overseer or by
  an operator-requested sign-out. Transport failures, timeouts, and `5xx`
  responses preserve credentials and private caches and render an unavailable
  state with retry instead of a sign-in prompt.
- Every feature provides useful loading, empty, offline, error, and retry
  states.
- Routine builds and device tests use `dev`; use `prod` only when the task
  explicitly requires production validation.
