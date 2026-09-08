# Client verification

The repository does not use GitHub Actions. Local checks are the delivery gate.

From the repository root, run:

```sh
npm run verify
```

This checks the Node workspaces and then runs `flutter analyze` and
`flutter test` in `apps/client`. When Flutter is not installed, the client step
prints an explicit `SKIPPED` message; that output means the client was not
verified.

For a complete client-only check from `apps/client`, run:

```sh
flutter pub get
dart format --output=none --set-exit-if-changed lib test integration_test tool
flutter analyze
flutter test
flutter test -d flutter-tester integration_test/ovsr_196_integration_test.dart
```

The deterministic integration test restores an in-memory authentication
session, opens a workspace Peon and its active session, and submits a follow-up
through a fake repository. It does not contact an Overseer deployment or use
production credentials.

Native compile checks remain platform-specific:

| Target | Command |
| --- | --- |
| Android | `flutter build apk --debug --flavor dev` |
| macOS | `flutter build macos --debug --flavor dev` |
| Windows | `flutter build windows --debug` |
| Linux | `flutter build linux --debug` |

OAuth, secure storage, resize behavior, offline recovery, reconnects,
notifications, and production signing still require release smoke tests on the
corresponding real platform. Never put signing credentials or secure device
tokens in logs, fixtures, or commits.

## Desktop visual fixtures

The shell and transcript tests can render populated desktop fixtures without
server access or credentials. From `apps/client`:

```sh
CAPTURE_SHELL_SCREENSHOT=1 flutter test test/features/shell/presentation/desktop_shell_visual_test.dart
flutter test --update-goldens --dart-define=OVSR_SESSION_GOLDEN=true test/features/sessions/presentation/session_detail_page_test.dart --plain-name "centers the transcript and composer on desktop while retaining compact width"
```

The shell capture is written under `test/features/shell/artifacts/`; the session
capture lives under `test/features/sessions/presentation/goldens/`. Font loading
for the session capture is opt-in so it does not alter other widget tests.
These fixtures supplement native resize and interaction checks.

Run Flutter builds and tests sequentially in a shared checkout: simultaneous
commands can race when preparing `build/native_assets/macos/libsqlite3.dylib`.
