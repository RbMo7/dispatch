# The web console

The console is a view of one engine, served by the engine's own API process at `/console`. It shows what is in flight, what happened to each Dispatch down to every transaction version, and what each Sender holds. It reads the same `/v1` routes any client can call, and writes through them too. With the API token you can cancel a Dispatch the engine has not claimed yet. With the operator token you can also release held Dispatches, write Flag Rules, and add, disable and enable Known Assets.

## Turn it on

The API process serves the console when the web build exists. Build it once from the repository root:

```sh
pnpm --dir web install
pnpm --dir web build
```

Restart the API. It now serves the console at `/console`, these docs at `/docs`, and redirects `/` to `/console`. Without a build, the API serves only the API. The Docker image builds the console in for you.

## Sign in

Open `http://localhost:8420/console` and paste a token: the engine's `AUTH_TOKEN`, or its `OPERATOR_TOKEN`. The console checks it against the engine before it keeps it, and asks the engine which of the two it is. It keeps the token in the browser tab's session storage only, so closing the tab signs you out. If the engine refuses the token later, because it was rotated, the console returns to sign-in and says so.

- **An API token session** shows Overview, Dispatches, Senders & Keys, Assets and Setup, and can cancel unclaimed Dispatches.
- **An operator token session** adds Held, Flag Rules, Activity and Rejected, and the buttons that release, write rules and change assets.

There is no separate console password and there are no user accounts. Anyone holding `AUTH_TOKEN` sees every Dispatch, can cancel, and can submit Dispatches through the API, so treat the console like the API: serve it over TLS, and only to people who may hold the token. Give `OPERATOR_TOKEN` only to the people who review holds. [Authentication](../authentication.md#the-operator-token) explains the split. The docs need no token.

## The pages

**Overview.** Dispatches in flight, with a breakdown, and Dispatches created over the last hour, day or week against the period before. Each Sender's balance, with how much is committed. What needs you: the oldest unclaimed Dispatch, Proposals awaiting approval, abandoned items, which may still land, any failing setup check, and, in an operator session, how many requests the engine refused in the last 24 hours. The most recent Dispatches.

**Dispatches.** Every Dispatch, newest first, grouped by day. Filter by date range (today, 7 days, 30 days, or a custom range), chain, status and mode, and by Sender when a chain has more than one. On a chain with more than one Sender, each row names its Sender. Type an id, or the start of one, and press Enter to open it. Each row is named by what the Dispatch carries, such as "3 payments", "2 calls" or "1 payment, 1 call", and shows the status and every asset's total, so a Dispatch paying in two assets shows both. The URL holds the selection, the tab and the filters, so a link opens the same view.

Selecting a row opens its detail pane, with three tabs:

- **Flow** shows each stage the Dispatch has been through, from created to confirmed, with times, down to fee bumps, each with the fees before and after ("max fee 0.012 to 0.015 gwei"), Solana resubmissions and Base payments sent again after another sender took their nonce ("Nonce 3124 was taken by another sender. Sent again with nonce 3127."), which branch off to the side, like failed items. The last stage is the transaction hash, with a link to the explorer for the engine's own network. A Dispatch where some items landed and some failed lists every transaction it sent, each with how it ended. A Bulk Call's send stage names the aggregator and `allowFailure`. A held Dispatch's Held stage names each rule that matched, its limit and the items it matched, and stays in the flow once the Dispatch is released, with when and the reason given, or cancelled, with the cancel reason. For a Multisig Sender, the approval stage reads like "1 of 2 approved, 1 more needed", lists each Approver with their decision (approved, rejected or pending), shows the deadline, and links to the Proposal in Squads or Safe. An Approver shows by the label the senders file gives them (`approvers`), or by address. A large Dispatch shows counts per stage ("Confirmed, 612 of 1,000") instead of a line per item.
- **Items** names the assets the payments are in, such as "Paid in USD Coin (USDC)", then lists every item with its recipient or call target, amount, status and hash. A failed item says why beside its recipient, such as "Reverted: always reverts" or "Not enough funds", with the engine's own message where the kind of error alone says too little, and what to do on hover. A strip of counts per status doubles as a filter, and a search box finds a recipient, target or hash. Items that share a transaction are grouped under it, labelled as a Bulk Call on a Bulk Call. A Relay Dispatch's Items shows its one transaction: its target, the native value it moves, its status and hash. The table stays fast at thousands of items. For a Multisig Sender, each Proposal the items sit in is shown above the table, with its approvals, its Approvers and their decisions, its deadline and a link to Squads or Safe.
- **Details** lists the chain, the mode, the Sender's name and address, the item count, the total of each asset with its symbol and name, the Retry Policy, the Bulk Call's aggregator and settings, when the Dispatch was created and claimed, and its id. For a Relay Dispatch it names the address that signed the transaction, its target and the value it moves, read from the signed bytes. For a Multisig Sender it also shows the same approval block as Items.

**Held.** Operator sessions only. Every Dispatch a [Flag Rule](../guides/flag-rules.md) is holding, oldest first, with the rules holding it and how long it has waited. The sidebar shows the count beside **Held**. Selecting one shows each rule that matched, with the items it matched tinted, and two decisions. **Release** asks for a reason, which the activity record keeps, and lets the Dispatch go ahead. **Cancel** withdraws it. Once released, the Dispatch shows when, and the reason given.

**Flag Rules.** Operator sessions only. Every rule, each with a switch that turns it on or off. **New rule**, or selecting a rule, opens the editor: a name, the chain, the Sender it checks or every Sender on the chain, the kind, and that kind's parameters, such as the asset and the limit. While you type, **Preview, last 30 days** shows how many of the chain's recent Managed Dispatches the rule would have held. Saving an edit makes a new version of the rule, and the editor lists every version under **Versions**.

**Senders & Keys.** Every Sender, grouped by enabled chain, with the chain's default marked: the Sender's address and mode, the multisig and its threshold, the engine's own key, a table of balances with committed and free amounts, and what the Signer reports about the key: its curve, its pins and its chain IDs, and when the worker last read them. A line says plainly whether the key is pinned to this Safe or multisig. When the worker found another sender using a Base Sender's wallet in the last 24 hours, the Sender says which nonces it used and what to do, and its sidebar card warns too ([One engine per Sender](./configuration.md#one-engine-per-sender)). The Signer's backend is never shown, because the Signer does not report it.

**Assets.** The Known Assets of each enabled chain, one tab per chain: each asset's name, symbol, address (click to copy), decimals, kind (native, SPL, Token-2022 or ERC-20), where it came from, and whether it is enabled. Assets from `SOLANA_KNOWN_TOKENS`, `BASE_KNOWN_TOKENS` and the native coins say "Configuration" and are read-only here: change the variable and restart. With the operator token, **Add asset** opens a form on the current chain. Paste the mint or contract address, and a symbol if the token has none or its own is taken, then **Preview** reads it from the chain: its name, symbol, decimals and supply. Nothing is stored until you confirm with **Add**. A refusal is explained in place, such as an address that is not a token, a mint the engine can't pay out (a transfer fee or hook), a token publishing no symbol, a symbol already used on the chain, or a token already known. An asset added here has a switch to disable it, so no new payment can name it, or to enable it again, each after a confirmation that takes an optional reason. Nothing is ever deleted, and every add, disable and enable is in Activity. A link to `/console/assets?chain=base&add=<address>` opens the form with the address filled in, and `&symbol=<symbol>` fills in the symbol. A symbol alone opens the form too, with the cursor in the address field: that is where the Rejected page sends a payment in an unknown asset. [Add a token with Known Assets](../guides/assets.md) walks through it.

**Contracts.** The contracts and programs registered on each enabled chain, one tab per chain: each one's label, address, what it was registered with (an ABI on Base, an Anchor IDL on Solana), who added it and when, and whether it is enabled. A registration explains calls to that address: which function ran, with which arguments, and the events it emitted, for calls already sent too. Contracts the built-in decoders know (ERC-20, ERC-721, ERC-1155, WETH and Multicall3 on Base; System, SPL Token, Token-2022, Associated Token Account, Memo and Compute Budget on Solana) need no registration. With the operator token, **Add** takes a label and the pasted ABI or IDL, and **Preview** lists the functions and events it explains, or says what is wrong and where, before anything is stored. A registration is never deleted: disable it, after a confirmation that takes an optional reason, and add a corrected one, since an address has at most one enabled registration. In Items, a call no decoder knows reads as its selector with **Add ABI** (**Add IDL** on Solana), which opens this page with the chain and address filled in. [Register an ABI or IDL](../guides/register-a-contract.md) walks through it.

**Activity.** Operator sessions only. The activity record, newest first, by day: every cancel, release, Flag Rule change, Known Asset change and contract registration change, with which token made it and the reason given. It reads [List operator actions](../openapi.yaml#list-operator-actions).

**Setup.** The same checks as `pnpm dispatch doctor`, from [Get the setup checks](../openapi.yaml#get-the-setup-checks). A summary says "All good" or how many things need you, then one card per area lists each check with its status, what it found, how to fix it, and when it last ran. The worker runs its checks at start and every five minutes. The database and console checks run when the page loads. A failing check also shows in the Overview's Needs attention. The page is read-only: configuration lives in files on the server. [Setup checks](./doctor.md) explains each check and its fix.

**Rejected.** Operator sessions only. Every request to create a Dispatch that the engine refused, such as a payment in an asset it does not know, newest first, by day, from [List refused requests](../openapi.yaml#list-refused-requests). Each row has the error code, what it means in plain words, what to do, the chain, the `Idempotency-Key` and which token sent it, and the request body on demand. Where the console can take you to the fix, a link does: an unknown asset links to Assets with the chain and the symbol filled in. Records are kept 30 days (`REJECTED_RETENTION_DAYS`) and at most 10,000.

Wherever an error shows, in Items, in the Flow tab's failed stages and on the Rejected page, the console explains it from one table of every error code the API documents: a title, what happened, built from the error's detail (the asset, the shortfall and who must fund it, the revert reason, the Signer's reason, the deadline), and the next step, with a link where there is one.

The sidebar has one card per Sender, titled with its name, with its chain and signing mode. It leads with the balance of the chain's native coin, which pays the fees, and what is committed of it, then lists each token the Sender holds or has work committed in.

A field the engine could not read, such as a balance while the RPC is down, shows its error in place, and the rest of the page still loads.

## Asset names and amounts

The console reads the Known Assets with the Senders, every 15 seconds, and names every amount from them. A row shows the symbol, and hovering or tabbing to the symbol shows the asset's name. Details, Items, Senders & Keys and Assets show both. An asset the registry does not hold is shown by its symbol.

Amounts show 2 decimals for USDC and 4 for SOL and ETH. An amount too small to show at those decimals keeps its first two significant digits instead of rounding to zero: 0.000001 ETH reads `0.000001`, never `0.0000`.

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
