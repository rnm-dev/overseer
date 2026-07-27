# UI kit

The shared UI kit lives in `lib/shared/` and is exported from
`lib/shared/ui_kit.dart`. Feature presentation code should prefer its semantic
primitives over raw Material buttons, cards, list tiles, and text fields.

## Component roles

Choose a component by meaning before choosing its visual variant:

| Need | Component | Guidance |
| --- | --- | --- |
| Page or panel background | `Surface` | Use variants for standard, subtle, inset, or highlighted regions. Interactive surfaces are reserved for content that acts as one large target. |
| Group related content | `AppCard` | A non-interactive surface with canonical card padding and radius. |
| Submit or invoke an action | `AppButton` | `primary` is the single strongest action in a scope; `secondary` is an alternative; `ghost` is low emphasis; `danger` is destructive. |
| Navigate or change a setting | `AppListTile` | Shared row geometry, border, states, and touch target. Supply a clear semantics hint for the result of tapping. |
| Open a domain entity | `EntityListTile` | Semantic wrapper around `AppListTile` for servers, projects, sessions, files, and similar entities. |
| Enter or edit a value | `AppTextField` | Shared labels, helper/error treatment, focus state, and optional monospaced values. |
| Show compact state | `StatusDot` / `StatusBadge` | Dot for terse live presence; badge when the state needs a readable label. |
| Show a person | `UserAvatar` | User-supplied images always fill the circular bounds with `BoxFit.cover`; missing or failed images fall back to the person's initial. |
| Show sidebar row state | `SidebarStatusEdge` | Two-pixel full-height inset edge for project/session rows. It owns steady status glow and the one-shot live-update flare. |
| Introduce a page | `AppPageHeader` | A focused title and optional supporting sentence for setup, authentication, and empty-entry pages. |
| Introduce a section | `AppSectionHeader` | A quiet, borderless heading above standalone rows or content. It may carry one low-emphasis action. |

## Interaction hierarchy

- Use one primary button per card, sheet, or focused form whenever possible.
- Reserve green for primary action, selection, and live status. Structural
  headings use the neutral text palette.
- Do not use destructive styling for navigation or sign-out affordances before
  the confirmation step; the confirmation action itself is destructive.
- List rows that navigate should describe the destination in their semantics
  hint. Settings rows should describe the change they control.
- Disabled controls remain visible and retain their label; loading buttons
  block repeat submission and preserve their size.
- Compact rows keep a 44 logical-pixel minimum target. Standard rows keep a
  56 logical-pixel minimum target.

Project and session navigation rows follow the web sidebar contract instead of
the standalone-list contract: the row is full bleed, its content uses
12-pixel left and 8-pixel right padding, and its two-pixel status edge is inset
four pixels vertically at the absolute left. Running work is green, unread
completed work is forge amber, failures are blood red, and idle rows use
`boneFaint` at 40% opacity. A changed row flares once for 620 ms; an idle row's
flare falls back to `fel`. Initial list hydration does not flare, and
reduced-motion settings suppress the animation.

## Composition

Feature-specific widgets may wrap these components to add domain meaning.
They should not duplicate borders, radii, pressed colors, or touch-target
geometry. `EntityListTile` is the reference pattern: it retains an entity-level
API while delegating its visual contract to `AppListTile`.
`AppListTile.titleTrailing` places compact metadata such as presence directly
after the title while preserving title truncation and shared row geometry.

Use the shared spacing scale (`xxs`, `xs`, `sm`, `md`, `lg`, `xl`, `xxl`) for
new composition. Mobile page gutters are 12 logical pixels. Controls use a
10-pixel radius, standalone rows use 12, and grouped surfaces use 16.

Cards are not default page structure. Use them only when a boundary helps the
user understand a related form, summary, or preview. Workspace and settings
indexes use `AppSectionHeader` followed by standalone `AppListTile` rows.

Use `AppListTileVariant.sectionSurface` for full-bleed rows that continue the
session section-header surface: it uses the same five-percent bone background,
square corners, and no border.

Pinned section headers retain that translucent surface and apply a clipped
12-pixel backdrop blur so content scrolling underneath reads as frosted glass
without blurring the rest of the viewport.

All modal sheets enter through `showAppBottomSheet` and compose
`AppBottomSheet` (or the option/confirmation wrappers). Sheet titles, fields,
actions, and option rows share the same 16-pixel content grid.

## Branding graphics

Keep product logos and decorative hero artwork on the native splash only.
Loading and restoration render the destination surface immediately with
shimmers for unavailable content; they must not introduce a branded
interstitial page. Product pages use typography, spacing, surfaces, and
controls for hierarchy and must not render `OverseerLogo` or
`sign-in-hero.png`.
