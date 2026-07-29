# TestFlight release

Use the `prod` flavor for every TestFlight build. Its application identifier is
`org.ovrseer.app`, and it connects to `https://overseer.rnm.dev`.

## Apple prerequisites

As of April 28, 2026, App Store Connect requires iOS uploads to be built with
Xcode 26 or later and the iOS 26 SDK or later. The release Mac must also have:

- an Apple Developer account added to Xcode for team `F7KV67KV2U`;
- an App Store Connect app record whose bundle ID is `org.ovrseer.app`;
- Push Notifications enabled for the app App ID;
- Xcode-managed App Store distribution certificates and provisioning profiles;
- the production APNs key configured in Firebase project `overseer-9fe46`; and
- an App Store Connect role that can upload builds.

The source project uses automatic signing. Do not commit certificates,
provisioning profiles, API keys, or App Store Connect credentials.

## Versioning

The release version and build number come from `pubspec.yaml`:

```yaml
version: 1.0.0+3
```

Increment the build number for every upload, even when the marketing version
does not change.

## Release commit and tag

Every TestFlight release includes all non-ignored project changes in a dedicated
commit before the production archive is built. Use this message format:

```text
chore(release): TestFlight 1.0.0+4
```

The release tree must be clean after the commit. After Apple reports the build
as `VALID`, create an annotated tag on that exact commit:

```sh
git tag -a "app-v1.0.0+4" RELEASE_SHA -m "TestFlight 1.0.0 (4)"
```

Never tag a rejected build, and never overwrite or move an existing release
tag. Do not push the commit or tag unless the release task explicitly includes
the push.

## Preflight

```sh
flutter pub get
dart format --output=none --set-exit-if-changed lib test tool
flutter analyze
flutter test
plutil -lint ios/Runner/Info.plist ios/Runner/PrivacyInfo.xcprivacy
```

The app declares `ITSAppUsesNonExemptEncryption = false` because it uses only
exempt standard cryptography supplied by the operating system and standard
network libraries. Reassess this declaration before adding proprietary or
non-standard encryption.

## Build

For the routine agent-driven path, invoke the project skill
`$upload-testflight`. It performs preflight, build-number selection, signing,
direct App Store Connect upload, and status monitoring. Its deterministic local
helper is `.agents/skills/upload-testflight/scripts/testflight_local.sh`.

After the Apple account and provisioning assets are available:

```sh
flutter build ipa --flavor prod --release
```

The archive is written below `build/ios/archive/` and the exported IPA below
`build/ios/ipa/`. In Xcode Organizer, validate the archive before choosing
**Distribute App → App Store Connect → Upload**.

Before upload, inspect the built bundle:

```sh
APP=build/ios/archive/Runner.xcarchive/Products/Applications/Runner.app
plutil -p "$APP/Info.plist"
find "$APP" -name PrivacyInfo.xcprivacy -print
```

The app must use `org.ovrseer.app`.

## App Store Connect information

Apple requires a privacy policy URL and app privacy answers. Base those answers
on the complete production service, not only the mobile binary. Relevant mobile
facts are:

- there is no advertising, tracking, analytics, or Crashlytics SDK;
- Firebase Messaging and Firebase Installations provide push delivery;
- GitHub authentication returns an operator identity and access token;
- prompts, attachments, projects, sessions, and presence are sent to the
  selected Overseer server as app functionality;
- push registration sends a device token plus workspace routing metadata;
- connection-scoped operational data is cached locally in SQLite; and
- authentication tokens remain in the platform Keychain.

Confirm server-side retention, logging, account deletion, and privacy-policy
language before publishing the App Store privacy answers.

Suggested TestFlight information:

- **Beta description:** Monitor Overseer workspaces, Peons, projects, sessions,
  and transcripts from iPhone and iPad, including offline cache, follow-ups,
  and push routing.
- **What to test:** GitHub sign-in; cached/offline reopening; project and
  session navigation; new sessions and queued follow-ups with attachments;
  and push notification routing.
- **Feedback email:** `viktor.ten@me.com`

Internal testers can use a processed build immediately. External testing may
require TestFlight App Review.

## Release smoke test

On a physical iPhone using the uploaded TestFlight build:

1. Complete production GitHub sign-in.
2. Restart and verify token restoration.
3. Open cached workspaces, projects, sessions, and transcripts offline.
4. Reconnect and verify REST/WebSocket reconciliation.
5. Send a new session and an existing-session follow-up with an attachment.
6. Verify foreground, background, and terminated-state push routing.
7. Sign out and confirm notification state is removed.
