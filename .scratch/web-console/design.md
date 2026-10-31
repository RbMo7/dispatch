# Design pattern: console, landing page and docs site

Companion to `spec.md`. One visual system across three surfaces: the operator console, the public landing page, and `/docs`. Build with the `design-taste-frontend` skill, and treat this file as its brief.

## References, and what we take from each

| Reference | What we take |
|---|---|
| [Copilot web: Dashboard and Transactions](https://mobbin.com/apps/copilot-web-3ff8a008-6c14-4f52-9479-1cae4d001464) | The console shell: a light left sidebar (navigation on top, then grouped "accounts" with a coloured dot and a right-aligned balance, help and settings pinned to the bottom); a page title bar with icon actions and search; white cards on a faint cool-grey canvas, each card with a title and a quiet "View all ›" link; a list grouped under day headings (set in `--ink-muted`) with a checkbox, name, muted secondary text, a tinted category pill and a right-aligned amount; a right-hand detail pane for the selected row; a centred modal for a focused decision; a calm empty state ("You've reviewed 30 transactions"). |
| [Mobbin landing page, hero section](https://mobbin.com/sites/sections/2c52def4-6537-44aa-af28-f41a995a3812) | The landing page: a huge centred headline over three lines with small rounded icons set inline between the words, and the icons cycle; one short grey subline; two pill buttons (solid ink and soft grey with an arrow); the real product shown in a large rounded light-grey frame; a quiet logo strip; generous whitespace; big statement type further down; a closing CTA that mirrors the hero. |
| [Webflow feature section](https://mobbin.com/sites/sections/a9e7bd2e-d2ba-4db4-ba7a-bf1ccc40f958) | The landing page's middle: a sticky left in-page nav (Design / Sell / Grow, a rule, then Compare) that tracks the scroll; two-column feature blocks, each a soft monochrome illustration, then a large two-line heading, then either a short grey paragraph or a three-item icon list. Lots of air between blocks. |

The combination: Copilot's calm, dense and legible data UI for the console; Mobbin's hero and rhythm for the top and bottom of the landing page; Webflow's sticky-nav feature blocks for the middle. All three share near-white canvases, ink type and colour used sparingly, so they sit together without strain.

## Surfaces and routes

One `web/` codebase, two builds:

- **Public build** (static hosting): the landing page at `/`, and `/docs`.
- **Engine build** (served by the API process, `spec.md`): `/console/*` and `/docs`. `/` redirects to `/console`, so a self-hosted engine never serves a marketing page.

The two builds share tokens, components and the docs renderer.

## Tokens

### Colour

Near-monochrome, so colour always means something. Every text pair meets 4.5:1, and `web/scripts/check-contrast` enforces it in the test run. The accent is international orange, used only for "look here": the live indicator, the active nav marker, focus rings, and anything waiting on a person (Held, an approval waiting on Approvers). Primary buttons are ink, as on Mobbin, not accent.

| Token | Light | Dark |
|---|---|---|
| `--canvas` (page) | `#F6F7F9` (Copilot's cool grey) | `#0B0C0E` |
| `--surface` (cards, sidebar, panes) | `#FFFFFF` | `#141518` |
| `--surface-sunken` (product frame, inputs, segmented controls) | `#EEF0F3` | `#1B1D21` |
| `--border` | `#E6E8EC` | `#26282D` |
| `--ink` (primary text, primary button) | `#0E1013` | `#F3F4F6` |
| `--ink-muted` (secondary text, "View all") | `#6B7280` | `#9097A1` |
| `--ink-faint` (placeholders, disabled controls and dividers only, never readable text: it is under 4.5:1) | `#9AA1AC` | `#5F6670` |
| `--accent` | `#FF4F00` | `#FF6A26` |
| `--accent-soft` (accent pill fill) | `#FFEDE5` | `#3A1D10` |
| `--accent-ink` (accent text on `--accent-soft`) | `#C23B00` | `#FF6A26` |

### Status pills

Copilot's tinted pills: a pale fill, saturated text, an optional leading glyph, all caps at 11 px with a little tracking. Every status in `docs/api.md` gets one, and none uses the accent except the two that wait on a person.

| Status | Text / fill (light) | Glyph |
|---|---|---|
| `queued` | `#4B5563` / `#F1F2F4` | hollow dot |
| `broadcasting` | `#1D4ED8` / `#E8EEFF` | pulsing dot |
| `awaiting_approval` | `--accent-ink` / `--accent-soft` | person |
| `held` | `--accent-ink` / `--accent-soft` | pause |
| `confirmed` | `#15803D` / `#E7F7EC` | check |
| `partial` | `#B45309` / `#FEF3E2` | half circle |
| `failed` | `#B91C1C` / `#FDECEC` | cross |
| `abandoned` | `#6B4E16` / `#F6F0E4` | clock |
| `cancelled` | `#5E6573` / `#F1F2F4`, struck-through label | slash |

Dark mode uses the same hues at about 18 % fill opacity on `--surface`, with text one step lighter. Every pill also says its status in words, so colour is never the only signal.

Chains use a coloured dot, like Copilot's account dots: Solana `#9945FF`, Base `#0052FF`.

### Type

- **Geist** for UI and headings; **Geist Mono** for hashes, addresses, ids, amounts in code, and `curl`.
- Tabular numerals everywhere a number lines up (balances, amounts, counts).
- Scale: 12 / 13 / 14 (body) / 16 / 20 / 28 / 40 / 64 / 88. The landing hero is 88 px at a tight −3 % tracking, set over three lines like Mobbin's. Console page titles are 16 px semibold, as in Copilot; the console never uses display sizes.
- Long hashes and addresses are middle-truncated (`5Kq3…9fPa`) with copy-on-click and the full value in a tooltip.

### Space, radius, depth

- 4 px grid. Card padding 20 px, a 16 px gap between cards, sidebar items 32 px tall.
- Radius: 8 for inputs and pills (pills fully rounded), 16 for cards, 20 for modals and the landing product frame, 9999 for buttons. Buttons are pills, as on Mobbin.
- Depth: cards have a 1 px `--border` and no shadow; modals and the detail pane get one soft shadow (`0 12px 32px rgb(14 16 19 / 0.10)`) and dim the page behind them, as Copilot does.

## Console

### Shell (from Copilot)

- **Left sidebar, 240 px:**
  - Collapse and refresh icons at the top.
  - Navigation: Overview, Dispatches, Held, Senders & Keys, Activity. Held and Activity arrive with `flag-rules`.
  - **Senders** grouped by chain, like Copilot's accounts: a chain-coloured dot, a short label (`Solana · Squads`), and the native balance right-aligned.
  - Pinned to the bottom: Docs, the instance name (with a live dot that turns accent when polling fails), and Sign out.
- **Page bar:** the title on the left; filter, search and refresh icons on the right.
- **Content:** cards on `--canvas`, in a 12-column grid that collapses to one column under 768 px. On phones the sidebar becomes a sheet.

### Screens

| Screen | Derived from | Content |
|---|---|---|
| **Sign-in** | Copilot's centred modal, on a blank canvas | Instance name, one token field (`AUTH_TOKEN`, or `OPERATOR_TOKEN` once `flag-rules` ships), and a link to the docs page that explains it. |
| **Overview** | Copilot Dashboard | Cards: **In flight** (a big number with a per-status split, like "$4,465 left"); **Last 24 hours** (a confirmed / failed / abandoned line chart with 1H / 24H / 7D tabs, like Net worth's range tabs); **Needs attention** (oldest unclaimed Dispatch, Dispatches awaiting approval, holds, abandoned items; when there is none, Copilot's calm empty state: "Nothing needs you"); **Senders** (a balance per chain with a committed-amount bar, like Top categories); **Recent** (the latest 5 Dispatches, like "Next two weeks"). |
| **Dispatches** | Copilot Transactions | A list grouped under day headings. Row: short id (mono), a chain dot, mode, item count, a tinted status pill, and the per-asset total right-aligned. Filters are chips in the page bar. Selecting a row opens the detail pane on the right without leaving the list. |
| **Dispatch detail pane** | Copilot's right pane | Header: id, created time, the total in large type, and the status pill. Sections: Items (recipient or call target, amount, status, hash link to an explorer); an Approval block for Multisig Senders (votes as an `n / m` bar, the deadline countdown, an "Open in Squads / Safe" button); a Hold block (`flag-rules`); a Timeline. Actions: **Cancel**, only while unclaimed. For an open Proposal, a disabled Cancel that explains why and links to the multisig app. |
| **Timeline** | none; ours | A vertical rail. Each node shows a time (relative, with absolute on hover), what happened, and the hash. Fee-bump versions and Solana resubmissions branch off the rail and rejoin it at the version that landed. |
| **Cancel / Release modal** | Copilot's Split transaction modal | Summary card at the top (id, item count, totals), what will happen in one sentence, then Cancel and the action button. Release also has a required reason field. |
| **Senders & Keys** | Copilot's accounts list plus its detail pane | One card per chain: Sender address, mode, the multisig or Safe and its threshold, the engine's own key, a balance table (asset, balance, committed, available), and a **Signer key** block (curve, pins, chain ids, backend) with a green "pinned to this multisig" or a red "not pinned" line. Never any secret. |
| **Held** (`flag-rules`) | The Dispatches list, filtered | Oldest first, with time held. The detail pane highlights the matched items and names the rules. |
| **Flag Rules** (`flag-rules`) | Copilot's Categories, as a list with an editor pane | Rule rows with an on/off switch; the editor in the right pane, with a live preview card ("would have held 4 of 212 Dispatches in the last 30 days"). |
| **Activity** (`flag-rules`) | The Dispatches list | Day-grouped rows: action, target, reason, time. |

## Landing page

Top to bottom:

1. **Nav** (Mobbin): wordmark; Docs, GitHub, Changelog; a pill "Get started" on the right.
2. **Hero** (Mobbin): three centred lines at 88 px, with small rounded tiles inline between the words, for example "Send ◎ transactions / that ✓ land, / every ⟳ time". The tiles cycle through chain logos and status glyphs. Under it, one grey line ("A self-hosted engine that signs, sends, retries and confirms your Solana and Base transactions."), then two pills: **Read the docs** (ink) and **View on GitHub →** (soft).
3. **Product frame** (Mobbin): the console's Dispatches screen in a 20 px rounded `--surface-sunken` frame, as a real rendering of the components with recorded data. A row's pill steps from `broadcasting` to `confirmed` on a loop.
4. **Works with** strip (Mobbin's logo strip): Solana, Base, Squads, Safe, Privy, AWS KMS, in grey.
5. **Statement** (Mobbin's "Design research took hours"): large type, two shades. "Sending one transaction is easy. Sending ten thousand that all land is the job." Grey continuation: "nonces, expiry, fee bumps, approvals, retries."
6. **Feature blocks** (Webflow): a sticky left nav (**Send · Sign · Approve · Watch**, a rule, then **Compare**) that highlights as you scroll. Two-column blocks, each a soft monochrome illustration in one accent tint, a two-line heading, then a short paragraph or a three-item icon list. For example:
   - *Send:* "Batches that never double-pay": idempotency keys, nonce sequencing, Bulk Call.
   - *Sign:* "Your keys stay somewhere else": a Signer behind its own policy; Privy, AWS KMS, local.
   - *Approve:* "A human on every transfer, if you want one": Squads and Safe.
   - *Watch:* "Every status, every attempt": the console timeline.
   - *Compare:* a plain table of what the engine does and doesn't do.
7. **Code block** (instead of Mobbin's testimonial): your first Dispatch in `curl`, with a copy button and the real response under it.
8. **Closing CTA** (mirrors the hero): "Run it on your own server." with the same two pills.
9. **Footer:** Docs, GitHub, License (MIT), Changelog.

## Docs site

Shares the tokens. Three columns: a left navigation grouped as in `spec.md` (Get started, Concepts, API reference, Guides, Operations, Decisions); the content at a 720 px measure; an "On this page" rail on the right that tracks the scroll. Code blocks have a copy button, a language label, and a tab switch where an example differs by chain (Solana / Base). Each API route has a method badge (`GET` / `POST`, in the status-pill style). Search opens with `⌘K`. Every page has "Edit this page", linking to the Markdown file.

## Motion

Two registers: expressive on the landing page, quiet in the console.

- **Landing:**
  - Sections fade in and rise 16 px as they enter, with children staggered by 60 ms.
  - The hero's inline tiles swap every 2.4 s with a vertical slide.
  - The sticky nav marker slides between items.
  - The product frame drifts up slightly as you scroll (an 8 % parallax).
- **Console:**
  - Spring layout animation (stiffness about 400, damping about 34) whenever a poll changes a row or a list. A new row slides in from the top, and a re-sorted row glides to its place.
  - A status pill cross-fades its colour and morphs its width over 200 ms when the status changes; a `broadcasting` dot pulses.
  - Timeline nodes draw in along the rail in order on first open; later nodes appear with a 150 ms fade.
  - The detail pane slides in from the right over 240 ms, and the modal scales from 0.96 with a backdrop fade.
- **Everywhere:**
  - With `prefers-reduced-motion`, motion becomes plain fades or is removed, and nothing loops.
  - Only `transform` and `opacity` are animated; layout is never animated by `top` or `left`.

## Accessibility

- Text contrast is at least 4.5:1 in both themes; pill text is at least 4.5:1 against its fill.
- Every action is keyboard-reachable: `j` / `k` move through list rows, `Enter` opens the detail pane, `Esc` closes it, `⌘K` searches.
- The focus ring is a 2 px accent outline with a 2 px offset.
- Live status changes are announced politely by a screen reader ("Dispatch 7f3a… confirmed"), throttled.
