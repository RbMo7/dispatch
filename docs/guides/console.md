# Use the web console

The console is a read-only view of one engine, served by the engine's own API process at `/console`. It shows what is in flight, what happened to each Dispatch down to every transaction version, and what each Sender holds. The one thing it can change is cancelling a Dispatch the engine has not claimed yet.

The console's pages are being built in this release (issues #122 to #125). This guide describes them as designed in `.scratch/web-console/design.md`. The API routes they read, [`GET /v1/dispatches`](../api/list-dispatches.md), [`GET /v1/dispatch/:id`](../api/get-dispatch.md), [`GET /v1/senders`](../api/senders.md) and [cancel](../api/cancel-dispatch.md), are built and documented.

## Turn it on

The API process serves the console when the web build exists. Build it once from the repository root:

```sh
pnpm --dir web install
pnpm --dir web build
```

Restart the API. It now serves the console at `/console`, these docs at `/docs`, and redirects `/` to `/console`. Without a build, the API serves only the API. The Docker image builds the console in for you.

## Sign in

Open `http://localhost:8420/console` and paste the engine's `AUTH_TOKEN`. The console keeps it in the browser tab's session storage, so closing the tab signs you out. Every page calls the same `/v1` API with that token, and nothing else. There are no user accounts: anyone with the token sees everything and can cancel.

The docs need no token.

## Live updates

The console polls the API. It refreshes about every 2 seconds while anything on screen is in flight, slows down once everything shown is final, and refreshes Senders every 15 seconds. When polling fails, the sidebar's "Live" turns to "Reconnecting". There is no push, the same as for API callers ([ADR-0023](../adr/0023-polling-required-webhooks-later.md)).

## The pages

**Overview.** How many Dispatches are in flight, with a breakdown and a chart over the last hour, day or week. Each Sender's balance with how much is committed. A "Needs attention" card for the oldest unclaimed Dispatch, items awaiting approval, and abandoned items. The five most recent Dispatches.

**Dispatches.** Every Dispatch, newest first, grouped by day. Filter by date range (today, 7 days, 30 days, or a custom range), by chain and by status, and search by id or address. Each row shows the item count, the status and the total per asset. Select a row to open its detail pane. The selection is in the URL, so you can share a link to it.

**The detail pane** has three tabs:

- **Flow** shows each stage the Dispatch has been through, from created to confirmed, with times. A fee bump or a failure branches off to the side. The last stage is the transaction hash with a link to Basescan or Solscan. For a Multisig Sender, the approval stage shows the votes, the threshold and the deadline, and links to the Proposal in Squads or Safe. A large Dispatch shows counts per stage ("Confirmed, 612 of 1,000") instead of a line per item.
- **Items** lists every item with its recipient or call target, amount, status and hash. A strip of counts per status doubles as a filter, and a search box finds a recipient, target or hash. Items that share a transaction are grouped under it. The table stays fast at thousands of items.
- **Details** lists the chain, the Sender, the item count, the Retry Policy, Bulk Call, when it was created and claimed, and the `Idempotency-Key`.

**Senders & Keys.** One card per enabled chain: the Sender's address and mode, the multisig and its threshold, the engine's own key, a table of balances with committed and free amounts, and what the Signer reports about the key: its curve, its pins and its chain IDs. A line says plainly whether the key is pinned to this Safe or multisig. The Signer's backend is never shown, because the Signer does not report it ([ADR-0055](../adr/0055-the-signer-reports-its-pins-and-the-engine-checks-them-at-startup.md)).

## Cancel a Dispatch

While a Dispatch is still unclaimed, its detail pane has a **Cancel Dispatch** button. It opens a confirmation with the Dispatch's id and total. **Cancel Dispatch** withdraws it: nothing is signed or sent, and every item reads `cancelled`. **Keep it** closes the dialog.

Once the worker has claimed the Dispatch, the button is gone, and a cancel that loses the race to the worker is refused with a plain message. A claimed transaction cannot be safely unsent. For an open multisig Proposal the pane says to reject it in Squads or Safe instead. [Cancel a Dispatch](../api/cancel-dispatch.md) has the rules.

## Hide balances

The eye button next to "Senders" in the sidebar, and in the Overview's page bar, hides every balance and amount at once. Amounts show as `••••` and the units, ids, hashes, counts and statuses stay. Use it before you share your screen. The choice is remembered in this browser only. Exports are never hidden, because an export is an explicit request for the data.

## Export

**Export** on the Dispatches page saves every Dispatch that matches the current filters, not only the rows on screen. It walks the list page by page and shows its progress, and you can cancel it. The columns are id, mode, chain, status, created, item count, and one column per asset total.

**Export** on the Items tab saves the items of one Dispatch that match the current filter: index, type, recipient or target, asset, amount, status, transaction hash, error code and error message.

Both offer two formats:

- **CSV**: UTF-8 with a byte order mark, a header row and standard quoting. A text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe, so a spreadsheet does not run it as a formula.
- **Excel (.xlsx)**: one sheet, the header row frozen, and dates as real dates.

Amounts are exact in both. CSV writes the full decimal (`1250.000000` for 1,250 USDC). Excel writes a number when it holds the exact value, and otherwise the exact decimal as text, so an 18-decimal ETH amount never loses digits. The files are built in your browser, and the engine has no export route. File names carry the range or the Dispatch: `dispatches-2026-10-01_2026-10-31.csv`, `dispatch-7f3a91c2-items.xlsx`.

## Keyboard and appearance

`j` and `k` move through the list, `Enter` opens the selected Dispatch, `Esc` closes the pane, and `⌘K` searches. The console is light by default. Choose dark in the Appearance setting, and the choice is remembered in this browser. Motion follows your system's reduced-motion setting.
