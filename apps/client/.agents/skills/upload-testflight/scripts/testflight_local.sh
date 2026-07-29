#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/../../../.." && pwd)"
export_options="$script_dir/../assets/ExportOptions.plist"

cd "$project_root"

preflight() {
  flutter pub get
  dart format --output=none --set-exit-if-changed \
    lib test integration_test tool
  flutter analyze
  flutter test
  plutil -lint ios/Runner/Info.plist ios/Runner/PrivacyInfo.xcprivacy
}

build_ipa() {
  if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
    echo "Release tree is dirty. Commit all project changes before building." >&2
    git status --short >&2
    exit 1
  fi
  plutil -lint "$export_options"
  flutter build ipa \
    --flavor prod \
    --release \
    --export-options-plist="$export_options"
}

inspect_ipa() {
  local ipa_path="${IPA_PATH:-}"
  if [[ -z "$ipa_path" ]]; then
    ipa_path="$(find build/ios/ipa -maxdepth 1 -type f -name '*.ipa' -print -quit)"
  fi
  if [[ -z "$ipa_path" || ! -f "$ipa_path" ]]; then
    echo "No IPA found below build/ios/ipa." >&2
    exit 1
  fi

  local inspect_dir
  inspect_dir="$(mktemp -d)"
  trap "rm -rf '$inspect_dir'" EXIT
  unzip -q "$ipa_path" -d "$inspect_dir"

  local app_path
  app_path="$(find "$inspect_dir/Payload" -maxdepth 1 -type d -name '*.app' -print -quit)"

  local app_id app_version app_build encryption aps_environment
  app_id="$(plutil -extract CFBundleIdentifier raw "$app_path/Info.plist")"
  app_version="$(plutil -extract CFBundleShortVersionString raw "$app_path/Info.plist")"
  app_build="$(plutil -extract CFBundleVersion raw "$app_path/Info.plist")"
  encryption="$(plutil -extract ITSAppUsesNonExemptEncryption raw "$app_path/Info.plist")"
  aps_environment="$(
    codesign -d --entitlements :- "$app_path" 2>/dev/null |
      plutil -extract aps-environment raw -o - -
  )"

  [[ "$app_id" == "org.ovrseer.app" ]]
  [[ "$encryption" == "false" ]]
  [[ "$aps_environment" == "production" ]]

  plutil -extract NSCameraUsageDescription raw "$app_path/Info.plist" >/dev/null
  plutil -extract NSMicrophoneUsageDescription raw "$app_path/Info.plist" >/dev/null
  plutil -extract NSPhotoLibraryUsageDescription raw "$app_path/Info.plist" >/dev/null
  plutil -extract NSLocationWhenInUseUsageDescription raw "$app_path/Info.plist" >/dev/null
  codesign --verify --deep --strict --verbose=2 "$app_path"

  printf 'TESTFLIGHT_IPA=%s\n' "$(cd "$(dirname "$ipa_path")" && pwd)/$(basename "$ipa_path")"
  printf 'TESTFLIGHT_VERSION=%s\n' "$app_version"
  printf 'TESTFLIGHT_BUILD=%s\n' "$app_build"
  printf 'TESTFLIGHT_SIZE=%s\n' "$(stat -f '%z' "$ipa_path")"
  printf 'TESTFLIGHT_MD5=%s\n' "$(md5 -q "$ipa_path")"
}

usage() {
  cat <<'EOF'
Usage: testflight_local.sh preflight|build|inspect|release

  preflight  Resolve packages and run release checks.
  build      Require a clean Git tree, then build and export production IPA.
  inspect    Verify bundle IDs, versions, privacy strings, signing, and APNs.
  release    Run all local steps; the tree must already be committed.
EOF
}

case "${1:-release}" in
  preflight)
    preflight
    ;;
  build)
    build_ipa
    ;;
  inspect)
    inspect_ipa
    ;;
  release)
    preflight
    build_ipa
    inspect_ipa
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac
