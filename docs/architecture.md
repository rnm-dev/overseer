# Architecture

Use a pragmatic feature-first architecture. Add a layer only when it owns real
behavior; do not create one interface and one implementation for every class.

## Dependencies

- **Riverpod** owns dependency injection and application state.
- **GoRouter** owns navigation and deep-link routing.
- **Dio** is the REST transport.
- **web_socket_channel** is the WebSocket transport behind the live-sync client.
- **Drift/SQLite** is the source of cached app state, transcripts, cursors,
  drafts, local retry commands, and authoritative queue snapshots.
- **flutter_secure_storage** stores the device token.
- **Firebase Messaging** receives push notifications.
- **connectivity_plus** supplies connection hints only.
- **Freezed/json_serializable** generate immutable transport models where doing
  so removes meaningful parsing boilerplate.

Keep these packages behind small app-owned APIs when product code needs them;
widgets should not call transports, SQLite, or secure storage directly.

The supported targets are iOS, Android, macOS, Windows, and Linux. A package
being cross-platform does not make it part of a feature's application layer:
plugin calls remain in `core/` or a feature's `data/` implementation.

## Feature shape

A feature starts small and grows only as needed:

```text
features/sessions/
  presentation/   pages, widgets, UI state rendering
  application/    controllers and use-case coordination
  data/           repository implementation and remote/local data sources
  domain/         stable feature models and repository contracts, if useful
```

Dependency direction is:

```text
presentation -> application -> repository contract <- data
                                      ^
                                      |
                            app composition root
```

Features may use `core` and domain-neutral `shared` code. They must never import
another feature's `data/` implementation or internal `presentation/` files.
When one feature deliberately exposes reusable UI, export that surface from
`features/<feature>/<feature>.dart` and import only that public entrypoint.
Public presentation dependencies between features must remain acyclic.
Cross-feature value objects that are genuinely feature-neutral live in a
deliberately named `shared/models/` module; for example, Sessions and Peon
settings share the AI provider/model capability catalog from there.

Cross-feature navigation belongs to the app router. A leaf feature routes by
name or reports user intent; it does not construct another feature's internal
page. Feature-local navigation may continue to use local page classes.
Promote code to `shared` only after it is genuinely domain-neutral and reused.

`core` contains app-wide technical capabilities such as HTTP configuration,
authentication storage, database setup, live sync, notifications, connectivity,
clock, and logging. It must not become a miscellaneous utilities folder.

Application and data code receives time through `AppClock` and scheduling
through `AppScheduler`. Wall-clock reads and raw timers remain acceptable only
for purely visual widget-local animation or elapsed-time presentation. Tests
override both providers with manual time so retry, polling, freshness, and
reconciliation boundaries do not sleep.

Operational diagnostics use the bounded `AppDiagnosticEvent` schema. Events may
carry safe connection, workspace, session, cursor, attempt, state, outcome, and
error-type correlation only. They must never include device tokens, WebSocket
tickets, prompts, transcript payloads, attachment contents, secrets, or private
paths.

`app/app_dependencies.dart` is the composition root. It is the one place that
may import contracts and their concrete implementations together to install
Riverpod overrides. Controllers receive implementations through providers and
must not import Dio, secure storage, WebView, Firebase, or platform runner code.

The authentication feature is the reference layout:

```text
features/auth/
  presentation/   auth gate and signed-out UI
  application/    controller and UI-facing auth state
  domain/         session models, repository and OAuth-browser contracts
  data/           Dio, OAuth-browser, and repository implementations
core/
  security/       device-token secure storage
  platform/       desktop process/bootstrap integration
```

## Platform boundaries

Prefer capability-oriented app APIs over scattered operating-system checks.
Feature code asks for secure token storage, an OAuth browser, notifications, or
window lifecycle behavior; the composition root supplies the implementation.
Do not branch on `Platform.is...` in presentation, application, or domain code.

Platform runner directories own only native concerns:

- bundle/application identity, schemes, manifests, and entitlements;
- plugin registration and build-system integration;
- native window defaults and packaging metadata.

Dart `core/platform/` owns app-wide bootstrap behavior that must run before the
widget tree, such as the helper process for Windows/Linux OAuth WebViews.
Feature-specific plugin adapters belong in that feature's `data/` directory.

Layout decisions depend on available width and input affordances, not the OS.
Use responsive constraints so tablets, resizable desktop windows, and narrow
windows share the same presentation logic. Platform-specialized shells are
appropriate only when navigation or window behavior genuinely differs.

`shared/layout/responsive_breakpoints.dart` is the canonical width policy:

- compact below 600 logical pixels;
- medium from 600 up to 1024;
- wide from 1024 upward.

`ShellPage` dispatches to compact, medium, and wide presentation widgets using
those breakpoints. Feature pages, routes, selection state, and controllers stay
shared; shells compose them without owning business state. Other adaptive
surfaces such as dialogs use the same breakpoint policy instead of defining
local mobile/desktop constants.

See [platform-support.md](platform-support.md) for the capability matrix and
native build requirements. See
[push-notifications.md](push-notifications.md) for FCM registration, token
rotation, server delivery, and deployment credentials.

## Shared presentation surfaces

Build compact modal sheets with `AppBottomSheet` and open them through
`showAppBottomSheet`. Pass the optional string `title` to the shared component
instead of rendering a feature-local title so every bottom sheet keeps the same
typography, color, handle, and title spacing. Specialized sheets may compose
their own body and actions inside that shared surface.

## Offline and live data flow

Repositories expose streams backed by Drift so the UI renders cached data
immediately.

1. REST refreshes write validated snapshots to Drift.
2. WebSocket snapshots and ordered deltas update the same tables in
   transactions and advance the persisted cursor.
3. Riverpod controllers observe repository streams and handle user intent.
4. Offline commands are written before sending, retain stable identifiers, and
   are removed only after acknowledgement.

On reconnect, resume the workspace stream from its cursor and resubscribe to
the active transcript. A retryable failure for one session must not let its
later command overtake it.

## Testing boundaries

- Unit-test decoding, repositories, migrations, cursor progression, selection,
  reconnection, and ordered retries with fake transports and clocks.
- Widget-test important loading, cached/offline, empty, error, and success
  states.
- Integration-test sign-in and the workspace → peon → session → follow-up path.
- Run unit and widget tests once on the shared Dart code, then build each native
  target on its supported host to catch manifests, entitlements, plugin
  registration, and packaging failures.
- Exercise OAuth and secure-storage smoke tests on at least one real device or
  host per platform family before release.

Prefer constructor/provider overrides over a service locator or global
singletons. Test behavior at feature boundaries; do not mirror every class with
a mock.
