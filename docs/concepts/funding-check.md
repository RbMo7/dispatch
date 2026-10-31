# Funding Check

Before the engine signs anything for a Managed Dispatch, it checks that the payer can afford it. A shortfall fails the affected items at once, with an error that says exactly how much more is needed, instead of letting payment 312 of 500 fail on the chain ([ADR-0024](../adr/0024-funding-check-is-in-scope.md)).

## When it runs

The worker runs the check when it claims a batch of queued Dispatches, before it builds any transaction. It does not run when you call `POST /v1/dispatch`, so a `202` says nothing about the balance. Top up the Sender before you submit, or expect `INSUFFICIENT_FUNDS` on the items.

## What it counts

For each asset, the check adds up everything the claimed Dispatches need from each payer and compares that with the payer's balance on the chain:

- **Payments.** Every `payment` item's amount, per asset.
- **Fees, on Solana.** The SOL for each transaction's fee, any priority fee, and the rent for every recipient token account the engine has to create ([ADR-0043](../adr/0043-the-funding-check-counts-what-sending-costs.md)).
- **The real payer.** Each amount is checked against whoever actually pays it. The Sender pays almost everything. A [Bulk Call](../guides/bulk-call.md)'s ERC-20 items are paid from the aggregator contract's own balance, so they are checked against the aggregator.
- **Money already promised, for a Multisig Sender.** Open Proposals, Calls waiting to be proposed, and timed-out Proposals the engine still watches all hold back part of the balance. The check subtracts that `committed` amount first, so a second Dispatch cannot spend what the first is waiting to pay.

A `call` item is not counted, not even the `value` a Base Call sends. The engine does not read what your encoded Call spends, so make sure the Sender holds enough for your Calls yourself.

If the engine cannot read a balance at all, for example because the RPC is down, it fails the affected items rather than send them unchecked.

## What a shortfall looks like

The items that cannot be paid become `failed` with `INSUFFICIENT_FUNDS`, and nothing is signed for them. Items the balance can cover still go ahead. This real Dispatch paid 0.00005 ETH and 40 USDC from a Sender with no USDC:

```json
{
  "type": "payment",
  "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
  "asset": "USDC",
  "decimals": 6,
  "amount": "40000000",
  "status": "failed",
  "transactionHash": null,
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "insufficient USDC balance",
    "chainDetail": { "asset": "USDC", "short": "40000000" }
  }
}
```

`short` is how much more the payer needs, in the asset's smallest unit: here 40 USDC. The ETH item confirmed, so the Dispatch read `partial`.

For a Multisig Sender the detail also names which balance is short and how much is already held back:

```json
{ "asset": "USDC", "short": "40", "holder": "vault", "address": "<the vault's address>", "committed": "100" }
```

`holder` is `vault` or `memberKey` on Solana, and `safe` or `executor` on Base. The vault or Safe pays the payments. The engine's own key, the Squads member key or the Safe executor, pays the network fees and any Proposal rent. `committed` is the amount of that asset already held back on that balance, in the smallest unit. `short` includes it. A plain Sender's shortfall is only `{ "asset", "short" }`.

## What to do about it

Top up the payer named in the error by at least `short`, then send the failed payments again in a new Dispatch with a new `Idempotency-Key`. Sending the old key returns the old, failed Dispatch.

With a [Treasury](./multisig-and-treasury.md#treasury-a-multisig-that-tops-up-a-hot-sender), the shortfall is the top-up the Approvers send from the multisig.

The check is a snapshot taken at claim time. If something else spends from the Sender between the check and the send, the chain can still refuse a transaction, and the item fails with `INSUFFICIENT_FUNDS` from the chain instead.
