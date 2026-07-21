# Overseer Public Website PRD

**Status:** Draft for review
**Owner:** Viktor Ten
**Heroboard:** OVSR-78
**Last updated:** 2026-07-21

## 1. Goal

Create a simple public website that does two things well:

1. Gives visitors an instant understanding of the benefit Overseer provides.
2. Helps interested users set it up and run their first coding-agent session.

The website should feel like a useful product entry point, not a corporate marketing site.

## 2. Product promise

Overseer gives developers and small teams one place to operate Codex and Claude Code sessions running across their own machines.

Visitors should understand this within ten seconds:

> Control your coding agents from anywhere, while they keep working on the machines and project environments you already use.

Overseer is not another coding agent. It is the shared control surface for existing agents.

## 3. Target user

The first website is for developers who already use Codex or Claude Code and:

- Run agents on more than one machine.
- Want to monitor or redirect work away from the terminal.
- Want teammates to see and continue agent sessions.
- Depend on local databases, devices, private networks, credentials, or specialized tooling.

The initial site does not need separate messaging for enterprise buyers or non-technical audiences.

## 4. Primary user journey

The page should lead visitors through one short sequence:

1. **Understand the outcome** — one dashboard for agents on their machines.
2. **See the product** — a real fleet and live-session example.
3. **Understand how it connects** — Overseer, Peon, agent, and project.
4. **Check compatibility** — supported agents, systems, and prerequisites.
5. **Set it up** — follow a short, copyable quick start.
6. **Run the first session** — confirm success with a clear expected result.

The primary CTA is **Get started**. It scrolls or links directly to setup.

The secondary CTA is **View on GitHub**, but it must remain hidden until the repository and license are public.

## 5. Homepage structure

The MVP should be a single page with the following sections.

### 5.1 Hero: immediate understanding

Recommended copy:

**Eyebrow:** Remote control for local coding agents

**Headline:** Your coding agents. Your machines. One command center.

**Supporting copy:** Run, monitor, and coordinate Codex and Claude Code across the development environments you already use.

**Primary CTA:** Get started

**Secondary CTA:** See how it works

The hero must include a current, sanitized screenshot of the actual product. Avoid generic AI artwork.

### 5.2 Benefits

Show no more than four benefit cards:

#### Work from anywhere

Check progress, send follow-ups, queue instructions, or stop a session without returning to its terminal.

#### Keep your real environment

Agents work where your projects, tools, databases, devices, and private services are already configured.

#### See every agent in one place

View connected machines, active sessions, results, files, previews, usage, and failures from one dashboard.

#### Coordinate with your team

Share workspaces while keeping access scoped by machine and project. Presence and authorship show who is operating a session.

### 5.3 Product proof

Use one short visual walkthrough with real product screens:

1. Fleet dashboard with connected machines.
2. Live session transcript with an active tool call or edit.
3. Follow-up queue or remote intervention.
4. File, diff, or artifact preview.

Each visual should have one sentence describing the user outcome. Do not expose real emails, prompts, source code, paths, hostnames, or credentials.

### 5.4 How it works

Explain the architecture in three steps:

1. Install or deploy Overseer.
2. Connect a machine using the lightweight Peon service.
3. Start and control Codex or Claude Code from the web dashboard.

Include this simple diagram:

`Browser → Overseer ← Peon → Codex / Claude Code → Project`

Supporting copy should explain that Peon connects the existing machine to the workspace. Do not claim that code never reaches the configured model provider.

### 5.5 Setup

Setup is a core part of the website, not a footer link.

The section must contain:

- Supported operating systems and architectures.
- Supported Codex and Claude Code versions.
- Required accounts and network access.
- A hosted/self-hosted choice if both are actually available.
- Copyable commands with visible success states.
- A link to troubleshooting immediately beside the instructions.

Recommended setup flow:

#### Step 1: Start Overseer

Provide the shortest supported deployment path. If a managed service is available, offer **Use hosted Overseer** first and **Self-host** second. Otherwise show the verified self-hosting command.

Expected result: the user can open Overseer and sign in.

#### Step 2: Create a workspace

Sign in with GitHub, create a workspace, and choose **Add machine**.

Expected result: Overseer displays a one-time enrollment command or token.

#### Step 3: Install Peon

Show an OS-specific, copyable installation command. The command must come from the current release process rather than being duplicated manually in website content.

Expected result: Peon confirms enrollment without printing the credential.

#### Step 4: Verify the machine

The connected machine should appear online in Overseer. Show the exact UI state the user should see.

If it does not appear, link directly to checks for connectivity, authentication, agent installation, and version compatibility.

#### Step 5: Run the first session

Select a project directory, choose Codex or Claude Code, enter a small prompt, and start the session.

Expected result: the live transcript opens and the session reports progress.

### 5.6 Trust notes

Keep this section short and concrete:

- Agent execution happens on the connected machine.
- Overseer controls access through authenticated workspaces.
- Access can be limited by machine and project.
- The configured model provider may receive code and context according to its own settings and terms.
- Self-hosting details and stored-data behavior must link to technical documentation.

Do not use “fully secure,” “zero trust,” or “your code never leaves your machine.”

### 5.7 Final CTA

**Ready to control your first agent?**

Primary action: **Start setup**
Secondary action when available: **View documentation**

## 6. Setup experience requirements

The setup guide must be maintained as part of the product, not as static marketing copy.

- Commands must be tested against the current release.
- Version numbers should be loaded from one authoritative source where practical.
- Tabs may separate macOS, Linux, and other supported systems.
- Every command must have a copy button and a plain-text fallback.
- Every step must state the expected successful result.
- Errors must link to specific troubleshooting guidance.
- Secrets and enrollment credentials must never enter analytics, URLs, screenshots, or client logs.
- Unsupported systems must be labeled clearly.
- The complete flow should be usable by keyboard and readable on mobile.

Target outcome: a developer with an already-supported agent installation can reach a first Overseer session in ten minutes or less.

## 7. Navigation

Keep navigation minimal:

- Benefits
- How it works
- Setup
- Docs, when available
- GitHub, when public
- Sign in

The persistent primary action should be **Get started**.

## 8. Brand and styling direction

### 8.1 Brand idea

The brand should feel like **calm command over complex work**.

Overseer is powerful, but the website should not look militaristic, authoritarian, or like a fantasy game. It should communicate clarity, control, trust, and technical competence.

Desired traits:

- Calm, not loud.
- Precise, not corporate.
- Technical, not cryptic.
- Capable, not aggressive.
- Human-controlled, not “fully autonomous.”

The visual reference is a modern operations console at night: clear signals, quiet surfaces, real activity, and no decorative noise.

### 8.2 Naming guidance

**Overseer** may remain the working product name, subject to trademark review. Always pair it with a plain descriptor on first use:

> Overseer — remote control for local coding agents

The public brand should reconsider **Peon**. The term has demeaning connotations and reinforces the Warcraft association. A neutral public name such as **Node**, **Runner**, or **Host** will be easier to explain and commercialize. “Overseer Node” is the recommended placeholder in public website copy until naming is finalized.

Avoid fantasy and command-and-conquer vocabulary in public copy. Prefer “machine,” “session,” “workspace,” “operator,” “connect,” and “run.”

### 8.3 Logo direction

Create an original symbol based on an **O-shaped control loop connected to two or three nodes**. It should suggest a shared operating surface and connected machines without becoming a literal eye.

Requirements:

- Recognizable at 16 px as a favicon and at large hero size.
- Works in one color before gradients or effects are applied.
- Simple geometry suitable for SVG and animation.
- Horizontal wordmark and standalone mark variants.
- No helmets, shields, crowns, eyes, runes, fantasy lettering, or game references.
- No permanent glow baked into the asset; glow, when used, is a subtle interface effect.

Use “Overseer” in title case in prose and a clean lowercase or title-case wordmark depending on the selected typeface.

### 8.4 Color scheme

Keep the product's dark operational character, but replace game-themed token names with semantic names. Use green as a controlled signal rather than a fantasy effect.

| Role | Token | Color | Usage |
| --- | --- | --- | --- |
| Page background | `canvas` | `#0B0D0C` | Main page background |
| Primary surface | `surface` | `#121512` | Navigation, cards, code blocks |
| Raised surface | `surface-raised` | `#181D19` | Featured panels and setup steps |
| Border | `border` | `#2B332D` | Quiet one-pixel separation |
| Strong border | `border-strong` | `#465048` | Hover and selected states |
| Primary text | `text` | `#F0F3EC` | Headlines and body copy |
| Secondary text | `text-muted` | `#A0AAA1` | Supporting copy |
| Faint text | `text-faint` | `#758078` | Metadata only |
| Brand signal | `signal` | `#8FCB72` | Primary CTA, active links, key diagram paths |
| Signal hover | `signal-bright` | `#AFE08F` | Hover and highlighted values |
| Dark on signal | `signal-ink` | `#0C1509` | Text on signal-colored fills |
| Informational | `info` | `#72A7F2` | Links and neutral information |
| Warning | `warning` | `#E4A85F` | Setup warnings and degraded state |
| Danger | `danger` | `#E06B5F` | Errors and destructive states |
| Online | `online` | `#4FCB86` | Connected/healthy state only |

Usage rules:

- Keep at least 80% of the page neutral; color should reveal hierarchy and state.
- Reserve filled signal green primarily for the **Get started** action.
- Do not use green simultaneously to mean brand, online, success, and decoration without a label or shape distinction.
- Use no more than one restrained green radial wash in the hero.
- Avoid pure black, pure white, neon green, large gradients, gold ornament, and colored shadows around every card.
- Status must never rely on color alone; pair it with text, shape, or iconography.
- All body text and controls must meet WCAG 2.2 AA contrast.

### 8.5 Typography

Use a neutral open-source sans-serif plus a technical monospace:

- **UI and display:** Geist Sans, Inter, or another verified SIL Open Font License family.
- **Commands and metadata:** Geist Mono, IBM Plex Mono, or another verified open-source monospace.

Recommended scale:

- Hero: `clamp(2.75rem, 7vw, 5.5rem)`, 0.95 line height, slightly negative tracking.
- Section heading: `clamp(1.75rem, 4vw, 3rem)`, 1.05 line height.
- Body: 1rem–1.125rem, 1.6 line height, maximum 68 characters per line.
- Labels: 0.75rem, medium weight; avoid excessive uppercase tracking.
- Commands: 0.875rem–1rem with generous line height.

Remove the current Friz/fantasy-style font from public brand assets. Record the source and license of every shipped font.

### 8.6 Layout and components

- Maximum content width: 1200 px.
- Reading-column width: 680–760 px.
- Use an 8 px spacing system.
- Card radius: 10–12 px; button radius: 8 px.
- Use one-pixel borders and small tonal shifts instead of heavy shadows.
- Keep generous vertical spacing between the hero, benefits, proof, and setup.
- Use a sticky, compact navigation only after scrolling beyond the hero.
- Primary buttons use `signal` fill with `signal-ink` text.
- Secondary buttons use a transparent surface, neutral border, and primary text.
- Setup commands live in high-contrast code panels with copy buttons and visible copied states.
- Setup steps use a numbered vertical sequence on mobile and a stable two-column step/content layout on desktop.

### 8.7 Product imagery and graphics

Actual product UI is the primary visual language.

- Use crisp screenshots with sanitized, believable session data.
- Crop screenshots around the benefit being discussed instead of showing the entire application repeatedly.
- Use subtle depth and a thin border to separate screenshots from the page.
- Create diagrams from simple nodes, connection lines, status dots, and labels using the same semantic palette.
- Use abstract topology patterns only as quiet backgrounds; they must not compete with copy.
- Do not use robots, brains, glowing humanoids, stock server rooms, or generic AI-generated imagery.

### 8.8 Motion

Motion should explain live state, not decorate the page.

- 160–240 ms transitions for buttons, tabs, and cards.
- One slow pulse may indicate a live connection.
- Architecture lines may animate once when entering the viewport.
- Product walkthroughs may use short, controlled crossfades.
- No parallax, constant floating elements, cursor trails, or autoplay video with sound.
- Respect `prefers-reduced-motion` and provide a static equivalent for every animation.

### 8.9 Voice and writing

- Lead with verbs: run, monitor, continue, inspect, connect.
- Prefer short declarative sentences.
- Explain the outcome before the mechanism.
- Name Codex and Claude Code only where compatibility is relevant; do not repeat provider names in every section.
- Avoid “revolutionary,” “supercharge,” “AI workforce,” “digital employees,” and vague claims about productivity.
- Use technical terms such as WebSocket, self-hosted, or MCP only after the basic value is clear.

### 8.10 Homepage styling by section

- **Hero:** near-black canvas, large left-aligned message, one restrained signal glow, product screenshot to the right or directly below.
- **Benefits:** four quiet cards with simple line icons; no illustrations.
- **Product proof:** alternating copy and cropped interface panels, with the application as the visual focus.
- **How it works:** a compact topology diagram on a raised surface.
- **Setup:** the brightest and most actionable section, with numbered steps and copyable commands.
- **Trust notes:** plain text with small status-style icons; no shield imagery or oversized security claims.
- **Final CTA:** short, centered, and visually connected to the setup section rather than presented as a sales banner.

### 8.11 Brand/IP constraints

- Do not use Warcraft, StarCraft, Dota, Blizzard, Valve, or other third-party game assets or names on the public site.
- Replace the current non-commercial sound packs in any public or commercial distribution.
- Verify the Overseer name, service/Node name, logo, font, and distributed assets before launch.
- Include complete font, library, and asset license notices.

## 9. Functional requirements

- Responsive single-page layout.
- Anchor navigation with correct focus behavior.
- Copyable setup commands.
- OS-specific setup tabs where needed.
- Current product screenshots with responsive image delivery.
- Optional GitHub and Docs links controlled by configuration.
- Sign-in link to the existing application.
- Basic privacy-conscious analytics.
- Page metadata, social preview, sitemap, robots rules, and canonical URL.
- Accessible error, empty, and unsupported-platform states in setup.

A CMS, pricing page, blog, customer portal, and self-service billing are out of scope.

## 10. Measurement

Track only the funnel needed to improve understanding and setup:

- Homepage viewed.
- Get started clicked.
- Setup started.
- Operating-system tab selected.
- Install command copied.
- Documentation or troubleshooting opened.
- Sign in clicked.
- Setup completed, if the product can report this without exposing sensitive data.

Primary metrics:

- Percentage of visitors who begin setup.
- Percentage of setup starters who connect a Peon.
- Percentage of connected users who start a first session.
- Median time from setup start to first session.
- Most common failed setup step.

## 11. Launch dependencies

Before publishing setup instructions:

1. Confirm the public installation and update mechanism.
2. Publish tested Peon release artifacts.
3. Decide the open-source license and expose GitHub only when ready.
4. Replace non-commercial and game-derived assets.
5. Document supported systems, provider versions, ports, and network requirements.
6. Create a sanitized demo workspace and current screenshots.
7. Provide actionable troubleshooting for the most likely setup failures.
8. Confirm whether the website points to hosted Overseer, self-hosting, or both.

## 12. Acceptance criteria

The website is ready when:

- A first-time visitor can explain Overseer after reading only the hero and benefits.
- The distinction between Overseer and the underlying coding agents is explicit.
- The page shows real product evidence rather than only claims.
- A developer can find setup from the hero with one action.
- Setup covers installation, enrollment, connection verification, and a first session.
- Every command and supported-version claim has been tested against the current release.
- Every setup step includes an expected result and relevant troubleshooting path.
- The successful setup path takes ten minutes or less for a prepared machine.
- No private data, credentials, internal hostnames, unlicensed assets, or third-party game identity ships.
- The page works on mobile, supports keyboard navigation, and meets WCAG 2.2 AA.
- GitHub, Docs, hosted-service, and open-source claims appear only when those destinations are real.

## 13. Out of scope

- Pricing and packaging strategy.
- Enterprise sales pages.
- Competitor comparison pages.
- Blog or content-marketing program.
- Broad SEO landing-page expansion.
- Website implementation or deployment.
