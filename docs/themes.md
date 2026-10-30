# Theme catalog

Overseer has one theme source of truth: the server-owned, declarative
`overseer-theme-v1` manifests under
`apps/server/src/modules/themes/manifests/`. The bundled catalog contains
Ironwood, Parchment, Sterling, Neon Nocturne, Amber Terminal, Candy Static,
Tidepool and Blueprint;
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
by Overseer connection. The compiled six-theme snapshot (it predates Tidepool and Blueprint, which
the app only gets from the server) remains a first-launch
and offline/incompatible-server fallback. Selection stores only the package ID
per Overseer connection and is not synchronized to the server or other devices.

To change or add a bundled theme, edit only the server manifest. Server tests
must validate it and generated CSS; web and Flutter must continue to ignore
unknown capabilities/tokens and reject a manifest missing their required core
color tokens.

## Font tokens

A theme may set `--ov-font-display` (headings), `--ov-font-body` (text) and
`--ov-font-mono` (code). The web app's `--font-*` variables read them and fall
back to its defaults when a theme leaves them out. Manifests cannot load font
files — `url()` is rejected — so values must be font stacks that resolve on
the operator's device, ending in a generic family. Blueprint uses a monospace
display stack; Tidepool uses rounded system fonts. Flutter ignores these tokens.

## Perspective floor

`--ov-app-floor-image` is optional. When a theme sets it, the web app paints
that image on a fixed plane tilted away from the viewer at the bottom of the
screen, fading out toward the horizon (`body::before` in
`apps/web/src/app/index.css`). Neon Nocturne uses it for its grid floor. It is
decoration only and never takes pointer input. Flutter ignores it.

## Text glow

Two optional tokens add `text-shadow`: `--ov-display-text-shadow` on headings,
titles and anything using the display font, and `--ov-accent-text-shadow` on
accent-coloured text. Both default to none. Neon Nocturne uses them.

## Glass message bubbles

`--ov-user-message-backdrop` (a `backdrop-filter` value) and
`--ov-user-message-rim` (a `box-shadow` value) are optional. With a translucent
`--ov-user-message-background` they give the operator's bubble a frosted-glass
look. Neon Nocturne uses them.

## Glass panels

The desktop sidebar, the Files/Docs pane, the composer, home-screen cards and
every `Card` (stats, settings, Armory, project settings) are frosted panels
(`.glass-panel` in `index.css`). Rows and hovers inside a panel are neutral
washes; interactive ones hover with `--ov-hover-wash`. All tokens are optional:

- `--ov-panel-bg` — fill; default surface at 12%.
- `--ov-panel-backdrop` — `backdrop-filter`; default `blur(6px) saturate(1.3)`.
  Keep the blur small: a large one smears thin backgrounds such as Neon
  Nocturne's grid into a flat fill and the panel reads as opaque.
- `--ov-panel-border` — border colour; default ink at 10%.
- `--ov-panel-shadow` — `box-shadow`; default a soft drop shadow.
- `--ov-panel-radius` — corner radius; default `0.75rem`.

Neon Nocturne sets a fainter fill and border.

Rows and quiet buttons hover with `--ov-hover-wash` (`.hover-wash`), default
ink at 6% — a neutral wash rather than the theme's surface colour.

## Typing glow

`--ov-typing-glow` is an optional CSS animation value, normally
`ov-typing-glow 900ms ease-out forwards` (keyframes in `index.css`). When a theme
sets it, freshly typed composer characters flare and cool down over about a
second. `--ov-typing-glow-color` sets the flare colour and
`--ov-typing-glow-shadow` its halo (a `text-shadow` value); both default to the
accent. Neon Nocturne uses lime. The textarea is untouched: a transparent mirror
overlay (`typingGlow.ts`, rendered in `Composer.tsx`) shows only the recent
insertions, so input methods, undo and paste behave as before. Insertions longer
than 200 characters, such as pastes, do not glow, and reduced-motion users get
no animation. Without the token nothing is tracked.


`--ov-composer-heat-shadow` (a `box-shadow` value) is optional. When set, typing
in the composer heats it: an extra copy of that shadow fades in with each
keystroke, capped at full strength, so faster typing settles brighter, and cools
over about a second once typing stops (`composerHeat.ts`). Reduced-motion
users never see it. Neon Nocturne uses a brighter version of its composer glow.

## Borders are softened in the web app

`apps/web/src/app/index.css` maps `--color-edge-subtle`, `--color-edge` and
`--color-edge-strong` through `color-mix(... transparent)` at 50/55/65%, so
every theme's border colours render lighter than declared. The interface is
meant to separate areas by background tint rather than lines.
`--color-edge-emphasis` stays unmixed for focus and scrollbar contrast. Tune the
percentages there rather than editing each theme.
