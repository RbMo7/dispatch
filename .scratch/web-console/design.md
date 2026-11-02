# Design pattern: console, landing page and docs site

Companion to `spec.md`. One visual system across three surfaces: the operator console, the public landing page, and `/docs`. Build with the `design-taste-frontend` skill, and treat this file as its brief.

The approved look is board A ("Copilot blue, light") of the primitives canvas reviewed with the operator on 2026-10-31. Its source, `board-a.html` beside this file, is the visual reference for every value below. Where this file and the canvas disagree, this file wins.

## References, and what we take from each

| Reference | What we take |
|---|---|
| [Copilot web: Dashboard and Transactions](https://mobbin.com/apps/copilot-web-3ff8a008-6c14-4f52-9479-1cae4d001464) | The console: a light sidebar, a title bar with a rounded search field, white cards on a pale cool-grey canvas with a quiet "View all ›" link, a dense list grouped under day headings, tinted uppercase category pills, right-aligned tabular amounts, a docked right-hand detail pane with a label and value list, a centred modal for one decision, a calm empty state made of a faint dot field. |
| [Mobbin landing page, hero section](https://mobbin.com/sites/sections/2c52def4-6537-44aa-af28-f41a995a3812) | The landing page's top and bottom: a very large centred headline with real logos set inline between the words and swapping, one grey subline, two pill buttons, the real product in a large rounded light-grey frame, a quiet logo strip, big two-shade statement type, a closing CTA that mirrors the hero. |
| [Webflow feature section](https://mobbin.com/sites/sections/a9e7bd2e-d2ba-4db4-ba7a-bf1ccc40f958) | The landing page's middle: a sticky left in-page nav of plain text links that tracks the scroll, and two-column feature blocks with a visual, a two-line heading and either a short paragraph or a three-item list. |

## Rules that keep it from looking generated

Each of these came out of the design review (taste, redesign, minimalist and high-end lenses) and the operator's feedback. They are hard rules.

- No icons, glyphs or dots inside a pill or badge. A pill is text on a tint.
- No decorative coloured dots. The only dots are the chain marks on the Overview's Sender rows, where the colour names the chain.
- No stock Tailwind greys or hues. The neutrals are one navy-slate family; the status hues are the table below.
- Light is the default on every surface. Dark is opt-in, from Settings.
- Console buttons are 8 px rounded rectangles. Pill buttons exist only on the landing page.
- No em dash or en dash in any UI text. No uppercase except pills, the modal title and method badges.
- No div-built fake screenshots on the landing page: product shots are the real components rendering recorded data.
- No looping animation in the console.
- Real numbers in fixtures and examples, never round or placeholder ones.

## Surfaces and routes

One `web/` codebase, two builds:

- **Public build** (static hosting): the landing page at `/`, and `/docs`.
- **Engine build** (served by the API process, `spec.md`): `/console/*` and `/docs`. `/` redirects to `/console`, so a self-hosted engine never serves a marketing page.

The two builds share tokens, components and the docs renderer.

## Tokens

### Colour

One accent, Copilot blue, flat, with no glow or gradient. It marks the primary action, the selected row and nav item, focus, progress and the current stage of a flow. Every text pair meets 4.5:1, and `web/scripts/check-contrast` enforces it in the test run.

| Token | Light | Dark |
|---|---|---|
| `--canvas` | `#F5F7FA` | `#0E1117` |
| `--surface` (cards, sidebar, panes) | `#FFFFFF` | `#161A22` |
| `--sunken` (segmented track, search, bars, end cards) | `#EEF1F5` | `#1D222C` |
| `--hover` | `#F4F7FB` | `#1B2029` |
| `--border` | `#E5E9EF` | `#262C37` |
| `--border-strong` (inputs, secondary buttons, dashed future stages) | `#D6DCE5` | `#323946` |
| `--ink` | `#18202E` | `#E8ECF2` |
| `--muted` (secondary text, day headings, labels) | `#5B6578` | `#98A2B5` |
| `--faint` (decoration only, never text) | `#B4BCC9` | `#3A4250` |
| `--accent` (primary fill, white label 5.1:1) | `#3468D6` | `#5B8DEF` |
| `--accent-hover` | `#2C5BC0` | `#6E9AF1` |
| `--accent-text` (accent text on surface or soft) | `#2F5FC4` | `#8FB0F5` |
| `--accent-soft` (selected row and nav, current-stage halo) | `#EEF3FF` | `#1B2740` |
| `--accent-mid` (current segment of a progress bar) | `#A9C1F2` | `#3B5C9C` |
| `--ok` / `--ok-text` | `#1E9A5C` / `#127A47` | `#3CC384` / `#6FD39E` |
| `--warn` / `--warn-text` (low free balance) | `#D08A0E` / `#8F5600` | `#E6A43A` / `#F2C066` |
| `--danger` (danger button fill, failed stage) | `#C4321F` | `#F06A6A` |
| `--danger-soft` / `--danger-line` | `#FDEBEC` / `#F3C4C0` | `#2A1617` / `#4A2224` |
| shadow (modal only) | `rgba(24,32,46,.06)` and `rgba(24,32,46,.14)` | `rgba(0,0,0,.35)` and `rgba(0,0,0,.55)` |
| scrim (behind a modal) | `rgba(24,32,46,.34)` | `rgba(5,7,10,.6)` |

Chain marks: Solana `#8B5CF6`, Base `#3B82F6`.

### Status pills

20 px tall, 8 px side padding, fully rounded, 10.5 px, weight 500, 0.06em tracking, uppercase, text only. Colour cross-fades over 160 ms when the status changes; the width does not animate.

| Status | Light text / fill | Dark text / fill |
|---|---|---|
| `queued` | `#48546A` / `#ECEFF4` | `#A9B3C6` / `#222834` |
| `broadcasting` | `#2F5FC4` / `#E9F0FE` | `#8FB0F5` / `#18243B` |
| `awaiting_approval` | `#6A3FC8` / `#F1ECFD` | `#B9A0F2` / `#241C38` |
| `held` | `#B02266` / `#FCEAF2` | `#F08DBA` / `#331726` |
| `confirmed` | `#127A47` / `#E4F5EB` | `#6FD39E` / `#12281D` |
| `partial` | `#8F5600` / `#FFF2D6` | `#F2C066` / `#2E2412` |
| `failed` | `#C0262D` / `#FDEBEC` | `#F59A9A` / `#331819` |
| `abandoned` | `#A8450C` / `#FFEDE2` | `#F5A877` / `#331F13` |
| `cancelled` | `#5F697C` / `#F1F3F6` | `#A2ABBD` / `#20252E` |

### Type

- **Hanken Grotesk** (400, 500, 600) for everything, self-hosted. **Geist Mono** for ids, hashes and addresses at 12.5 px.
- Console scale: 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 18 / 22. Page titles 14 px weight 600, card titles 13 px weight 600, body 13 to 14 px. Weight carries hierarchy, not size.
- Tabular figures on every number.
- **Amounts.** The whole part in ink, the fraction in muted, then the asset unit small (10.5 to 11 px, weight 500, muted). On a headline figure the unit is raised to cap height, like Copilot's raised "$"; in list rows the unit sits on the baseline in a fixed 38 px slot so decimals line up. Decimals are fixed per asset: USDC 2, SOL 4, ETH 4.
- Long hashes and addresses are middle-truncated (`0x7f3a…2a41`), copied on click, full value on hover.
- **Hidden balances.** With balances hidden, every balance and amount renders as `••••` at the same width class, the unit stays visible, and bars keep their proportions. Ids, hashes, counts and statuses stay visible.

### Space, radius, depth

- 4 px grid. Card padding 20 px, gap 20 px between cards.
- Radius: 6 (segmented segments), 8 (buttons, inputs), 10 (flow stage cards), 12 (sidebar Sender cards, modal summary card), 16 (cards, modal), full (pills, search field). The landing product frame alone is 20.
- Cards: 1 px `--border`, no shadow. The detail pane is docked with a hairline, no shadow. Only the modal has a shadow, two layers, navy-tinted.

## Console

### Shell

- **Sidebar, 232 px, white, hairline right.** Product name and a refresh icon on top. Navigation: Overview, Dispatches, Held (with a count), Senders & Keys, Activity; outline icons in muted, 32 px rows, the selected row on `--accent-soft` with accent text.
- **Senders block in the sidebar.** A "Senders" label with "All ›", then one card per Sender (12 px radius, `--canvas` fill, hairline): chain and signing mode on one muted line ("Solana" left, "Squads, 2 of 3" right); the Sender's name; the balance at 18 px with the raised unit; a 4 px committed-versus-free bar; "700.00 committed" and "1,142.30 free" under it; a footer line over a hairline naming who pays fees ("Fees from member key, 0.4182 SOL") or the Signer ("AWS KMS, pinned"). When free funds drop below what open work needs, the bar and the free figure turn `--warn`. The card links to Senders & Keys.
- **Hide balances.** An eye icon button (eye / eye-slash, Phosphor, `aria-pressed`) at the right of the "Senders" label and in the Overview page bar toggles hidden balances everywhere. The choice is per viewer, remembered in local storage.
- Bottom: Docs, then the instance name with "Live" or, in `--warn-text`, "Reconnecting" when polling fails.
- **Page bar, 52 px, white, hairline under.** Title left; controls right.

### Screens

| Screen | Content |
|---|---|
| **Sign-in** | A centred white card on the canvas: product name, instance name, one labelled token field, a primary "Sign in" button, a link to the docs page that explains the token. |
| **Overview** | Cards: **In flight** (22 px number centred, a muted breakdown line, a thin accent line chart with a dashed pace line, 1H / 24H / 7D segmented control); **Senders** (balance and committed bar per Sender); **Needs attention** (oldest unclaimed, awaiting approval, held, abandoned; when empty, the dot field with "Nothing needs you" and a real count); **Recent** (latest 5 Dispatches as rows). |
| **Dispatches** | Page bar: title; **date range** control (segmented "Today / 7 days / 30 days / Custom", Custom opening a two-month calendar popover; it sets `from` and `to`); chain segmented control; status filter menu; search field (id or address); **Export** button (secondary, opens a menu: "CSV" and "Excel (.xlsx)"). Body: rows grouped under day headings, 34 px tall, no dividers: checkbox, name (or "37 payments" when a Dispatch has no label), mono short id, chain as muted text, status pill, amount right-aligned with its unit slot. Hover `--hover`; selected `--accent-soft` with a 2 px accent left edge. Selecting a row opens the detail pane; the selection is in the URL. |
| **Detail pane** | Docked 440 px column. Header: "Managed Dispatch" or "Relay Dispatch", mono id, close. Summary: created time, name, the total at 22 px with the raised unit, the status pill. Tabs: **Flow** (default), **Items**, **Details**. Footer: "Open in explorer" and, while unclaimed, "Cancel Dispatch" (danger). |
| **Flow tab** | A summary line ("Stage 5 of 6, waiting for a block") with elapsed time, a segmented stage bar (done accent, current `--accent-mid`, failed danger, cancelled border-strong), then a vertical graph of stage cards joined by a 2 px line: finished stages have a filled accent dot with a check; the current stage has a ring dot, an accent outline and a soft halo; future stages are dashed and muted; a fee bump or a failure branches off to the right with a curved connector and rejoins. The last card is always the transaction hash: the full mono hash and "View on Basescan / Solscan ›", or why there is none yet ("Appears after execution", "No transaction landed"). For Multisig Senders a stage links out to the Proposal in Squads or Safe. |
| **Items tab** | See "Large Dispatches". |
| **Details tab** | Label and value list: chain, Sender, items, retry policy, Bulk Call, created, claimed, Idempotency-Key. |
| **Cancel modal** | 520 px, 16 px radius, small uppercase grey title centred, close icon. A summary card (name, id, total), one plain paragraph saying what happens, footer with "Keep it" (secondary) and "Cancel Dispatch" (danger fill). |
| **Senders & Keys** | One card per Sender: addresses, mode, threshold, the engine's own key, a balance table (asset, balance, committed, free) and a Signer key block (curve, pins, chain ids) with a green "Pinned to this Safe" or a red "Not pinned" line. The Signer does not report its backend (ADR-0055 keeps it private), so the backend is not shown. |
| **Held, Flag Rules, Activity** | From `flag-rules`, in the same list and pane patterns. |

### Large Dispatches

A Dispatch can carry a thousand payments or more. Nothing in the console may render or compute per item in a way that slows down with that number.

- **Flow tab aggregates.** Stages report counts, not item lists: "Signed and sent, 640 of 1,000", "Confirmed, 612 of 1,000", "Item failures, 3" as a branch that links to the Items tab filtered to failed. A multi-transaction Dispatch's end card reads "1,000 transaction hashes" and offers the first one, "Show all in Items" and an export.
- **Items tab.** A status summary strip of counts per item status that doubles as filter chips; a search field over recipient, call target and hash; a virtualized table (only visible rows in the DOM, fixed 32 px rows) with columns index, recipient or call target, amount and unit, status pill, hash; Export (CSV, Excel) of the current filter.
- **Bundles.** Where several items share one transaction (Solana bundles, Bulk Call, a Proposal), the table groups them under their transaction with a count, collapsed by default beyond 20 rows.
- **List rows** show the item count and the per-asset total, never per-item data.
- **Data.** The console fetches a Dispatch once with its timeline and keeps polling only while it is in flight. Item derivations (counts, filters, search) are memoized and run off the item array once per poll.

### Export

- **Dispatches list:** exports every Dispatch matching the current filters (date range, chain, status, search), walking the API's cursor pages with a visible progress count and a Cancel. Columns: id, mode, chain, status, created, item count, one column per asset total.
- **Items of one Dispatch:** columns index, type, recipient or target, asset, amount, status, transaction hash, error code, error message.
- **Formats:** CSV (UTF-8 with a header row, RFC 4180 quoting) and Excel `.xlsx` (one sheet, header row frozen, amounts as numbers with the asset's decimals, dates as real dates). Files are built in the browser; nothing new on the engine. File names: `dispatches-2026-10-01_2026-10-31.csv`, `dispatch-7f3a91c2-items.xlsx`.
- Hidden balances do not apply to exports. An export is an explicit request for the data, so it always holds real amounts.

## Landing page

Top to bottom:

1. **Nav**: wordmark; Docs, GitHub, Changelog; one pill CTA, "Get started", on the right. A plain bar, not a floating island.
2. **Hero** (Mobbin): centred, two or three lines at up to 88 px, weight 600, -0.035em tracking, line-height 1.02, with real marks (Solana, Base, Squads, Safe, Privy, AWS KMS) set inline and swapping every 3 s. One grey subline. Two pills: "Get started" (ink) and "View on GitHub →" (soft). One label per intent across the page.
3. **Product frame**: the real Dispatches screen and flow graph rendering recorded data, in a 20 px rounded `--sunken` frame.
4. **Works with** strip: the same marks in grey.
5. **Statement**: left-aligned large type in two shades.
6. **Feature blocks** (Webflow): a sticky left nav (Send, Sign, Approve, Watch, then a rule and Compare) that changes colour on the active item; a 160 px / 1fr / 1fr grid with 112 px between rows; each block a real cropped component in a sunken frame (Dispatch rows, a Sender card, an approval stage, the flow graph with a fee-bump branch), a 32 px weight-500 heading, 15 px body at 1.6 line height, or a three-item list.
7. **Code block**: the first Dispatch in `curl` with its real response, light theme, with a copy button.
8. **Closing CTA**, mirroring the hero.
9. **Footer**: Docs, GitHub, License (MIT), Changelog.

## Docs site

Shares the tokens. Three columns: plain-text left navigation, content at a 720 px measure, a quiet "On this page" rail. Light code blocks with a copy button, a language label and Solana / Base tabs. Text-only method badges. `⌘K` search. "Edit this page" on every page.

## Motion

- **Console:** the list reflows with a spring (stiffness about 400, damping about 34) when a poll reorders or inserts rows (a new row enters with 6 px over 180 ms); pill colour cross-fade 160 ms; the detail pane content cross-fades on selection; tab content cross-fades; the modal scales from 0.98 over 160 ms with the scrim fading in. Nothing loops, nothing draws itself in, no parallax.
- **Landing:** sections rise 12 px and fade over 500 ms as they enter, children staggered 60 ms; hero marks swap every 3 s with a short vertical slide; the sticky nav changes colour only.
- **Everywhere:** under `prefers-reduced-motion`, transforms drop and only fades remain. Only `transform` and `opacity` are animated.

## Accessibility

- Text contrast at least 4.5:1 in both themes, checked by the contrast script.
- Every action is keyboard-reachable: `j` / `k` move through list rows, `Enter` opens the pane, `Esc` closes it, `⌘K` searches.
- Focus ring: 2 px accent outline, 2 px offset.
- The eye button is a real toggle (`aria-pressed`, label "Hide balances" / "Show balances").
- Status changes are announced politely, throttled.
