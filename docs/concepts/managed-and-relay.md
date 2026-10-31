# Managed and Relay Dispatch

Every Dispatch is one of two kinds, and the difference is who signs.

## Managed Dispatch: the engine builds and signs

In a Managed Dispatch you describe what to send, as a list of payments and contract calls, and the engine does the rest. It builds each transaction, assigns its nonce, asks your Signer to sign it with the Sender's key, sends it, and tracks it. This is the default. A request without `mode` is Managed.

Use it when you control the wallet that pays: payroll, payouts, refunds, a backend that settles trades from its own hot wallet, a contract call your service makes on a schedule.

Because the engine holds the signing path, it can do things only a signer can do:

- It packs several items into one transaction where the chain allows: several payments per transaction on Solana, or a [Bulk Call](../guides/bulk-call.md) through an aggregator on Base.
- It replaces a stuck Base transaction with a higher-fee copy at the same nonce, if you allow it with [Retry Policy](./retry-policy.md).
- It rebuilds a Solana transaction whose blockhash expired and sends it again, up to 3 times.
- It checks the Sender can pay before signing anything, with the [Funding Check](./funding-check.md).

A Managed Dispatch reports one status per item, because one request can carry many payments that land, fail or wait independently.

## Relay Dispatch: someone else signed

In a Relay Dispatch you hand the engine a transaction that is already signed, by any wallet, usually your own user's. The engine never builds it and never assigns its nonce. It validates the bytes, broadcasts them, resends the same bytes if they stall, and tracks the transaction to an outcome.

Use it when your users bring their own wallets: a DEX, a wallet app, a game where the player signs. You get reliable delivery and a status to poll without ever holding a user's key.

```json
{ "chain": "base", "mode": "relay", "signedTransaction": "0x02f87383014a34820c12…f749" }
```

What the engine cannot do for a Relay Dispatch follows from not having the key:

- It cannot raise the fee of a stuck transaction. Only the original signer can make a valid replacement, so `retryPolicy` is refused.
- It cannot refresh an expired Solana blockhash. An expired Relay transaction is `failed`, and the user has to sign again.
- It does not check the payer's balance first. The chain decides.

A Relay Dispatch is one transaction, so it reports one status at the top level instead of a list of items ([ADR-0031](../adr/0031-relay-dispatch-shares-the-endpoint-gets-its-own-domain-type.md)).

## Side by side

| | Managed | Relay |
| --- | --- | --- |
| Who signs | Your Signer, with the Sender's key | Whoever made the transaction |
| You send | `items`: payments and calls | `signedTransaction`: base64, or `0x` hex on Base |
| Nonce | The engine assigns it | Already in the signed bytes |
| Batching | Yes | One transaction |
| Fee bump on Base | With `retryPolicy: true` | Never |
| Expired Solana blockhash | Rebuilt and resent, up to 3 times | `failed` |
| Funding Check | Yes | No |
| Status shape | Top level plus one per item | Top level only |

Both kinds share the endpoint, the headers, the `Idempotency-Key` rules, the list route and the cancel route. [Relay Dispatch](../guides/relay-dispatch.md) is the how-to guide, and [`POST /v1/dispatch`](../api/create-dispatch.md) has the exact fields.
