# Landing Page

Audience: a backend engineer or technical founder evaluating whether to integrate Dispatch to send programmatic payouts (payroll, affiliate/creator payouts, claim links to a phone number) across multiple chains. They're deciding in minutes whether this is a real, well-built piece of infrastructure or another thin wrapper. The page's job is to prove the former through specificity, not adjectives, while looking like it belongs in the current wave of ambitious, visually confident DeFi sites rather than a plain SaaS marketing template. Follows `00-brand-and-visual-system.md`, including its Motion section; this doc doesn't repeat those rules.

**Visual direction**: bold, dimensional, current. A 3D hero built from the brand's own mark and geometry (not generic floating coins or a purple-to-cyan gradient blob), 3D-rendered display typography for the headline, and scroll- and cursor-reactive motion throughout. This is a deliberate step up from a flat, static marketing page, and it coexists with the "prove it, don't decorate it" rule rather than replacing it: the 3D moment sits alongside real product substance (a real API request, a real webhook payload, a real claim link), not instead of it.

Single scrolling page, no separate "Product" or "Features" route for v1. Route: `/`.

## Structure, in order

1. Header
2. Hero
3. How it works
4. Chains and assets
5. Built for developers (code + webhooks)
6. Claim payments (the phone-number differentiator)
7. Final CTA
8. Footer

## 3D and Motion System

Read this before the section-by-section plan below; it's the technical and design foundation every "wow" moment on the page builds on.

### The 3D object: the mark, not a generic prop

The hero's centerpiece is a real 3D extrusion of `LogoMark`, the same tall crossed stroke and shield-tailed blades already defined as flat SVG in `web/components/Logo.tsx`. Extruding the brand's own geometry, instead of adding a stock "floating crypto coin" or an abstract glass blob, is what keeps this looking like Dispatch rather than looking like every other DeFi launch page this quarter.

- **Material**: matte dark surface (near `--color-surface-2`), not glass or chrome. A single warm rim light in `--color-accent` catches the mark's edges as it turns, so the accent color still reads as "the one brand color," now expressed as light instead of fill.
- **Motion**: a slow, continuous rotation is the resting state (a plain `gsap.to({ repeat: -1, ease: "none" })` on the mesh's rotation, subtle, a full turn well under a minute, never fast enough to distract from the headline), plus a parallax tilt that responds to cursor position on desktop via `gsap.quickTo()` (the object leans slightly toward the cursor) and to scroll position via ScrollTrigger, scrubbed rather than triggered once (the object recedes and rotates further as the visitor scrolls past the hero, tracking scroll position directly, tying it to the page's own scroll narrative). The continuous rotation is the one exception to "nothing loops forever without a reason" in the visual system's Motion section, because the object *is* the brand mark; treat it the way a physical sign spins outside a shop, not the way a decorative background loop spins. Keep the rotation slow and quiet enough that it reads as ambient presence, not attention-seeking.
- **Companion geometry**: a handful of secondary extruded blades, echoing the mark's own angular tail shapes at a much smaller scale, drift slowly in the background at different depths (real parallax layers, not a particle-system snowstorm; four or five shapes, not forty). This is where "3D effects" earns its plural without turning into visual noise.

### 3D typography

The hero headline (see below) renders as real extruded, lit 3D type built from Geist Sans's own letterforms via `troika-three-text` inside the same Three.js scene as the mark, not a swapped-in display font (`00-brand-and-visual-system.md`'s typography rule still holds: one sans, one mono, everywhere text is flat). The headline catches the same single accent rim light as the mark, so the whole hero reads as one lit environment rather than a 3D object sitting in front of flat text pasted on top.

Subhead, CTAs, nav, and every other line of copy on the page stay ordinary flat 2D Geist Sans. The 3D treatment is reserved for the one headline that needs to make the first impression; if every line of text on the page were extruded, none of them would feel special, and legibility would suffer everywhere it matters most (subhead, body copy, code).

### Implementation

- **`@react-three/fiber`** and **`@react-three/drei`** for the scene (React-idiomatic Three.js), plus **`troika-three-text`** for the 3D headline glyphs. `three` itself as the underlying dependency. This still carries real risk if hand-rolled loosely (leaked geometries and materials, a render loop that outlives its component, camera/lighting setups that drift from what was intended). The GSAP layer below is exactly how that risk gets managed, not left to ad hoc `useEffect` cleanup.
- **GSAP, not `motion`, for every animation on this page**, including the properties of the objects inside the Three.js scene. Concretely:
  - **`gsap` core** for tweens and timelines: the mark and companion-blade rotation, the settle-and-glow on the final CTA, the crossfade between developer-section code tabs.
  - **`gsap/ScrollTrigger`** for everything tied to scroll position: the hero object's recede-and-rotate as the visitor scrolls past, the "See it in code" panel's reveal, the how-it-works connecting line drawing in, the staggered step reveal, the claim-link section's reveal timing. (ScrollTrigger, like the rest of GSAP's plugin set, is free to use, no club membership required.)
  - **`gsap/SplitText`** for the claim-link's character-by-character decode reveal (this is precisely what SplitText is built for: splitting real text into animatable characters without hand-rolling a character-splitting utility).
  - **`gsap.quickTo()`**, not a plain `gsap.to()` repeated on every mouse-move event, for the two cursor-follow effects (the hero buttons' tilt, the chain-row tilt). `quickTo` exists specifically for high-frequency updates like pointer tracking and avoids spawning a new tween on every event.
  - **`gsap.matchMedia()`** for `prefers-reduced-motion` branching (see below) instead of scattering manual media-query checks through each component; it's GSAP's own idiomatic tool for exactly this.
  - **`@gsap/react`'s `useGSAP()` hook** for every GSAP usage inside a React component, including the Three.js scene. It scopes tweens/ScrollTriggers to the component and reverts them automatically on unmount and dependency changes, which is the concrete fix for the class of bug "AI-generated Three.js/animation code" tends to produce: timers, tickers, and ScrollTriggers that outlive the component that created them. Never call `gsap.to()` or create a `ScrollTrigger` directly inside a bare `useEffect` on this page; always go through `useGSAP()`.
  - Drop `motion` (Framer Motion) from this page entirely; one animation library is enough, and it's GSAP. If `motion` ends up unused anywhere else in `web/` once this ships, it's a candidate to remove from `web/package.json`, an engineering call to make when it's actually verified unused, not assumed here.
- **Code-split the 3D scene.** Dynamic-import the Three.js hero component so its bundle cost is paid only by visitors who load the hero, and only after the critical text/CTA content has already painted. The headline's flat-text fallback (see below) is what search engines and first paint see; the 3D render is a progressive enhancement on top of it, not a blocker to it.

### Reduced motion and fallback

Per the visual system's Motion section, `prefers-reduced-motion` is checked in JavaScript before the scene ever mounts, not just relied on via CSS. `gsap.matchMedia()` is the mechanism: register a `(prefers-reduced-motion: no-preference)` branch for every scroll-triggered and ambient animation on the page, and a reduced-motion branch that skips creating them entirely, rather than creating and then trying to neutralize them.

- **Reduced motion or no WebGL support**: render a single static, pre-rendered image of the 3D scene (mark and headline, one frame, no canvas, no JS render loop) in the hero's place. The flat 2D headline text still exists in the DOM underneath it for accessibility and SEO either way; the image is a visual replacement for the canvas, not a replacement for real text.
- **Touch devices**: keep the ambient rotation, drop the cursor-follow tilt (there's no cursor). Scroll-linked motion stays, since scrolling is the primary gesture on mobile anyway.
- **Low-end devices**: cap the secondary background shapes' count and the scene's pixel ratio rather than turning the whole scene off; a slightly simpler scene beats a binary on/off cliff.
- Screen readers get the headline as real text (the 3D canvas is `aria-hidden`, mirroring an `<h1>` that's visually replaced but semantically present), the same pattern `LogoMark`'s SVG already uses (`aria-hidden="true"` on the decorative mark).

## 1. Header

Sticky, `--color-surface` background, `--color-border` bottom hairline (not a shadow: shadows on a dark theme read as muddy, a 1px hairline reads as precise). The header stays out of the 3D system entirely; it's on screen for the whole visit, and constant motion in a persistent nav bar would be fatiguing rather than impressive. The one 3D moment is concentrated in the hero, on purpose.

- Left: `LogoLockup`, links to `/`.
- Center/right: two or three nav links, text only, no icons. `Docs`, `Pricing` (if pricing exists yet; drop it if not, don't put a "Contact us" placeholder in its place).
- Far right: one button, `Sign in` (text link, ink-muted) and one primary CTA button, `Get API key` (`--color-accent` fill, `--color-bg` text) linking to signup.

No hamburger-menu-hides-everything on mobile with only two links. At that link count, let them wrap or stay inline at a smaller size. A hamburger for two links is friction for no reason.

## 2. Hero

Full-width, full-viewport-height on desktop. The 3D scene (mark, secondary blade geometry, extruded headline) occupies the whole hero as an environment, not a boxed-in illustration on one side of a two-column split; that boxed-in treatment is what makes a lot of "DeFi with a 3D graphic" landing pages feel like a stock template with an asset dropped in. Subhead and CTAs sit in flat 2D beneath the 3D headline, left-aligned, on a simple gradient-free dark ground so they stay crisply legible against the scene behind them (a subtle `--color-bg`-to-transparent vignette behind just the text block, not a decorative gradient in its own right, is enough to guarantee contrast).

**Headline** (draft, subject to a taste pass, but locking the mechanism it names; this is the line that renders in 3D):

> Send crypto payouts across chains with one API call.

**Subhead** (flat 2D):

> Dispatch turns a batch of payments into tracked, reliable execution on Base and Solana. One request in, a webhook when every payment settles.

**CTAs**: primary `Get API key` (accent-filled button, same target as header), secondary `Read the docs` (text link with a trailing external-link glyph, the one earned icon use in this section). Buttons get a light interactive tilt on hover, a few degrees of `perspective`/`rotateX` following cursor position within the button's own bounds via `gsap.quickTo()`, the one micro-interaction carried from the hero's 3D language down into an ordinary DOM element. Keep it subtle: a hint of depth on a button, not a fairground effect.

Real API request, kept as a proof point, now living just below the hero fold instead of sharing the hero's spotlight with the 3D scene:

## 2a. See it in code

A compact, full-width strip directly under the hero, `--color-surface` background (the first hairline-separated section, echoing the header's material so the page feels bookended early). One static, syntax-highlighted code panel, mono font, `--color-border` outline, no drop shadow, no browser-chrome mockup frame:

```
POST /v1/dispatch
Authorization: Bearer dsp_live_...
Idempotency-Key: payroll-run-2026-03

{
  "payments": [
    { "id": "alice", "chain": "solana", "asset": "USDC", "recipient": "9vxz...vxyP", "amount": "1200.00" },
    { "id": "bob",   "chain": "base",   "asset": "USDC", "recipient": "0x86B6...deea", "amount": "950.00" }
  ]
}
```

Keep this in sync with `api/src/validation/dispatch.ts` as the API evolves. This panel fades and rises into view once on scroll (a single GSAP/ScrollTrigger reveal, `once: true`, not a loop) and otherwise sits still: it's the "we're serious, here's the real interface" beat right after the "we're bold" beat the hero just made.

## 3. How it works

Not three vague icon-and-adjective cards ("Fast," "Secure," "Reliable"). Four steps, named after real concepts from `CONTEXT.md`, laid out as a horizontal numbered sequence on desktop (a vertical list on mobile), connected by a single thin rule rather than icons:

1. **Dispatch**: submit one or many Payments in a single request, identified by your own Idempotency Key.
2. **Route**: each Payment is grouped by chain and handed to that chain's executor. Solana batches up to five payments per transaction; Base sends one payment per transaction.
3. **Sign and broadcast**: every Tenant's sender wallet is provisioned and held by Dispatch's signing provider. Dispatch never takes custody of your recipients' funds and never asks you for a private key.
4. **Confirm**: a webhook fires as each Payment and the overall Dispatch reach a terminal state. Poll `GET /v1/dispatch/:id` any time in between.

Each step: a large mono step number (`01` through `04`, not a circled-icon badge), a short label, one sentence. No icon per step; the number is the visual anchor, matching the "minimal icons" rule and the industrial character of the wordmark. The connecting rule between steps draws itself in (an SVG stroke animating from 0 to full length via a GSAP tween on `strokeDashoffset`, triggered once by ScrollTrigger as the section enters view) tying the four steps together as a single sequence rather than four unrelated cards. Each step's number and label rise in on the same trigger, staggered a few tens of milliseconds apart left to right (`gsap.timeline()` with a `stagger` value) so the sequence itself feels sequential.

## 4. Chains and assets

A plain table or a simple two-column list, not logo tiles. This directly applies the visual-system rule against token/chain logo icons:

| Chain | Assets |
|---|---|
| `SOLANA` | `USDC`, `SOL` |
| `BASE` | `USDC`, `ETH` |

Each row tilts slightly in 3D space on hover (a small `perspective`/`rotateX`/`rotateY` following cursor position within the row, via `gsap.quickTo()`, the same restrained technique as the hero buttons) with a thin accent-colored border appearing on the hovered row's edge. This is CSS/DOM-level pseudo-3D, not a second WebGL scene; the real Three.js budget stays in the hero.

One line beneath the table: "More chains are added by writing one Chain Executor. Nothing else in the platform changes." This is true (see `CONTEXT.md`'s Chain Executor entry and ADR-0006/0007) and it's a better trust signal to a technical buyer than a roadmap of logos for chains that don't exist yet.

## 5. Built for developers

Two-column layout: left is copy, right rotates between two or three small code panels (idempotency retry, webhook payload) using a lightweight tab control (plain text tabs with an underline on the active one, not pill-shaped tab buttons). Switching tabs crossfades and slightly shifts the panel via a short GSAP timeline rather than a hard cut or a carousel with dots.

Copy covers, in short paragraphs:
- **Idempotency by default.** Resubmitting the same Idempotency Key returns the original Dispatch. Safe to retry a network timeout without double-paying anyone.
- **Webhooks, not polling required.** `dispatch.created`, `payment.broadcasted`, `payment.failed`, `dispatch.completed`, `dispatch.partially_failed`. Configure one URL per Tenant at signup.
- **Manual retry for a failed Payment.** A `FAILED` Payment resets to `QUEUED` on retry, re-batched fresh rather than reusing whatever failed the first time.

Webhook payload sample panel:

```
POST https://your-service.com/webhooks/dispatch
{
  "event": "payment.broadcasted",
  "dispatch_id": "b8f2...",
  "payment_id": "alice",
  "chain": "solana",
  "status": "BROADCASTING",
  "transaction": "5g3k...
}
```

## 6. Claim payments

The phone-number-recipient feature (Claim Provider, ADR-0005/0007) is a real differentiator and deserves its own section rather than a bullet buried in "features." Keep it honest about current scope: Solana only has a real claim link today (TipLink); Base recipients get a wallet with no claim UX yet. Don't oversell it.

**Headline**: "Pay someone who doesn't have a wallet yet."

**Body**: "Send a Payment to a phone number instead of an address. On Solana, Dispatch generates a real, shareable claim link. Everything the link needs to control the funds lives in the URL itself. No account, no app, no custody on Dispatch's end."

No stock photo of a phone. The visual here is the claim-link URL itself: on scroll into view (ScrollTrigger, `once: true`), it types and decodes into place character by character via GSAP's `SplitText` (a brief, one-time terminal-style reveal, not a loop) before settling as a plain mono text string with a `Copy` action, in the same spirit as the hero's "real artifact, not illustration" rule but with its own small motion beat suited to what a claim link actually is: a string of characters that resolves into something spendable.

## 7. Final CTA

Full-width band, `--color-surface` background to separate it from the body without a divider line. Headline restates the core promise in one line, one button (`Get API key`). No secondary link here: by this point in the page, someone who wants the docs already clicked the header link. Don't dilute the one action being asked for.

The extruded mark from the hero reappears here, small, once, as a bookend: a brief settle-and-glow as the section scrolls into view (a GSAP tween on the rim light's intensity, triggered once by ScrollTrigger: brightens for a moment, then holds steady, no repeat), inviting the click without restarting the full hero animation. This is the hero's one deliberate echo, not a second full 3D scene.

## 8. Footer

`--color-surface` background (matches header, bookends the page), `--color-border` top hairline. Stays fully static, like the header; the page's motion budget is spent in the body, not the chrome that surrounds it.

- Left: `LogoMark` (small, roughly 20px) next to "© 2026 Dispatch."
- Right: a short link list: `Docs`, `Status` (if/when a status page exists), `GitHub` (if public). Plain text links, small, `--color-ink-muted`, `--color-ink` on hover. No social icon row (see visual-system rule against icon-soup). If a link genuinely needs an icon (e.g. GitHub's mark, which is an identity, not decoration), that's the one exception, sized to match the text.
- No newsletter signup form. Nothing to promote yet; an empty capture form is a worse signal than no form.

## Responsive and performance notes

- Breakpoint at `768px` is enough for this page: two-column sections stack single-column below it.
- The hero's 3D scene scales its canvas to the viewport rather than cropping; on narrow screens the mark and headline shrink together as one composition instead of the headline reflowing independently of the object behind it.
- The code panels (hero-adjacent and developer section) scale down but never get a horizontal scrollbar the visitor has to discover. Wrap or shrink the font size at narrow widths instead.
- Tap targets (header CTA, final CTA) stay full comfortable button size on mobile; nothing shrinks to an icon-only button to save space.
- Lighthouse/first-paint budget: the flat headline text, subhead, and CTAs must be visible and interactive before the Three.js chunk finishes loading. The 3D scene fades in on top once ready; it never gates the page being usable.
