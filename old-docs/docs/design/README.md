# Design Docs

Plans for Dispatch's customer-facing surfaces: the landing page, the Tenant dashboard, and the sign-in flow. These are separate from the internal ops Command Center (`web/app/`'s existing barebones pages), which stays as it is.

Read in this order:

1. [`00-brand-and-visual-system.md`](./00-brand-and-visual-system.md): colors, type, logo usage, the status/icon rules everything else follows. Read this one first; the other three assume it.
2. [`01-landing-page.md`](./01-landing-page.md): the public marketing page. **Building first**, per the agreed sequence.
3. [`02-dashboard.md`](./02-dashboard.md): the authenticated Tenant surface. Built after the landing page.
4. [`03-sign-in-and-auth.md`](./03-sign-in-and-auth.md): proposes how a human logs in at all, since today's backend only has machine API Keys. Read before starting the dashboard; it changes the signup story.

`assets/` holds the two reference logo files (`logo-mark-reference.jpeg`, `logo-lockup-reference.jpeg`). Reference only, not production assets. See the vector-recreation note in `00-brand-and-visual-system.md`.

## Build order

Landing page first, then Dashboard and sign-in together. The dashboard doc and the sign-in doc are written now, together, because the dashboard's shape depends on the auth decision, but nothing in either gets built until the landing page ships.

## The brief, as a checklist

Every doc in this folder was written against these constraints. If a future change seems to violate one, that's a signal to revisit the doc, not to quietly ignore the rule:

- **No em dashes.** Anywhere in shipped copy: headings, body text, error messages, this file included.
- **No pill-shaped badges, no urgent/alarming status shapes, no decorative logos or photos.** Status is plain colored text (see the visual system doc's status table), not a badge component. No pulsing "live" dots. No stock photography or illustration standing in for real product content. No token/chain logo icons; chain and asset identity is a mono text code.
- **Minimal icons.** An icon earns its place by carrying information a label couldn't (external-link, copy-to-clipboard, a disclosure chevron). It doesn't decorate a nav item, a stat card, or a feature bullet just to fill space.
- **Professional, DeFi-forward, UX before UI on the product surfaces.** The dashboard's visual interest comes from real product substance (a real API request, a real webhook payload, a real claim link) shown plainly, no gradients, glow, or motion loops there. The landing page carries a bigger, deliberate motion and dimensionality budget instead (a 3D hero built from the brand's own mark, 3D headline typography, scroll- and cursor-reactive motion), while still avoiding the generic version of that look: no purple-to-cyan gradients, no stock floating coins, no ambient loop without a reason. See `00-brand-and-visual-system.md`'s Motion section and `01-landing-page.md`'s 3D and Motion System section for the specifics and the shared ground rules (`prefers-reduced-motion`, one accent color, nothing decorative that blocks the page).

## Known open items

Carried forward from the individual docs so they're visible in one place:

- `GET /v1/dispatch` (a list endpoint) doesn't exist yet. Needed for the Dispatches screen (`02-dashboard.md`).
- `PATCH /v1/tenants/me` (or equivalent) doesn't exist yet. Needed for the Settings screen's webhook URL edit (`02-dashboard.md`).
- The human-login-to-Tenant mapping, and the session-to-API-Key bridge for the dashboard's own backend calls, are proposed but not decided in full (`03-sign-in-and-auth.md`). Resolve with a short follow-up ADR before dashboard implementation starts.
- A `LogoLockup` component (vector mark and wordmark, matching `assets/logo-lockup-reference.jpeg`) needs to be built; only the mark alone exists today (`web/components/Logo.tsx`).
- The landing page needs new dependencies not yet in `web/package.json`: `three`, `@react-three/fiber`, `@react-three/drei`, and `troika-three-text` for the 3D scene, plus `gsap` and `@gsap/react` for every animation on the page, including the 3D scene's own tweens (see `01-landing-page.md`'s 3D and Motion System section). GSAP replaces `motion` (Framer Motion) for this page; if `motion` turns out unused anywhere else once this ships, it's a candidate to drop from `web/package.json`, not assumed here.
