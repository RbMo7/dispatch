# Bundle Base payments with Bulk Call

By default the engine sends one Base transaction per item, in nonce order. That is simple and each item fails alone, but 500 payments are 500 transactions and 500 base fees. Bulk Call sends many items in one transaction instead, through an aggregator contract you name. The engine encodes the items as one `aggregate3Value` call and never deploys or owns the contract ([ADR-0038](../adr/0038-bulk-call-uses-a-caller-named-aggregator-and-traced-per-item-outcomes.md)).

Bulk Call is Base only. Solana bundles several payments per transaction on its own, with no setting.

## Choose an aggregator

The aggregator must implement Multicall3's `aggregate3Value` and have code on the network the engine uses.

- **For ETH payments and calls only,** the canonical Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11` works. It is deployed on Base and Base Sepolia.
- **For ERC-20 payments,** deploy your own aggregator. Inside `aggregate3Value` each call comes from the aggregator, so an ERC-20 transfer spends the **aggregator's** token balance, and you fund the aggregator with the tokens. The engine refuses ERC-20 items through the canonical Multicall3, because anyone can call it and take what it holds.

ETH items are paid by the Sender, which sends their total along with the call. The [Funding Check](../concepts/funding-check.md) checks each item against its real payer: ETH against the Sender, tokens against the aggregator.

## Send a Bulk Call

Add `bulkCall` to a Managed Dispatch on Base. This real Dispatch paid two recipients 0.00001 ETH each in one transaction:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: bulk-base-001" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "base",
    "bulkCall": { "aggregator": "0xcA11bde05977b3631167028862bE2a173976CA11", "maxBatchSize": 10 },
    "items": [
      { "type": "payment", "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72", "asset": "ETH", "amount": "10000000000000" },
      { "type": "payment", "recipient": "0x1Dd9661FAb2d82731E033c21C46BA009633bf558", "asset": "ETH", "amount": "10000000000000" }
    ]
  }'
```

```json
{ "dispatchId": "cfd17761-3547-4262-9722-ee14067ccc45", "status": "queued" }
```

Both items report the same `transactionHash`, and the timeline shows one transaction carrying items 0 and 1:

```json
"timeline": [
  { "kind": "created", "at": "2026-10-31T18:48:28.308Z" },
  { "kind": "claimed", "at": "2026-10-31T18:48:33.609Z" },
  { "kind": "written", "at": "2026-10-31T18:48:33.630Z", "hash": "0x08c391a0…9d44", "items": [0, 1], "replaces": null },
  { "kind": "sent", "at": "2026-10-31T18:48:33.945Z", "hash": "0x08c391a0…9d44", "items": [0, 1] },
  { "kind": "confirmed", "at": "2026-10-31T18:48:40.644Z", "hash": "0x08c391a0…9d44", "items": [0, 1] }
]
```

## Batch size

`maxBatchSize` is the most items per transaction. It defaults to, and cannot exceed, the operator's `BASE_BULK_CALL_MAX_BATCH_SIZE` (50 by default). A Dispatch with more items is split into several transactions, never truncated. 120 items at 50 per batch are three transactions: 50, 50 and 20.

## When one item fails

`allowFailure` decides what one bad item does to its batch-mates in the same transaction.

- **`false`, the default.** The items succeed or fail together. If any one would fail, the whole transaction reverts and every item in it is reported `failed`. Fix the bad item and send the batch again with a new `Idempotency-Key`. Nothing is ever half done.
- **`true`.** Each item succeeds or fails on its own: one failing item is `failed` while the others confirm. The engine can only see per-item outcomes in a transaction trace, so the operator must set `BASE_TRACE_RPC_URL` to an RPC that serves `debug_traceTransaction`. Without it the request is refused.

The response has the same shape either way. The `allowFailure: true` path is proven in the engine's tests but not yet against a live tracing RPC.

## The Signer's policy and Bulk Call

If the Sender's key has a policy:

- List the aggregator **and** every item's target in `allowedDestinations`. The Signer reads each call inside `aggregate3Value`.
- ERC-20 items count against the Sender's token cap, though they spend the aggregator's balance, because the Signer sums every `transfer` in the transaction.
- Caps are per transaction, so a cap limits a whole batch. A batch whose total is over the cap is refused even if each item is under it. Size `maxBatchSize` to fit.

## What is refused

A Bulk Call request is a `400`, and nothing is stored, for:

| Cause | Message |
| --- | --- |
| `bulkCall` on Solana | `chain solana has no Bulk Call mode` |
| `bulkCall` on a Relay Dispatch | `a relay dispatch accepts only chain and signedTransaction …` |
| An aggregator with no code | `aggregator 0x8ba1…BA72 has no contract code on this network` (`INVALID_RECIPIENT`) |
| `maxBatchSize` above the limit | `maxBatchSize must be 1..50` (`CHAIN_REJECTED`) |
| `allowFailure: true` without `BASE_TRACE_RPC_URL` | `allowFailure: true needs a tracing RPC (BASE_TRACE_RPC_URL) to read per-item outcomes …` (`CHAIN_REJECTED`) |
| An ERC-20 item through the canonical Multicall3 | `ERC-20 items cannot go through the canonical Multicall3 …` (`CHAIN_REJECTED`) |
| A Multisig Sender | A Safe bundles its payments in a MultiSend instead (`CHAIN_REJECTED`) |

[`POST /v1/dispatch`](../api/create-dispatch.md#bulk-call) has the field reference.
