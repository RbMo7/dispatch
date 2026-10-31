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

`/console/_primitives` shows every primitive and status pill in both themes, with the motion demos.

## Layout

- `src/styles/tokens.css`: every design token. Colours are `light-dark()` pairs, so a theme is a `color-scheme`; `[data-theme]` pins one on the page (the manual toggle, stored in `localStorage`) or on a subtree.
- `src/components/`: Button, Card, StatusPill, ChainDot, MonoValue, EmptyState, ThemeToggle. `status.ts` is the one table from status to label, glyph and tone.
- `src/motion/`: the spring layout list, the pane and modal (`Overlay.tsx`), scroll reveal, and the shared transitions. `MotionConfig reducedMotion="user"` (in `src/mount.tsx`) turns every transform into a plain fade under `prefers-reduced-motion`.
- `scripts/check-contrast.ts`: fails `pnpm test` if any pill's text, or the ink and muted text, is under 4.5:1 against its fill in either theme.

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
