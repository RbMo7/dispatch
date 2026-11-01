# The web console

The console is a view of one engine, served by the engine's own API process at `/console`. It shows what is in flight, what happened to each Dispatch down to every transaction version, and what each Sender holds. It reads the same `/v1` routes any client can call. Its one write is cancelling a Dispatch the engine has not claimed yet.

## Turn it on

The API process serves the console when the web build exists. Build it once from the repository root:

```sh
pnpm --dir web install
pnpm --dir web build
```

Restart the API. It now serves the console at `/console`, these docs at `/docs`, and redirects `/` to `/console`. Without a build, the API serves only the API. The Docker image builds the console in for you.

## Sign in

Open `http://localhost:8420/console` and paste the engine's `AUTH_TOKEN`, the same token every API request carries as `Authorization: Bearer <token>`. The console checks it against the engine before it keeps it, and keeps it in the browser tab's session storage only, so closing the tab signs you out. If the engine refuses the token later, because it was rotated, the console returns to sign-in and says so.

There is no separate console password and there are no user accounts. Anyone holding `AUTH_TOKEN` sees everything, can cancel, and can submit Dispatches through the API, so treat the console like the API: serve it over TLS, and only to people who may hold the token. The docs need no token.

## The pages

**Overview.** Dispatches in flight, with a breakdown, and Dispatches created over the last hour, day or week against the period before. Each Sender's balance, with how much is committed. What needs you: the oldest unclaimed Dispatch, Proposals awaiting approval, and abandoned items, which may still land. The most recent Dispatches.

**Dispatches.** Every Dispatch, newest first, grouped by day. Filter by date range (today, 7 days, 30 days, or a custom range), chain, status and mode. Type an id, or the start of one, and press Enter to open it. Each row shows the item count, the status and the total per asset. The URL holds the selection, the tab and the filters, so a link opens the same view.

Selecting a row opens its detail pane, with three tabs:

- **Flow** shows each stage the Dispatch has been through, from created to confirmed, with times, down to fee bumps and Solana resubmissions, which branch off to the side, like failed items. The last stage is the transaction hash, with a link to the explorer for the engine's own network. For a Multisig Sender, the approval stage shows the votes, the threshold and the deadline, and links to the Proposal in Squads or Safe. A large Dispatch shows counts per stage ("Confirmed, 612 of 1,000") instead of a line per item.
- **Items** lists every item with its recipient or call target, amount, status and hash. A strip of counts per status doubles as a filter, and a search box finds a recipient, target or hash. Items that share a transaction are grouped under it. The table stays fast at thousands of items.
- **Details** lists the chain, the mode, the Sender, the item count, when the Dispatch was created and claimed, and its id.

**Senders & Keys.** One card per enabled chain: the Sender's address and mode, the multisig and its threshold, the engine's own key, a table of balances with committed and free amounts, and what the Signer reports about the key: its curve, its pins and its chain IDs, and when the worker last read them. A line says plainly whether the key is pinned to this Safe or multisig. The Signer's backend is never shown, because the Signer does not report it.

A field the engine could not read, such as a balance while the RPC is down, shows its error in place, and the rest of the page still loads.

## Live updates

The console polls the API. It refreshes about every 2 seconds while anything on screen is in flight, backs off to 30 seconds once everything shown is final, and stops while the tab is hidden. Senders refresh every 15 seconds, which is how long the engine caches them. When polling fails, the sidebar's **Live** turns to **Reconnecting**, usually because the API process stopped. There is no push, the same as for API callers.

## Cancel a Dispatch

While a Dispatch is still unclaimed, its detail pane has a **Cancel Dispatch** button. It opens a confirmation with the Dispatch's id and total. **Cancel Dispatch** withdraws it: nothing is signed or sent, and every item reads `cancelled`. **Keep it** closes the dialog.

Once the worker has claimed the Dispatch, the button is gone. A cancel that loses the race to the worker is refused with `ALREADY_CLAIMED`, and the console says it is too late. An open multisig Proposal cannot be cancelled here: the pane says to reject it in Squads or Safe instead. [Cancel a Dispatch](../guides/cancel.md) has the rules.

## Hide balances

The eye button next to "Senders" in the sidebar, and in the Overview's page bar, hides every balance and amount at once. Amounts show as `••••`, while units, ids, hashes, counts and statuses stay. Use it before you share your screen. The choice is remembered in this browser only. Exports always hold the real amounts.

## Export

**Export** on the Dispatches page saves every Dispatch that matches the current filters, and **Export** on the Items tab saves the items it shows, as CSV or Excel. [Export from the console](../guides/console-export.md) describes the files.

## Keyboard and appearance

On the Dispatches page, `j` and `k` move through the list, `Enter` opens the selected Dispatch, and `Esc` closes the pane. The console is light by default. The docs site's **Appearance** setting, under its navigation, switches both to dark, and the choice is remembered in this browser. Add `?theme=dark` to a URL to preview dark for one page view. Motion follows your system's reduced-motion setting.
