# Instructions site

A two-page public site — a landing page and self-hosting documentation at
`/docs/` — living at `/rnm/overseer/site/`. It is a **separate product** — not part
of the Overseer monorepo it currently sits inside, and it shares no code, build,
or deployment path with it. No database, no API, no auth, no backend.

It has **no repository of its own yet**: `/rnm/overseer/site` is not a git
checkout. OVSR-237 creates one and detaches the directory from this tree; the
site does not join the [monorepo](monorepo.md).

## Stack

- **Vite 8** — build and dev server
- **Tailwind CSS v4** — CSS-first config; palette declared in `@theme` in
  `src/styles.css`, mirroring the dashboard tokens in `apps/web/src/index.css`
- **Golos Text Variable** — self-hosted via `@fontsource-variable/golos-text`,
  one 400–900 file with Latin and Cyrillic subsets. Self-hosted rather than
  Google-served so the CSP stays at `font-src 'self'`.
- **Motion 11** — scroll reveals and hero entrance (Web Animations API)
- **Lenis 1.3** — smooth scrolling

The whole page is roughly 26 kB gzipped JS, 6 kB CSS and one font subset, in a
single chunk. No WebGL, no lazy bundle.

Three.js previously rendered a 3D swarm in the hero. It was removed when the
hero became the SVG topology diagram: 132 kB gzipped for one decorative element
with no other use in the project. Weigh that cost again before reintroducing a
renderer.

From `md` up the hero diagram sits on the right and is **absolutely positioned
rather than a grid column**, so the headline and copy keep their own layout. On
a phone the same element goes full width **above the headline**, lifted with
`order-first` on a flex column rather than by moving it up the DOM — source
order stays h1 → copy → diagram so a screen reader reaches the heading before
the image. Being inline SVG, it has no runtime dependency and no failure mode to
handle in JS.

All illustrations are hand-written inline SVG animated with CSS keyframes or
the Web Animations API — no icon library, no sprite files. The hero diagram routes orthogonally: `V`/`H`
runs joined by 8px `A` arc corners, no bezier commands, and no two runs sharing
a segment.

Its connectors are thin semi-transparent lines with a glowing signal travelling
along each. The signal layer reuses the line geometry via `<use>` (dash
properties are inherited, so animating them on the `<use>` drives the referenced
path) and every connector carries `pathLength="100"` to normalize dash units.
JavaScript measures each rendered path, keeps every signal 4 rendered pixels
long, and derives its flight duration from a 144-pixel-per-second speed; launches
are separated by independently randomized 350–1450 ms gaps. Its dash gap is
longer than the whole route, preventing SVG pattern repetition from flashing a
phantom signal at an endpoint. The rest of the page's illustrations still use the older
marching-dash style; unify them if the hero treatment is adopted as the house style.

There is **one copy of the hero diagram**, `viewBox="0 0 320 255"`, serving both
breakpoints — full width above the headline on a phone, absolutely positioned
beside the copy from `md` up.

It was briefly two (a wide desktop row and a portrait 2×2 for phones) because a
four-across row scaled to phone width rendered its labels at about 7px. That was
solved by shrinking the viewBox rather than by keeping a second file: at 320
units wide for the same content, the one SVG renders labels at 8.8px on a phone
and 11.2px in the desktop slot. Widening the viewBox again would reintroduce
the problem.

Each machine is a window-like card: a title bar carrying the machine name and a
single borderless chip inside reading **`coding agent`**. Every box is therefore
the same height and all four connectors leave at `y=44`. Corner radii are small
(4 on boxes, 2 on chips) so the diagram reads as equipment rather than UI cards,
and labels carry no `font-family` attribute so they inherit Golos Text from
`body`.

The Overseer box has no indicator dot — it competed with the signals already
moving along the connectors. Instead the hub gets a warm radial halo behind it,
a second inset outline, and an uppercase letter-spaced `OVERSEER` label. Corner
brackets were tried first and dropped: at this size four short marks read as
stray ticks, while a continuous inner line reads as one deliberate object.

The three client lanes have no box — just centred device glyphs with a name under
them: Max on a monitor, Max on a separate phone lane, and Liz on a phone. A box
around a person would read as one
more machine, which is the wrong idea at the end of the chain.

The chip used to name specific products (`claude code`, `codex`, and before
that `cursor` and `copilot`), which made the diagram a **support claim** nobody
had verified against the daemon. The generic `coding agent` label says the true
thing — a Peon runs one — without promising a vendor list. Keep it generic
unless someone confirms the real one. The machine names (`home pc`, `server`,
`raspberry pi`, `mac mini`) are likewise illustrative, not real fleet
hostnames.

Vite is pinned to 8.x deliberately: the 5.x line that the Overseer dashboard
uses carries dev-server advisories (one high, one moderate), and unlike the
dashboard this dev server is exposed to the public internet at
`dev.ovrseer.org`. On 8.1.5 `npm audit` reports zero vulnerabilities.

## Layout

```
site/
├── index.html          # landing page
├── docs/
│   └── index.html      # self-hosting documentation, served at /docs/
├── src/
│   ├── main.js         # reveals, smooth scroll, card tilt, failsafe
│   └── styles.css      # @theme tokens, SVG keyframes, tilt
├── public/             # copied verbatim into dist/
│   ├── favicon.svg
│   └── _headers        # Cloudflare Pages headers (CSP, caching)
├── vite.config.js
└── Dockerfile          # dev server only; never ships
```

It is a Vite multi-page build — `build.rollupOptions.input` lists both HTML
entries — and both pages share one CSS and one JS chunk.

**Every layout grid declares `grid-cols-1` even when it looks redundant.** A
bare `grid` with only a `md:grid-cols-2` variant has *no* column template below
that breakpoint, so the implicit track is auto-sized — max-content — and grows
past the container instead of clamping to it. That is how the page came to
scroll horizontally on a phone: the widest max-content contribution on the page
was the `whitespace-nowrap` copyable `git clone …` command, and it dragged every
`w-full` illustration SVG out to 707px inside a 390px viewport. `overflow:
hidden` on `.command-value` does not help — a clipped box still makes a
max-content contribution to track sizing. Tailwind's `grid-cols-1` is
`repeat(1, minmax(0, 1fr))`, which is the fix. When adding a section, check the
document's `scrollWidth` against the viewport at 320px and 390px rather than
trusting that it looks right.

The documentation page covers requirements, every environment variable with its
default, a compose file, GitHub OAuth setup, the operator/machine network split,
operations and troubleshooting. **Its content is derived from
`apps/server/src/config.ts`**, not written from memory; re-read that file before
editing the configuration table. It once documented
`OVERSEER_RELEASE_TOKEN/_DIRECTORY/_MAX_BYTES` and mounted `/data/releases` in
the compose sample; migration `033_remove_peon_releases` dropped that surface
and Peon updates come from public npm, so those are gone.

**The enrollment story on the page is the sole supported flow.** The operator
runs `peon remote on`, configures `publicControlUrl`, and runs `peon enroll` to
arm a one-time phrase, then enters the address and phrase in Overseer. Overseer
dials the Peon for enrollment and for every Fleet HTTP call, so the page must
not claim machines work behind NAT with nothing reachable. The retired outbound
`peon-claim-v1` code and its `pair <origin>` semantics no longer exist.

## Page structure

Hero (compact “Agentic workflows for teams.” headline and copy on the left,
topology diagram on the right — above the copy on a phone: four machine
cards, each titled with its name and holding one coding-agent box, wired down to one
Overseer, which fans out through three client lanes: Max on a monitor, Max on a
phone, and Liz on a phone) → **Meet Peon** (the first of three
alternating story steps, all with large mobile-centred headings and no step
eyebrows; the first has an animated Peon
container showing intermittent AI-agent activity: one Agent cell spans three
Project rows, is marked with a two-star AI sparkle glyph (hand-written paths,
replacing the earlier `>_` terminal prompt) and holds the web app's three-dot
typing indicator, a smaller status
dot beside the Peon title gains the web app's fel glow during activity, and one
non-repeating random Project row brightens per phase. One right-side lane is
vertically centred on the Peon box and fades toward the edge; each phase is
causally sequenced along it: an inbound signal arrives, activity starts, then
an outbound signal returns over the same lane before idle resumes. Signals move
at the hero diagram's 144 rendered pixels per second and share the lane fade—inbound brightens
toward Peon, outbound fades toward the edge. A same-width
copyable npm install command sits beneath the container — the real one,
`npm install -g @rnm-dev/peon`, checked against `apps/peon/package.json`;
followed by
persistent Peon connections into an identically styled Overseer shell with
centred lanes on both sides and internal Workspaces, Projects, ACL, History,
Analytics and Integrations blocks in an icon-led 2×3 grid plus a same-width
copyable Docker Compose bootstrap command, then three open-source client
contexts (Office, Remote and Travel) outside any shell, represented by
devices reached by one top lane that splits into three signalled branches. A
borderless row beneath them carries larger monochrome Web, macOS, Linux,
Windows, iOS and Android platform glyphs with compact labels) →
**Collaboration at AI speed** (two concise benefits: shared session history
with live presence, and quantitative analytics broken down by project and
member) →
**Backlog** (four short planned capabilities, each one traceable to a real task
on the board: more ways to sign in, live previews, token and cost analytics, and
context/output limits, plus an invitation to contribute; presented as icon-led
roadmap cards in a 2×2 grid with short descriptions). The earlier set — plugin
registry, custom sound packs, API and webhooks — was removed because nothing on
the board backed it. Keep that test: a card here is a promise, so it needs a
task behind it.

Two cards that *did* have tasks behind them were still removed by request:
outbound enrollment and client-side dictation. Both invite the reader to ask
when, and neither is close enough to answer. The grid dropped to
`sm:grid-cols-2` so four cards read as 2×2 rather than a row of three plus an
orphan; restore `md:grid-cols-3` if a fifth or sixth card ever returns.

The footer closes with a compact product statement, internal links to
Documentation, Backlog and How it works, three positioning chips (Open source,
Self-hosted, Built for teams), and the existing Rainmaker attribution. It adds
no repository link until a public canonical repository URL exists.

All HTML cards, buttons, callouts and code boxes use Tailwind's `rounded-md`
radius. Structural boxes inside illustrations use `rx="4"` for the same visual
language; circles, phones, pills and tiny line placeholders keep geometry
appropriate to their shape.

An **Advantages** section (six tilt cards: per-machine credentials, durable
delivery, resumable sessions, real-time state, project scoping, event history)
was removed outright. Its claims were already carried by "Collaboration at AI
speed", so it read as a second pass over the same ground.
Deleting it also orphaned three CSS animations — `.svg-packet`,
`.svg-packet-late` and `.svg-sweep`, with their `retry-orbit` and `sweep`
keyframes — which were removed with it. If you delete a section, re-check
which `svg-*` classes still have a consumer in `index.html`.

**"Collaboration at AI speed" argues coordination, not scale.** It avoids a
before/after comparison because that framing required assumptions about how
other teams work. It focuses on two collaboration outcomes: shared session
history with live presence, and quantitative metrics split by projects and
members. The section is visually separated with a full-viewport tinted field,
a faint grid and two icon-led cards without step numbers.

Landing-page section headings have no eyebrows; the headline carries the
hierarchy without a repeated uppercase label.

The third story step owns the client story: responsive web plus native mobile
and desktop applications, all open source and connected directly to the user's
Overseer instance. Keep collaboration arguments (hand-off, shared workspace,
presence) in "Collaboration at AI speed" so the sections do not repeat each
other. The web client uses React and Vite; native clients are built with
Flutter.

### Positioning: no instance-specific links

The page advertises Overseer as a **self-hosted** product, so it carries no
links to *instances* — no `overseer.rnm.dev`, no `overseer-dev`, no Heroboard.
Those pointed at Rainmaker's own private deployment and made no sense to a
reader who is meant to run their own.

There is exactly **one deliberate outbound link**: `https://rnm.dev` in the
footer of both pages, attributing the project to the agency it was originally
built for. That is a public site any reader can use, which is the test.

Keep it that way: a link may only be added if a self-hosting reader can actually
use it (public docs, a public repository, this attribution), never an internal
instance. Product copy talks about *your* instance and infrastructure rather
than naming a hostname.

The same rule applies to **anything rendered as text inside the illustrations**.
These SVGs originally carried real Peon hostnames from the Rainmaker fleet; every
machine label is now a generic role name (`home pc`, `server`, `raspberry pi`,
`mac mini` in the hero; `workstation`, `build-01`, `mac-studio`, `server-02`,
`laptop · offline` in the fleet-topology panel). Before publishing any change, check the SVG
`<text>` nodes as well as the copy — real hostnames, project paths, IPs and
member names must never reach this page. The same applies with more force to any
screenshots that get added later, which need a scrubbed demo workspace rather
than a capture of a live fleet.

## Local development

The `site` service in `/rnm/overseer/docker-compose.yml` runs the Vite dev
server on `127.0.0.1:4582`. Source is bind-mounted, so edits hot-reload; HMR
speaks `wss:443` because Cloudflare terminates TLS. After a dependency or
Dockerfile change use `docker compose up -d --build -V site` so the anonymous
`node_modules` volume is renewed.

## Public dev hosting

`dev.ovrseer.org` serves the dev server:

```
Cloudflare → host nginx :80/:443 (nid-dev, 94.247.128.101) → 127.0.0.1:4582
```

- Cloudflare zone `ovrseer.org` (account RNM) — proxied A record
  `dev` → `94.247.128.101`.
- nginx vhost `/etc/nginx/sites-available/dev.ovrseer.org.conf`, symlinked into
  `sites-enabled`.
- The vhost listens on **both** :80 and :443. The :443 block is required
  because the zone is in Cloudflare **Full** mode, so the edge connects back
  over HTTPS; this box has no `default_server` on :443, and an unmatched host
  otherwise lands on an unrelated Rails vhost that answers 403.
- The origin certificate is **self-signed**
  (`/etc/ssl/certs/dev.ovrseer.org.crt`), which Full (non-strict) accepts.
  Moving the zone to **Full (strict)** requires replacing it with a Cloudflare
  Origin CA certificate; moving it to **Flexible** makes the :443 block and the
  certificate unnecessary.

Editing nginx on this box does not need a root shell — `peon` has NOPASSWD
sudo for `install`, `ln`, `nginx`, and `systemctl`, which covers writing the
vhost, enabling it, `nginx -t`, and reloading.

## Deploy

Production hosting is Cloudflare Pages, which is **not yet configured** — no
Pages project exists and no production hostname is assigned.

- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: repository root

`public/_headers` is copied into `dist/` and carries the CSP and cache policy.

This is a different delivery path from the Overseer app itself, which ships to
nid-01 via Kamal — see [index](index.md). Nothing about this site touches that
deployment.

## Conventions

- Every animation is gated on `prefers-reduced-motion` — scroll reveals, SVG
  keyframes, card tilt and the 3D backdrop all stop. The reduced-motion branch
  reveals content instantly rather than animating slowly.
- Content must never depend on JS succeeding. `data-reveal` elements start at
  `opacity: 0`, so `main.js` carries a `try/catch` plus a 3-second failsafe,
  and `index.html` has a `<noscript>` rule.
- No third-party origins — no CDN scripts, fonts, or analytics. `style-src`
  allows `'unsafe-inline'` only because Motion and Lenis write inline style
  attributes while animating.
