---
name: upload-testflight
description: Build, sign, validate, upload, and monitor an Overseer Mobile production iOS release in TestFlight. Use when the user asks to upload, publish, ship, retry, or check a TestFlight build, or wants a low-friction production iOS release.
---

# Upload to TestFlight

Run the complete release from the repository root. Continue until the build is
`VALID` or Apple returns a concrete validation failure. Use the `prod` flavor
only.

## Workflow

1. Read `docs/testflight.md`.
2. Show `git status --short`. A dirty tree is allowed, but state clearly that
   the release contains the current local files. Never discard unrelated work.
3. Resolve the App Store Connect app by exact bundle ID `org.ovrseer.app`.
   Read existing builds and build uploads.
4. Set the next build number in `pubspec.yaml` with `apply_patch`:
   `max(local build number, all numeric App Store build and committed build
   upload numbers) + 1`.
   Keep the marketing version unless the user requests a version change.
5. Run:

   ```sh
   .agents/skills/upload-testflight/scripts/testflight_local.sh preflight
   ```

6. Stage and commit the complete release tree:

   ```sh
   git add -A
   git commit -m "chore(release): TestFlight MARKETING_VERSION+BUILD_NUMBER"
   ```

   Require `git status --porcelain --untracked-files=all` to be empty after
   the commit. Record the release commit SHA. Include all non-ignored project
   changes; never silently omit an unrelated tracked change.
7. Ensure an active `IOS_APP_STORE` profile exists for the app bundle ID and
   the installed distribution certificate:

   - `org.ovrseer.app` → profile name `Overseer App Store`
   - team `F7KV67KV2U`

   Reuse active profiles. Create a missing profile through App Store Connect
   only as part of the requested upload. Install `profileContent` below
   `~/Library/Developer/Xcode/UserData/Provisioning Profiles/` using its UUID.
   Never print, commit, or persist API credentials.
8. Run:

   ```sh
   .agents/skills/upload-testflight/scripts/testflight_local.sh build
   .agents/skills/upload-testflight/scripts/testflight_local.sh inspect
   ```

   If macOS asks to access the distribution private key, ask the user to click
   **Always Allow**. Do not attempt to automate `SecurityAgent`.
9. Read [references/direct-upload.md](references/direct-upload.md) and upload
   the IPA through the App Store Connect Build Upload API.
10. Poll the build upload until it creates a build, then poll the build until
   `processingState` is `VALID`, `FAILED`, or `INVALID`.
11. Confirm `usesNonExemptEncryption` is `false`. Inspect internal beta groups;
    report whether an all-builds group already grants access. Do not add
    external testers, submit beta review, or release to the App Store unless
    explicitly requested.
12. After the build becomes `VALID`, create an annotated tag on the recorded
    release commit:

    ```sh
    git tag -a "vMARKETING_VERSION+BUILD_NUMBER" RELEASE_SHA \
      -m "TestFlight MARKETING_VERSION (BUILD_NUMBER)"
    ```

    Verify the tag resolves to the release commit. Never overwrite or move an
    existing tag. Do not push the commit or tag unless the user asks.

## Retry rules

- Reuse a reservation only when a transient chunk transfer failed before the
  file was committed.
- After Apple commits the file and rejects validation, fix only the reported
  issue, increment the build number again, rerun preflight, create a new
  release commit, rebuild, and create a new upload. Leave the rejected release
  commit untagged.
- Do not delete failed uploads unless the user asks.
- Do not mark success merely because all chunks uploaded. Success requires a
  visible build with `processingState: VALID`.

## Final report

Report the marketing version, build number, final Apple state, beta-group
access, IPA path, release commit SHA, tag, push state, and every source file
changed by the release workflow.
