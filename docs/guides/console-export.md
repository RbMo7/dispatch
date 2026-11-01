# Export from the console

The web console saves Dispatches and their items as CSV or Excel files, with exact amounts. The files are built in your browser from the same API routes you call, and the engine has no export route of its own. This guide exports a month of Dispatches, then the items of one.

You need the console running and its API token. [The web console](../self-hosting/console.md) explains how to turn it on and sign in.

## 1. Filter the Dispatches you want

Open **Dispatches** at `/console/dispatches`. Choose a date range (today, 7 days, 30 days, or a custom range), and filter by chain, status or mode if you want. The filters are in the page's URL, so you can bookmark or share the view.

## 2. Export the list

Click **Export** and choose **CSV** or **Excel (.xlsx)**.

The export saves every Dispatch that matches the current filters, not only the rows on screen. It walks the list a page at a time and shows how many it has read so far. **Cancel** stops it.

The file has one row per Dispatch, with these columns: Id, Mode, Chain, Status, Created, Items, and one column per asset total, such as `USDC total`. Its name carries the date range: `dispatches-2026-10-01_2026-10-31.csv`.

## 3. Export the items of one Dispatch

Select a Dispatch to open its detail pane, then open the **Items** tab. Narrow the table with the strip of status counts or the search box if you want, then click **Export** on the tab and choose a format.

The file holds the items the table shows, with these columns: Index, Type, Recipient or target, Asset, Asset name, Amount, Status, Transaction hash, Error code and Error message. Asset name is the asset's name from the Known Assets, such as `USD Coin`. Its name carries the Dispatch: `dispatch-7f3a91c2-items.xlsx`.

## What is in the files

- **CSV** is UTF-8 with a byte order mark, a header row, CRLF line ends and standard quoting. A text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe, so a spreadsheet does not run it as a formula.
- **Excel** has one sheet, with the header row frozen and dates as real dates.

Amounts are exact in both. CSV writes the full decimal, with every one of the asset's decimals: `1250.000000` for 1,250 USDC. Excel writes a number, formatted to the display decimals, only when the number holds the exact value. Otherwise it writes the exact decimal as text, so an 18-decimal ETH amount never loses digits.

The console's **hide balances** button masks amounts on screen for screen sharing. It never applies to exports, because an export is an explicit request for the data.

## Export without the console

To build the same files in your own code, read [List Dispatches](../openapi.yaml#list-dispatches) page by page, as [Pagination](../pagination.md) shows, and [Get a Dispatch](../openapi.yaml#get-a-dispatch) for the items. Every amount there is a whole number in the smallest unit with its `decimals`.
