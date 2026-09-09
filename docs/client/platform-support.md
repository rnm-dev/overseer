# Platform support

Overseer uses one feature and data model across iOS, Android, macOS, Windows,
and Linux. Native runners provide packaging and plugin integration; shared
business behavior stays in Dart.

## Connection lifecycle

Adding an Overseer is provisional until authentication succeeds. After the
operator enters a server URL, the add form remains visible with its Continue
button in a loading state while the app restores an existing token or opens the
web login. The authenticated Overseer shell is not constructed during this
provisional check. A successful token restoration or GitHub sign-in commits the
normalized connection and then opens its shell; a failed or abandoned sign-in
leaves the saved connection list unchanged and returns the add form to a
retryable state. The Overseer skeleton is therefore only visible after login,
while authenticated data is loading.
On the compact authenticated overview, a standard navigation bar shows the
selected connection's host and a back arrow to the connection picker. Fleet
cards begin below the bar with a top gap equal to their horizontal screen
inset. All shared page navigation bars have a non-overridable 56 logical-pixel
content height; the platform top safe-area inset is added outside that height.

Saved connections expose deletion through a long-press or right-click action
menu: a bottom sheet on compact layouts, a centered dialog on medium layouts,
or an anchored context menu on wide layouts. The destructive action requires explicit confirmation. Deletion
removes the connection from ordinary preferences and deletes its namespaced
device token from secure platform storage. Other connections and their
credentials are not affected.

## Capability matrix

| Capability | iOS | Android | macOS | Windows | Linux |
| --- | --- | --- | --- | --- | --- |
| GitHub OAuth | System authentication session | Auth Tab | Default external browser | Embedded WebView2 window | Embedded WebKitGTK window |
| OAuth callback | Flavor-specific scheme | Flavor-specific scheme | Flavor-specific scheme | Intercepted inside WebView | Intercepted inside WebView |
| Device token | Keychain | Encrypted platform storage | Keychain | Windows secure storage | libsecret |
| REST/WebSocket | Supported | Supported | Supported | Supported | Supported |
| HTML file preview | Embedded WebView | Embedded WebView | Embedded WebView | Separate WebView2 window | Separate WebKitGTK window |
| Firebase push | FCM registration implemented; APNs key required | FCM registration implemented | Not selected | Not selected | Not selected |
| Foreground notification UI | In-app card | In-app card | Unsupported | Unsupported | Unsupported |
| Notification/deep-link routing | Peon/session, auth-restored | Peon/session, auth-restored | Push unsupported | Native completion toast, running app | Push unsupported |

Mobile sign-in begins at the web login page, not directly at GitHub. Each
flavor keeps one paired origin and callback: dev uses
`https://overseer-dev.rnm.dev/login?callback=overseer-dev%3A%2F%2Foauth%2Fgithub`
and prod uses
`https://overseer.rnm.dev/login?callback=overseer%3A%2F%2Foauth%2Fgithub`.
On iOS and Android, the app opens that URL in a system authentication session.
On macOS, Launch Services opens it in the user's default browser. The app
exchanges the `state` and one-time `code` returned in the callback with
`/api/auth/github/native/exchange`.

The server must allow the exact callback in
`OVERSEER_GITHUB_NATIVE_CALLBACKS`: `overseer-dev://oauth/github` for dev and
`overseer://oauth/github` for prod. Distinct schemes prevent the OS from
delivering a callback to the wrong side-by-side installation. Never exchange a
callback received outside an active system authentication session. On Android,
the app-owned `OAuthCallbackActivity` only resolves a currently active
`flutter_web_auth_2` request. It then starts the package response handler inside
the exact existing Overseer task so the Auth Tab closes instead of leaving an
authenticated app behind the browser. Both exported activities retain an empty
task affinity for task-hijacking protection; do not replace this with the
package-default callback activity or remove the empty affinities. Cold-start and
unsolicited callback intents cannot exchange a code. Windows and Linux do not
register Overseer as a system URI handler for sign-in because the dedicated
OAuth WebView intercepts the callback before external navigation. The app-owned
desktop OAuth adapter validates the complete scheme, host, and path, blocks the
callback from rendering as a page, closes the WebView, and then exchanges the
one-time code.

On macOS, the app delegate forwards a flavor-specific callback to Dart only
while an OAuth request is active. Dart validates the complete scheme, host, and
path and stops listening after success, failure, or the five-minute timeout.
The browser choice is controlled by the user's macOS default-browser setting;
the app does not select Safari or another specific browser.

Windows and Linux reuse the same native desktop WebView capability for HTML
file previews. Because the plugin provides a separate native window rather than
an embeddable Flutter surface, Preview shows an explicit Open Preview action.
The app writes the isolated CSP-protected document and an ephemeral browser
profile to temporary storage, permits navigation only to that document plus
`about`, `data`, and `blob` resources, and removes the temporary directory when
the preview window closes. macOS retains its embedded preview.

The same flavor-specific mobile schemes also accept app-owned `/open/peon` and
`/open/session` links. Unlike OAuth callbacks, these links carry no credential
or one-time code. Their bounded identifiers are retained through connection
selection and authentication restoration. Workspace-to-connection hints are
kept in the flavor's ordinary preferences, while each connection's device token
remains in its separate secure-storage namespace.

## Bootstrap and ownership

`main.dart` calls the app-owned helper in
`core/platform/desktop_webview_bootstrap.dart` before creating the widget tree.
The helper handles the secondary title-bar process used by desktop WebViews.
Keep the plugin call behind this core API. The primary process then initializes
Firebase Core before `runApp` on Android, iOS, macOS, Windows, and web. Linux
skips Firebase initialization because it is not a supported FlutterFire target.

Authentication platform details are split as follows:

- `features/auth/domain/` defines the repository and OAuth-browser contracts.
- `features/auth/application/` owns state transitions and user intent.
- `features/auth/data/` implements REST, OAuth browsing, and orchestration.
- `core/security/` stores the device token without exposing the plugin to the
  feature.
- `core/notifications/` owns permission, FCM token rotation, and the
  authenticated push-subscription transport.
- `app/app_dependencies.dart` connects contracts to implementations.

## Build requirements

### Build flavors

Android, iOS, and macOS provide two side-by-side installable flavors:

| Flavor | Application ID | Display name | Default server |
| --- | --- | --- | --- |
| `dev` | `org.ovrseer.app.dev` | Overseer Dev | `https://overseer-dev.rnm.dev` |
| `prod` | `org.ovrseer.app` | Overseer | `https://overseer.rnm.dev` |

Use `flutter run --flavor dev` or `flutter run --flavor prod`. The Android
`./run` helper defaults to `dev`. An explicit `OVERSEER_URL` Dart define still
overrides the flavor default.

Firebase Core selects the matching `dev` or `prod` mobile app from
`lib/firebase_options.dart`. The `dev` flavor uses Firebase project
`overseer-dev-f24fe`; production uses `overseer-9fe46`. Android keeps the
development Google Services
configuration in `android/app/src/dev/google-services.json`; the root
`android/app/google-services.json` remains the production fallback. Re-running
`flutterfire configure` replaces `lib/firebase_options.dart`, so restore the
flavor selection and both development app IDs if the generated options change.

The macOS dev flavor uses automatic Apple Development signing with team
`F7KV67KV2U`. Its development provisioning profile is required because the
sandboxed app stores device tokens in Keychain. Installing dev on a physical
iPhone likewise requires registering `org.ovrseer.app.dev` in the Apple
Developer account; simulator builds do not require that registration.

Flutter 3.44 does not expose `--flavor` for Windows or Linux builds. Those
targets continue to produce the single production-identity desktop runner.

### macOS window

The native window starts with an 1180 × 780 content area, centered on screen,
and restores its saved frame on subsequent launches. Its minimum outer size is
480 × 480, so narrow windows still exercise the compact layout without becoming
unusable. Window placement is stored by AppKit separately for each app flavor.

### Apple

macOS and iOS use Swift Package Manager. The runners register flavor-specific
`overseer-dev` and `overseer` URL schemes. Overseer Mobile supports iOS 15.0
and later. macOS enables the app sandbox, outbound networking, and Keychain
access.

```sh
flutter build ios --simulator --flavor dev
flutter build ios --simulator --flavor prod
flutter build macos --flavor dev
flutter build macos --flavor prod
```

TestFlight builds require the `prod` flavor, App Store signing, and current
Apple SDK tooling. Follow the full [TestFlight release process](testflight.md).

### Windows

Fleet Overview fills the available content pane and resizes with the window.
The Windows composition root overrides the overview's 760-unit width limit;
other targets retain the existing centered layout. Row heights, typography,
spacing, and the sidebar are unchanged.

Build on Windows. Microsoft Edge WebView2 Runtime must be installed; it ships
with Windows 11 but may need deployment on Windows 10.

```sh
flutter build windows
```

### Linux

Build on Linux with Flutter's GTK toolchain plus GTK 3, WebKitGTK 4.1 (or 4.0),
libsoup, and libsecret development packages.

```sh
flutter build linux
```

## Release checks

CI compiles debug builds for macOS, Windows, and Linux on matching native
GitHub-hosted runners. These compile gates do not replace the following
platform smoke tests.

For every target:

1. Build on its native host.
2. Complete GitHub sign-in and restart the app to verify token restoration.
3. Reject or revoke the current device token and verify return to sign-in.
4. Resize desktop windows and check narrow and wide layouts.
5. Verify offline and reconnect behavior before enabling release signing.
