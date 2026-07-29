---
name: run-overseer-app
description: Run the Overseer Mobile Flutter app on a connected Android phone, iOS device, emulator, simulator, or desktop target. Use when the user asks to launch, start, run, or test the app locally, choose a platform/device/flavor, or needs the project's run command and supported CLI parameters.
---

# Run Overseer App

Run commands from the project root with `./run`. Prefer the launcher over a
handwritten `flutter run` command because it discovers devices and applies the
project's flavor rules.

## Launch workflow

1. If the user has not specified platform, device, or flavor, run `./run` in an
   interactive terminal and let the wizard collect the missing selections.
2. Pass every selection already known so its wizard step is skipped.
3. For an Android phone, use `--platform android`. If exactly one supported
   Android device is connected, omit `--device-id`; the launcher selects it.
4. Use `dev` for routine development unless the user explicitly wants the
   production deployment.
5. Preserve any extra Flutter run flags; the launcher forwards unknown options.

## Remembered CLI

```text
-p, --platform PLATFORM   android | ios | macos | windows | linux
-d, --device-id ID        ID shown by `flutter devices`
    --flavor FLAVOR       dev | prod; valid on Android, iOS, and macOS
    --no-pub              skip `flutter pub get`
    --dry-run             print resolved commands without launching
-h, --help                show launcher help
```

Windows and Linux do not support native Flutter flavors in this project, so
omit `--flavor` for those platforms. `--release`, `--profile`,
`--dart-define=...`, and other unrecognized arguments pass through to
`flutter run`.

## Common commands

```sh
# Full wizard
./run

# One connected Android phone; choose only the flavor if omitted
./run --platform android --flavor dev

# Skip every selection
./run -p android -d DEVICE_ID --flavor prod --release

# Verify the resolved command safely
./run -p android -d DEVICE_ID --flavor dev --dry-run
```

If Android discovery fails, ask the user to unlock the phone, enable USB
debugging, approve the computer, and verify it appears in `flutter devices`.
