# Client themes

The shared server catalog and security contract are in
[theme catalog](../themes.md). The Flutter client consumes its six bundled
`overseer-theme-v1` packages: Ironwood, Parchment, Sterling, Neon Nocturne,
Amber Terminal, and Candy Static. Ironwood is the safe default for a missing,
unknown, or unreadable preference.

Theme selection belongs to an Overseer connection, not to a workspace or
Peon. The selector lives in the main Fleet page's Settings section and the
selected package applies to the complete connection UI, including all of its
workspaces, Peons, projects, sessions, sheets, and dialogs.

The client persists only the package ID in device-local shared preferences.
The storage key is namespaced by the normalized Overseer connection storage
ID, so dev, production, and additional Overseer connections can use different
themes on the same device. The preference is not sent to Overseer or Peon and
does not synchronize between devices. It also caches the last validated raw
catalog per connection for offline use; a compiled snapshot covers first
launch and incompatible or unavailable servers.

Theme package metadata and palettes live in
`apps/client/lib/features/themes/`. `AppTheme.fromPackage` maps a package to
Flutter's semantic `ColorScheme` and shared Material component themes. New UI
must use `Theme.of(context).colorScheme` rather than fixed Ironwood colors so
all bundled light and dark packages remain readable.
