# The web console

The engine's API process serves a console at `/console` when `web/` has been built (the Docker image builds it). It shows what this one engine is doing, read live from the same `/v1` routes any client can call. It is read-only, with one write: cancelling a Dispatch the engine has not claimed yet.

## Sign in

The console asks for the API token, the same `AUTH_TOKEN` the engine was started with and every `POST /v1/dispatch` carries as `Authorization: Bearer <token>`. It is checked against the engine before it is kept, and it is kept in the browser tab's session storage only: closing the tab signs you out. If the engine refuses the token later (it was rotated), the console returns to sign-in and says so.

There is no separate console password. Anyone holding `AUTH_TOKEN` can submit Dispatches through the API, so treat the console like the API: serve it over TLS and only to people who may hold the token.

## Pages

- **Overview**: Dispatches in flight, Dispatches created over the last hour, day or week against the period before, each Sender's balance with what is committed, and what needs you: the oldest unclaimed Dispatch, Proposals awaiting approval, abandoned items, which may still land, and any failing setup check.
- **Dispatches**: every Dispatch, newest first, by day. Filter by date range, chain, status and mode; type an id or the start of one and press Enter to open it. Selecting a row opens its Flow (what happened, stage by stage, down to fee bumps and Solana resubmissions), its Items and its Details. The URL holds the selection, tab and filters, so a link opens the same view.
- **Senders & Keys**: each enabled chain's Sender, its balances and what is committed, the multisig and its threshold, and what the Signer reports about the engine's key, including whether it is pinned to the multisig (ADR-0055).
- **Setup**: the same checks as `pnpm dispatch doctor`, from `GET /v1/setup`. A summary says "All good" or how many things need you, then one card per area lists each check with its status, what it found, how to fix it, and when it last ran. The worker runs its checks at start and every five minutes; the database and console checks run when the page loads. A failing check also shows in the Overview's Needs attention. The page is read-only: configuration lives in files on the server.

A field the engine could not read, such as a balance while the RPC is down, shows its error in place; the rest of the page still loads.

## Cancel

**Cancel Dispatch** appears while the engine has not claimed a Dispatch. Cancelling marks it and every item `cancelled`; nothing is signed or sent (ADR-0056). If the worker claims it first, the cancel is refused with `ALREADY_CLAIMED` and the console says it is too late. An open multisig Proposal cannot be cancelled here: reject it in Squads or Safe.

## Live updates and exports

The console polls about every 2 seconds while anything it shows is in flight, backs off to 30 seconds once everything is settled, and stops while the tab is hidden. Senders refresh every 15 seconds, which is how long the engine caches them. The sidebar says **Live**, or **Reconnecting** when the engine stops answering.

**Export** on the Dispatches page writes every Dispatch matching the current filters, and the Items tab writes the items it shows, as CSV or Excel. Both are built in the browser from the same routes. The eye button hides every amount on screen for screen sharing; exports always hold the real amounts.
