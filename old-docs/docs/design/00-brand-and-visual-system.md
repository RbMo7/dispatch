# Brand and Visual System

The shared rulebook every other design doc in this folder builds on. If the landing page doc and the dashboard doc ever disagree on a color, a status treatment, or an icon rule, this file wins.

## Reference

Two logo files are checked in for reference at `docs/design/assets/`:

- `logo-mark-reference.jpeg`: the mark alone, a tall crossed stroke with two flared, shield-tailed strokes at its base.
- `logo-lockup-reference.jpeg`: the mark stacked above the wordmark, "DISPATCH" set in a bold, squared-off, stencil-cut display face.

These are reference JPEGs with a flat dark background baked in, not production assets. Don't `<img>` them directly. The mark already has a faithful vector recreation at `web/components/Logo.tsx` (`LogoMark`, pure SVG, `currentColor` fill, scales cleanly from favicon to hero). The lockup does not yet: building a `LogoLockup` component (mark plus an SVG or web-font recreation of the wordmark) is a prerequisite for the landing page work in `01-landing-page.md`, not a nice-to-have. Don't ship a screenshot of the wordmark.

## Logo usage

- **Header**: `LogoLockup` (mark + wordmark). First thing a visitor sees; the full name should be legible without relying on a tagline next to it.
- **Footer**: `LogoMark` alone, small, next to the copyright line. The footer is never someone's first impression of the brand, so the compact mark is enough. Pairing it with the full lockup again is redundant repetition, not reinforcement.
- Never place the mark on a busy background, a photo, or a gradient. It's a flat two-tone (ink-on-bg) mark, and it reads worst exactly where "DeFi" sites usually put it: over a glow or a hero photo.
- No lockup variant with a tagline baked in ("Dispatch, Payments Infrastructure" etc.) as a single image. Tagline is a separate text element, sized and weighted independently, so it can change without touching the logo.

## Color

Don't invent a new palette. `web/app/globals.css` already has one, and it's good. Every design doc in this folder should reference these tokens by name, not by hex, so a future retune is a one-file change:

| Token | Value | Use |
|---|---|---|
| `--color-bg` | `#0a0a0c` | Page background. Never pure black. |
| `--color-surface` | `#131317` | Cards, panels, the header/footer background. |
| `--color-surface-2` | `#1a1a1f` | Nested surface (a row hovered, a code block). |
| `--color-border` / `--color-border-strong` | `#232328` / `#313138` | Hairlines. Strong only for something that needs to visually separate from a busy neighbor. |
| `--color-ink` | `#f1f0ed` | Primary text. Off-white, not `#fff`. |
| `--color-ink-muted` | `#9a9a9d` | Secondary text, labels, timestamps. |
| `--color-ink-faint` | `#616166` | Disabled, placeholder, the least important thing on screen. |
| `--color-accent` | `#ff5a1f` | The one brand color. CTAs, links, the active nav item, focus rings. Nothing else. |
| `--color-accent-soft` | `#3a2013` | Accent's background tint, for a subtle highlight behind accent text/icons. |
| `--color-success` / `-soft` | `#35c07a` / `#113322` | CONFIRMED, DELIVERED, healthy states. |
| `--color-danger` / `-soft` | `#f0483e` / `#3a1512` | FAILED, DEAD, error states. |
| `--color-progress` / `-soft` | `#5b8def` / `#142236` | QUEUED, PROCESSING, BROADCASTING, CONFIRMING: anything mid-flight. |

Rules that follow from this table:

- **One accent, used consistently.** Orange means "act on this" or "this is Dispatch's brand," full stop. It is never a status color. A CONFIRMED row is never orange just because orange is the brand color: that's how you end up with an interface where nothing means anything.
- **Status colors are semantic, not decorative.** Success/danger/progress exist to answer "is this thing okay," not to add variety to a page. If a status doesn't map to one of the three, it's ink-muted, not a fourth color.
- **Dark mode is the only mode**, at least for v1. `globals.css` already sets `color-scheme: dark` unconditionally. Don't design a light theme "for later," it roughly doubles every design decision in this doc for a use case nobody asked for.

## Typography

- **Geist Sans** (already wired via `--font-sans`) for everything a human reads as prose: headings, body copy, nav, buttons.
- **Geist Mono** (`--font-mono`) for everything that's data, not prose: wallet addresses, transaction hashes, dispatch/payment IDs, amounts in tables, API keys, code samples. If a value is copy-pasted by a developer rather than read by a human, it's mono.
- No third display face anywhere text is flat 2D type: headings, nav, buttons, body copy all stay Geist Sans. The one exception is the landing page hero headline, which gets a real 3D-rendered treatment instead of a second flat font (see `01-landing-page.md`'s 3D and Motion System section). That's a dimensionality choice, not a typeface choice: the underlying letterforms are still Geist Sans, extruded and lit, not swapped for a display face.
- Numbers in tables are tabular (`font-variant-numeric: tabular-nums`) wherever they're compared vertically (amounts, counts), so digits align.

## Motion

Two different budgets for two different surfaces:

- **The landing page** (`01-landing-page.md`) is a marketing surface. It gets real dimensionality: a 3D hero, scroll-triggered reveals, cursor-reactive tilt, depth and light. This is a deliberate reversal of this doc's earlier restraint for the *product* screens, not a contradiction of it. A landing page's job is to make an impression once; a dashboard's job is to stay out of the way of someone doing the same task for the two-hundredth time.
- **The dashboard** (`02-dashboard.md`) stays restrained: state changes, hover, and loading feedback only, nothing ambient or decorative. See that doc's rules against pulsing live dots and shimmer loops, unchanged by this section.

Shared rules that apply wherever motion exists, on either surface:

- **`prefers-reduced-motion` always wins**, and for a canvas or WebGL element that means more than pausing a CSS transition. Check the media query in JavaScript before mounting a 3D scene at all, and render a static poster frame in its place. `globals.css` already halts CSS animations and transitions globally; anything running its own render loop (Three.js, a canvas particle field) needs its own explicit check, since the global CSS rule doesn't reach it.
- **One accent, still.** Depth and light in a 3D scene come from value (how dark or light a surface reads) and a single warm rim light in `--color-accent`, not a rainbow gradient. The most common way a "3D DeFi" treatment ends up generic is reaching for a purple-to-cyan gradient because that's what the last ten sites did. Dispatch's mark and its one-orange-accent system is the more distinctive choice precisely because it stays restrained everywhere else.
- **Nothing loops forever without a reason.** A one-time reveal, a response to scroll position, or a response to cursor and hover is earned motion. An idle animation that runs identically whether or not anyone is looking at it (a perpetually spinning object, a looping shimmer) is the thing this doc has argued against from the start. The landing page's 3D budget is for reactive depth, not ambient decoration.
- **Motion never blocks or slows the thing it's decorating.** A 3D hero that delays interactivity, or a scroll-reveal that makes someone wait to read the next section, has failed regardless of how good it looks. See the landing page doc's performance notes for the concrete budget.

## The "no pill, no icon-soup" rule, made concrete

The brief says: no pill-shaped badges, no urgent/alarming status shapes, no decorative logos or photos, minimal icons. Translated into actual components:

**Status is text, not a badge.** No rounded-rectangle chip with a background fill. A status is its semantic color (see table above) applied directly to the text, optionally with a plain leading character for scanability at a glance:

```
CONFIRMED          ← --color-success, no container
PROCESSING         ← --color-progress, no container
FAILED             ← --color-danger, no container
```

This isn't a new invention. `web/app/dispatch/[id]/page.tsx` already does something close to this with its `[webhook: DELIVERED]` bracket convention. The dashboard formalizes that instinct instead of reaching for `@phosphor-icons` badge components and rounded chips, which is where most DeFi dashboards default to and exactly what this brief is reacting against.

**No pulsing/glowing "live" dots.** A live indicator is a static 6px square (not a circle, not a pill) in the semantic color, or just the word "Live" in ink-muted. No animation loop running forever on an idle screen: it reads as busywork, not activity.

**No token/chain logo icons in tables.** A chain or asset is identified by its text code in mono: `SOL`, `BASE`, `USDC`, not a colorful circular token icon. This is the single biggest visual-noise source in typical DeFi UI (a wall of little logos down a table) and the most direct application of "don't use icon everything."

**Icons, when used, are functional, not decorative.** `@phosphor-icons/react` is already a dependency. Keep it, but budget it like a scarce resource:
- Yes: an external-link glyph next to a link that leaves the site, a copy-to-clipboard glyph next to a truncated address, a chevron on a disclosure row.
- No: an icon next to every nav item, every stat card, every feature bullet on the landing page "just because it fills the space." If removing the icon loses zero information, remove it.
- One icon set, one weight (Phosphor's `regular`), one stroke width, throughout. Never mix in emoji as icons: no 🔗 in place of a real "external link" glyph (see `dispatch/[id]/page.tsx`'s current `🔗`, which the dashboard rebuild should replace, not carry forward).

**No photography, no illustration, no partner-logo strips.** The landing page sells trust through specificity (real chains, real numbers, real API) and restraint, not through a hero photo of a laptop or a row of "as seen on" logos Dispatch doesn't have yet. See `01-landing-page.md` for what fills that visual space instead.

## Copy voice

- **No em dashes.** Anywhere: headings, body copy, error messages, this doc's own prose going forward. Use a period, a colon, or restructure the sentence. (This file and the ones after it hold to that rule themselves.)
- Short sentences. Say the mechanism, not the adjective: "Solana payments batch up to 5 per transaction" beats "blazing-fast batched settlement."
- Never invent a stat that isn't real. If there's no verified uptime/volume number yet, the landing page says what the product does, not a fabricated "$2B+ dispatched" banner.
