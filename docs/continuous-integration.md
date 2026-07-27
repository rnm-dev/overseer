# Continuous integration

GitHub Actions runs the repository delivery gates on every push and pull
request. The workflow is defined in `../.github/workflows/ci.yml`.

## Quality gates

The Linux quality job uses Flutter 3.44.8 and runs:

```sh
flutter pub get
dart format --output=none --set-exit-if-changed lib test integration_test tool
flutter analyze
flutter test
flutter test -d flutter-tester integration_test/ovsr_196_integration_test.dart
```

The integration test restores a deterministic in-memory authentication session,
opens a workspace Peon and its active session, and submits a follow-up through a
fake repository. It does not contact an Overseer deployment and contains no
production credentials, OAuth tokens, device tokens, or notification secrets.
`flutter-tester` is specified explicitly so a locally connected phone or
simulator cannot change the target selected by the command.

## Native build gates

The `android-dev` job builds `app-dev-debug.apk` on Linux after the quality job
passes and retains it as a short-lived workflow artifact. This debug build uses
the checked-in development Firebase configuration and requires no signing
secret.

The three desktop jobs also run after the quality gate and compile debug builds
on native GitHub-hosted runners:

| Target | CI host | Build command |
| --- | --- | --- |
| macOS | `macos-latest` | `flutter build macos --debug --flavor dev` |
| Windows | `windows-latest` | `flutter build windows --debug` |
| Linux | `ubuntu-latest` with GTK/WebKitGTK/libsoup/libsecret/audio packages | `flutter build linux --debug` |

The desktop jobs are compile gates; OAuth, secure-storage, resize, offline, and
reconnect behavior still require release smoke tests on each operating system.
The initial workflow does not build iOS because a simulator build duplicates
most of the macOS-hosted Apple compilation while consuming another hosted
runner. Production Apple archives and signed Android releases require protected
signing credentials; follow [TestFlight](testflight.md) and the release checks
in [platform support](platform-support.md). Never print those credentials or
secure device tokens in workflow output.

## Local verification

Use the same commands as the quality job. Build the Android gate with:

```sh
flutter build apk --debug --flavor dev
```

The deterministic integration test is suitable for routine local and CI
verification. OAuth, secure storage, notifications, and production signing
remain release smoke tests on real devices and are intentionally not simulated
with stored credentials.
