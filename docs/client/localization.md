# Client localization

The Flutter client uses Flutter `gen-l10n`. English is the source locale and
Russian is the first additional locale. The app follows the operating-system
locale and falls back to English for unsupported languages; there is no
in-app language override.

Translation sources live in `apps/client/lib/l10n/app_en.arb` and
`apps/client/lib/l10n/app_ru.arb`. `apps/client/l10n.yaml` keeps generated Dart
output beside those resources. Run `flutter gen-l10n` after changing either
ARB file, although ordinary Flutter builds also generate localization output.

Current localized coverage is the app title, Overseer connection management,
GitHub sign-in, and core session-composer controls. Dynamic server content,
project/session names, model names, agent output, and backend error text remain
unchanged. Fleet detail, project/files, statistics, Peon settings, Armory, and
the remaining transcript controls still contain English UI strings and should
be migrated incrementally.

Use parameterized messages for dynamic labels and ICU plurals for counts. UI
code reads strings through `context.l10n`; its English fallback keeps isolated
widget hosts and previews usable, while each application `MaterialApp` owns the
real localization delegates and supported-locale list. Every migrated surface
needs a widget test in Russian, and pluralized messages need representative
Russian `one`, `few`, and `many` coverage.
