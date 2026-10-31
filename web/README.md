# Web

The operator console, the docs site and the landing page: one Vite + React codebase, two builds. The design pattern is `.scratch/web-console/design.md`.

| Build | Command | Output | Pages |
|---|---|---|---|
| engine | `pnpm build` builds both; `pnpm exec vite build --mode engine` just this one | `dist/engine/` | `/console/*`, `/docs/*` |
| public | `pnpm exec vite build --mode public` | `dist/public/` | `/` (landing), `/docs/*` |

The API process serves `dist/engine/` when it exists (`src/web-static.ts`): any path under `/console/` or `/docs/` gets that page's `index.html`, and `/` redirects to `/console`. The public build is static files for any host; that host must send `/docs/*` to `docs/index.html` the same way.

## Develop

```sh
pnpm install
pnpm dev          # engine build at http://localhost:5173/console
pnpm dev:public   # public build at http://localhost:5173/
```

The console reads a running engine: `pnpm dev` proxies `/v1` to `http://localhost:8420` (`ENGINE_URL` overrides it), and the sign-in page asks for that engine's `AUTH_TOKEN`. Served by the API process instead (`pnpm build`, then start the API), it is the same origin and needs no proxy. What an operator sees is in `docs/console.md`.

`/console/_primitives` is the primitives gallery: the console's own sidebar, rows and docked pane composed into one Dispatches screen on recorded data, then every primitive below it. Its data is in `src/console/fixtures.ts`: the seven Dispatches from the approved board plus one of 1,000 payments, generated from a fixed seed. Fixtures live only there and in tests; the console itself shows nothing it did not read from the engine. `?theme=dark` previews dark for one page view without storing it, on any page.

## Console

- `src/console/api/`: the one boundary to the engine. `client.ts` calls `GET /v1/dispatches`, `GET /v1/dispatch/:id?include=timeline`, `GET /v1/senders` and `POST /v1/dispatch/:id/cancel` with the bearer token, and `parse.ts` turns every body into the types in `src/domain/`. A body of the wrong shape is a visible error, a `401` signs out, and a refusal keeps its `code` (`ALREADY_CLAIMED`). Nothing past it touches JSON. The detail body has no chain, so `findSummary` finds the list row in the millisecond the timeline's `created` entry names.
- `src/console/live.tsx`: `usePoll`, the one polling loop. About every 2 s while anything shown is in flight, doubling to 30 s once all is settled, paused while the tab is hidden, and retried with backoff after a failure, which turns the sidebar's "Live" to "Reconnecting". Senders poll every 15 s, the engine's own cache time.
- `src/console/session.tsx`, `router.tsx`, `Shell.tsx`, `Sidebar.tsx`, `SignIn.tsx`: the token in `sessionStorage`, the three routes (`/console`, `/console/dispatches`, `/console/senders`) and the shell around them. Held and Activity join the nav with `flag-rules`.
- `src/domain/dispatchFlow.ts`: one pure function from a loaded Dispatch (items, statuses, timeline, approval blocks) to the Flow tab's stages: sent and confirmed, a fee-bump or Solana resubmission branch, a Proposal with its votes and deadline, held, failed items as a branch, an expired Relay Dispatch, cancelled, and a Proposal abandoned with `APPROVAL_TIMEOUT`. A large Dispatch is counted ("Confirmed, 612 of 1,000"), never listed. Stage text carries amounts as `Money`, so hidden balances mask them too.
- `src/console/dispatches/`: the list, the pane and its tabs. `query.ts` is everything the page keeps in its URL (`from`, `to`, `chain`, `status`, `mode`, `q`, `dispatch`, `tab`, `items`), so any view can be linked. `data.ts` loads the list a cursor page at a time and re-polls only the pages holding a row in flight; `itemRows.ts` groups items sharing a transaction under it, collapsed beyond 20.

## Look

The design pattern is `.scratch/web-console/design.md`; the approved board is `.scratch/web-console/board-a.html`. Light is the default everywhere. Dark is the viewer's stored choice from the Appearance setting (`ThemeSetting`), never the system preference, and there is no theme toggle in any page header.

- `src/styles/tokens.css`: every design token, as `light-dark()` pairs; `[data-theme='dark']` on `<html>` switches them. Hanken Grotesk for text, Geist Mono for ids, hashes and addresses, both self-hosted.
- Cards and the docked pane are flat, with a hairline. Only things that float over the page have a shadow: the modal, and also the Export menu, the calendar popover and the toast, which would otherwise read as part of the page under them.
- `scripts/check-contrast.ts`: fails `pnpm test` if any text pair the components use (each status pill, ink and muted on every surface, accent text, labels on the accent and danger fills, the toast) is under 4.5:1 in either theme. `--faint-text` is only for disabled labels, which WCAG exempts.

## Layout

- `src/domain/`: the typed tables everything else reads. `status.ts` (status to label and pill tokens), `assets.ts` (amounts and display decimals), `chains.ts` (label, explorer, chain mark), `flow.ts` (stage kind to dot, card, bar segment and line), `dateRange.ts` (presets and day ranges), `dispatch.ts` (the Dispatch, item and timeline shapes the engine reports), `sender.ts` (a Sender, its balances and Signer key, each field readable or degraded).
- `src/components/`: Button, StatusPill, Card, Amount, MonoValue, SenderCard, StackedBar, ChainDot, FlowGraph, Tabs, SegmentedControl, SearchField, DateRangeControl, Menu, Checkbox, TextField, EmptyState, DockedPane, VirtualTable, Toast, EyeToggle, ThemeSetting, FilterMenu. The Modal (and the docs' narrow-screen Sheet) is in `src/motion/Overlay.tsx`; `ModalFrame` is its box without the overlay.
- `src/balances.tsx`: hidden balances, one context remembered per viewer in local storage. Every `Amount` reads it, so balances, totals and item amounts all mask together; units, ids, hashes, counts and bars stay.
- `src/export/`: CSV and Excel writers over typed columns (`columns.ts` has the Dispatches list and the items of one Dispatch), the file names from design.md, and the browser download.
- `src/motion/transitions.ts`: the shared spring and durations. `MotionConfig reducedMotion="user"` (in `src/mount.tsx`) drops every transform under `prefers-reduced-motion` and keeps the fades. Nothing in the console loops.

## Amounts

The engine reports an amount as an integer string in the asset's smallest unit plus the asset's `decimals` (`{ raw: "1250000000", decimals: 6, asset: "USDC" }` is 1,250 USDC). `Amount` takes that shape and all arithmetic is BigInt on the string, never a float: 18-decimal ETH does not fit a double.

- **Display** is fixed per asset: USDC 2 decimals, SOL 4, ETH 4. Any other asset shows up to 6 decimals with trailing zeros trimmed. Rounding is **half to even** (banker's rounding), so `1.005` USDC shows as `1.00` and `1.015` as `1.02`.
- **Exports** carry the exact value at full precision, never the rounded one. CSV writes it as a plain decimal with every one of the asset's decimals (`1250.000000`). Excel writes a number, formatted to the display decimals, only when the number reads back as exactly the same decimal at the asset's precision; otherwise it writes the exact decimal as text, so nothing is lost.
- CSV is UTF-8 with a BOM, a header row, CRLF and RFC 4180 quoting. A text cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe so a spreadsheet does not run it as a formula. Excel files have one sheet, the header row frozen, and dates as real dates. Hidden balances never apply to exports.

## Docs

`/docs` is rendered from the repo's own Markdown at build time; nothing is copied into `web/`. `scripts/docs.ts` runs unified (remark, GFM, GitHub-style heading ids) and Shiki (light and dark) over the files named in `src/docs/nav.ts`, and a Vite plugin serves the result as `virtual:docs` (the page manifest: slug, title, section, headings, HTML, source path) and `virtual:docs-search` (a MiniSearch index of headings and body text, fetched on the first `⌘K`). In `pnpm dev`, editing any Markdown file reloads the page.

- **Navigation** is the one table in `src/docs/nav.ts`: sections in order, each mapped to source files. A section with no files is left out. Every `NNNN-*.md` in `docs/adr/` is listed under Decisions at `/docs/adr/NNNN`. To add a page, add its file to the table; a Markdown file under `docs/` that is in neither the table nor `EXCLUDED_DIRS` (`docs/agents/`) fails the build.
- **Links** between Markdown files (`./signer.md#mainnet-checklist`, `adr/0046-....md`, `../CONTEXT.md`) become site routes. Links to other repo files go to the file on GitHub. A link to a file that does not exist, or to an anchor no heading has, fails `pnpm build`, and `pnpm test` builds the real docs too.
- **API routes:** a heading that is an HTTP method and a path (`` ## `POST /v1/dispatch` ``) gets a method badge, there and in "On this page".
- **Chain tabs:** consecutive fenced blocks that each carry a `title` become one block with a tab per title. Choosing a tab chooses it in every tab group on the page.

  ````md
  ```sh title="Solana"
  curl ... -d '{"chain":"solana", ...}'
  ```

  ```sh title="Base"
  curl ... -d '{"chain":"base", ...}'
  ```
  ````
