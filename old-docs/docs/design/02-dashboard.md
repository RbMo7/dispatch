# Dashboard

The authenticated, Tenant-scoped product surface a signed-in human uses to watch their Dispatches, manage API Keys, and see their wallets. Distinct from two other things that already exist and stay out of this doc's scope:

- **The public API** (`POST /v1/dispatch` etc.): the dashboard is a client of it, not a replacement for it.
- **The internal Command Center** (`web/app/dispatch/[id]/page.tsx`): an unauthenticated ops debugging view predating Tenants entirely. It stays as-is for internal use. The dashboard is a new, separate, Tenant-authenticated surface, not a restyle of that page, though the dashboard's dispatch-detail screen (below) ends up conceptually similar and can borrow its grouping logic (batch-by-execution-plan, chain grouping).

Follows `00-brand-and-visual-system.md` throughout. Auth mechanics are `03-sign-in-and-auth.md`; this doc assumes a signed-in session already exists and names the human user "you."

## Backend gaps this doc surfaces

Two screens below need something the API doesn't have yet. Flagging both now so they're scheduled, not discovered mid-build:

1. **No dispatch list endpoint.** `GET /v1/dispatch/:id` exists; a paginated `GET /v1/dispatch` (filterable by status, date range) does not. The Dispatches screen needs it.
2. **No webhook URL update after signup.** `tenants.webhook_url` is only ever set at `POST /v1/tenants` time; there's no authenticated update endpoint. The Settings screen needs one (e.g. `PATCH /v1/tenants/me`).

Wallet balances are deliberately *not* a gap to fix for v1. See the Wallets section below for why.

## Navigation

Left sidebar, fixed, `--color-surface` background, `--color-border` right hairline. Text-only nav items, no icon per item:

- Overview
- Dispatches
- Wallets
- API Keys
- Settings

**Active state**: a 2px `--color-accent` left border on the active item plus accent-colored text. Not a filled pill, not a rounded-rectangle background. A border bar keeps the accent use consistent with the visual system (accent means "this is the thing in focus," applied the same way a focus ring would be) rather than reintroducing a pill shape through the back door.

Top bar (right of the sidebar, spans the content width): Tenant name on the left, a compact account menu on the right. Avatar-less: an account menu triggered by the Tenant name/initials as plain text, not a circular photo avatar, since there are no user photos in this system and a generated-letter avatar is decoration standing in for one.

## Overview

The first screen after sign-in. Answers "is everything okay" in one glance, nothing more.

- **Three stat blocks** in a row (stacking on mobile): Dispatches this week, Success rate (Payments CONFIRMED divided by total non-pending, last 7 days), Pending Payments right now. Plain numbers in large mono type with a small ink-muted label beneath, no icon, no sparkline chart for v1. A chart with only a few days of real data for a new Tenant is decoration, not information. Add it once there's enough history for it to mean something.
- **Recent Dispatches**: the same table component as the Dispatches screen (see below), just the 5 most recent rows, with a "View all" text link to the full screen.
- **Empty state** (a brand-new Tenant with zero Dispatches): no illustration. A single sentence and the exact `curl` command to create their first Dispatch, using their real API key prefix so it's copy-paste close to working: "You haven't sent a Dispatch yet. Here's the fastest way to send one:" followed by a code panel. This mirrors the landing page's "real artifact over illustration" rule and turns the emptiest possible screen into the most useful one.

## Dispatches

**List** (`GET /v1/dispatch`, once it exists): a plain table, not cards. Columns: Dispatch ID (mono, truncated with a copy-on-click), Status, Payments (count), Created. Status uses the text-only treatment from the visual system (`PROCESSING` in progress-blue, `COMPLETED` in success-green, `PARTIALLY_FAILED` in danger-red, no icon, no badge). Row click navigates to detail. A filter row above the table (status dropdown, date range), plain selects, not pill-shaped filter chips.

Live updates: poll on an interval while any visible row is non-terminal, same pattern already proven in `dispatch/[id]/page.tsx` (`refetchInterval` keyed off terminal-status check). No websocket for v1: the existing polling model works and adding a second transport is unjustified complexity for this volume.

**Detail** (`GET /v1/dispatch/:id`): rebuilds `dispatch/[id]/page.tsx`'s information architecture with the actual visual system instead of inline styles and emoji:

- Header: Dispatch ID (mono), status (text treatment), created timestamp.
- Stat row: total, confirmed, processing, and failed Payment counts, the same plain mono-number-plus-label pattern as the Overview stat blocks, for visual consistency across the two screens.
- Payments table, grouped by Execution Plan exactly as today's batching logic groups them: a Solana batch of 5 renders as one bordered group with a one-line "Batch of 5, failed together" note when applicable (this is real, useful information about atomicity, not decoration; keep it, just restyle it as plain text, danger-colored only when the batch actually failed together, not a red box around every batch regardless of status). Columns: Payment ID, Chain, Asset, Amount (mono, right-aligned, tabular), Recipient (truncated mono with copy), Status, Transaction (truncated mono, links to the chain explorer with a trailing external-link glyph, the earned icon use here), Retry action.
- Retry: a text button (`Retry`) that only renders for a `FAILED` Payment, exactly matching the existing backend rule (`services/retry.ts` resets it to `QUEUED` and clears the Execution Plan link). Shows `Retrying…` while the mutation is in flight, matching the existing `retryMutation.isPending` pattern.
- Claim payments: recipients that resolved through the Claim Provider get a plain `Claim link` text link instead of the current emoji, pointing at the real TipLink URL.
- Event log at the bottom: chronological, mono timestamps, event name, and delivery status using the same text-only treatment (`webhook: DELIVERED`, `webhook: DEAD after 4 attempts`). This section already got the "no badge" convention right in the current Command Center; keep that instinct, just move it onto the shared visual-system tokens instead of hardcoded hex.

## Wallets

Shows the Tenant's two provisioned Tenant Wallets (`tenant_wallets`, exposed via `GET /v1/tenants/me`'s `wallets` array): one row per chain, showing chain (mono code) and address (mono, truncated, copy-on-click, plus a plain "View on explorer" link).

**No live balance for v1, on purpose.** Fetching and displaying an accurate on-chain balance means either polling an RPC per wallet per page load (adds latency and a new failure mode to a screen that should be simple) or standing up a balance-caching service. That's real scope, not a UI detail. Ship the address-and-explorer-link version first; a balance column is a clean additive change later once it's worth the backend work, and it does not need to block this screen from shipping.

No wallet-provider logo (no little Solana/Base icon next to the address). Chain identity is the mono chain code, per the visual system's rule against token/chain icons.

## API Keys

The highest-stakes screen in the dashboard: the one place a secret is ever shown in plaintext.

**List**: name, key prefix (`dsp_live_ab12...`, mono), created date, last used (relative time, or "Never" in ink-faint), a `Revoke` text action per row. A revoked key's row moves to a visually de-emphasized state (ink-faint text, no action) rather than disappearing. A Tenant auditing their own key history shouldn't lose the record.

**Create key**: a small inline form (name field, `Create key` button), not a full-page redirect. On success, replace the form with a **one-time reveal panel**: the full secret in a mono block with a `Copy` button and an explicit, plain-text warning line above it: "This is the only time you'll see this key. Copy it now." No dismissible toast, no auto-copy; the panel stays until the person navigates away deliberately. This is the one screen in the whole product where the UX priority overrides "minimal." The warning needs to be impossible to miss, but it earns that through direct language, not an alarming shape or a red banner (which would look like an error, and this isn't one).

**Revoke**: a confirmation step (inline expand, not a modal dialog, to keep focus on the row itself) before the destructive action fires. If it's the Tenant's only active key, the `Revoke` action is disabled with an inline note ("Create another key before revoking this one") rather than letting the click happen and surfacing the backend's 409 as a generic error. The backend already encodes this rule (`routes/tenants.ts`'s "only active key" check); the UI should know it up front instead of discovering it from a failed request.

## Settings

Tenant name (view; rename is out of scope for v1, nothing depends on it being editable yet), webhook URL (view and edit, once the `PATCH /v1/tenants/me` gap above is closed; until then, this field renders read-only with a short note that it's set at signup).

No danger-zone "delete tenant" action for v1. There's no backend support for tenant deletion/offboarding yet, and a UI action with no real effect (or worse, one wired to something half-built) is worse than no action at all.

## Loading and error states

- Skeleton rows (a plain `--color-surface-2` block, no shimmer animation loop) for tables while loading, matching the "no glow, no idle animation" rule from the visual system.
- A failed fetch shows one line of ink-muted text and a `Retry` text action, not a full-page error illustration.
- Every mutation (retry Payment, create/revoke key) shows its pending state on the control that triggered it, not a global spinner overlay.
