# Running the app

Use the project launcher from the repository root:

```sh
./run
```

It presents a wizard for any missing platform, device, and flavor. Provide a
selection on the command line to skip that wizard step:

```text
-p, --platform PLATFORM   android | ios | macos | windows | linux
-d, --device-id ID        ID shown by `flutter devices`
    --flavor FLAVOR       dev | prod; Android, iOS, and macOS only
    --no-pub              skip `flutter pub get`
    --dry-run             print commands without running them
-h, --help                show help
```

For everyday development on one connected Android phone:

```sh
./run --platform android --flavor dev
```

The launcher selects the phone automatically if exactly one supported Android
device is connected. To choose explicitly:

```sh
flutter devices
./run -p android -d DEVICE_ID --flavor dev
```

Extra options pass through to `flutter run`:

```sh
./run -p android -d DEVICE_ID --flavor prod --release
./run -p android -d DEVICE_ID --flavor dev \
  --dart-define=OVERSEER_URL=https://overseer.example
```

Windows and Linux do not support native Flutter flavors in this project, so
omit `--flavor` for those platforms.

If a phone is missing, unlock it, enable USB debugging, approve this computer,
and check `flutter devices` again.
