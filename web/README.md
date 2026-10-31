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
