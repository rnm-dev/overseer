# Theme catalog

Overseer has one theme source of truth: the server-owned, declarative
`overseer-theme-v1` manifests under
`apps/server/src/modules/themes/manifests/`. The bundled catalog contains
Ironwood, Parchment, Sterling, Neon Nocturne, Amber Terminal, and Candy Static;
Ironwood is always the default.

Each manifest contains bounded metadata, an `appearance`, capabilities, and a
map of semantic CSS custom-property tokens. It contains no executable CSS,
JavaScript, Flutter code, remote URLs, or arbitrary asset paths. Server startup
validates identifiers, versions, token names, counts and lengths, rejects CSS
statement/block delimiters and active constructs such as `url()`, `@import`,
and `expression()`, and requires the color-scheme token to match the manifest.

The public, cookie-free endpoints are required before sign-in:

- `GET /api/v1/themes` returns the validated versioned catalog;
- `GET /api/v1/themes.css` deterministically renders the same catalog as CSS
  custom-property blocks keyed by `data-overseer-theme`.

Both responses permit a five-minute public cache and one day of
`stale-while-revalidate`. The web dashboard loads the generated stylesheet
directly and discovers selector metadata from the JSON endpoint. It has only a
minimal Ironwood bootstrap descriptor; it does not carry a second palette.

The Flutter client fetches the JSON catalog independently of authentication,
validates and maps its known semantic color tokens into `ThemeData`, and caches
the last successful raw catalog in device-local shared preferences namespaced
by Overseer connection. The compiled six-theme snapshot remains a first-launch
and offline/incompatible-server fallback. Selection stores only the package ID
per Overseer connection and is not synchronized to the server or other devices.

To change or add a bundled theme, edit only the server manifest. Server tests
must validate it and generated CSS; web and Flutter must continue to ignore
unknown capabilities/tokens and reject a manifest missing their required core
color tokens.
