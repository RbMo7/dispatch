# Batch payments into one transaction on Base

By default the engine sends one Base transaction per item, in nonce order. Each item then fails alone, but 500 payments are 500 transactions and 500 base fees. Bulk Call sends many items in one transaction instead, through an aggregator contract you name. The engine encodes the items as one `aggregate3Value` call. It never deploys or owns the contract.

Bulk Call is Base only. Solana bundles several payments per transaction on its own, with no setting.

## 1. Choose an aggregator

The aggregator must implement Multicall3's `aggregate3Value` and have code on the network the engine uses.

- **For ETH payments and calls only,** the canonical Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11` works. It is deployed on Base and Base Sepolia.
- **For ERC-20 payments,** deploy your own aggregator. Inside `aggregate3Value` each call comes from the aggregator, so an ERC-20 transfer spends the aggregator's token balance, and you fund the aggregator with the tokens. The engine refuses ERC-20 items through the canonical Multicall3, because anyone can call it and take what it holds.

ETH items are paid by the Sender, which sends their total along with the call. The [Funding Check](../lifecycle.md#the-funding-check) checks each item against its real payer: ETH against the Sender, tokens against the aggregator.

## 2. Send the Dispatch with `bulkCall`

Add `bulkCall` to a Managed Dispatch on Base. This one pays two recipients 0.00001 ETH each in one transaction:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: bulk-base-2026-11-01" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "base",
    "bulkCall": { "aggregator": "0xcA11bde05977b3631167028862bE2a173976CA11", "maxBatchSize": 10 },
    "items": [
      { "type": "payment", "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72", "asset": "ETH", "amount": "10000000000000" },
      { "type": "payment", "recipient": "0xEd77f00C8a16513bc5939e27450ad4D253C876b7", "asset": "ETH", "amount": "10000000000000" }
    ]
  }'
```

```json
{ "dispatchId": "66d96716-22fe-4a3c-bc18-a08b1646fd40", "status": "queued" }
```

## 3. Read the result

Both items report the same `transactionHash`, and the timeline shows one transaction carrying items 0 and 1:

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID?include=timeline" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "66d96716-22fe-4a3c-bc18-a08b1646fd40",
  "mode": "managed",
  "chain": "base",
  "createdAt": "2026-11-01T02:12:18.037Z",
  "status": "confirmed",
  "items": [
    {
      "type": "payment",
      "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      "asset": "ETH",
      "decimals": 18,
      "amount": "10000000000000",
      "status": "confirmed",
      "transactionHash": "0x44cd9c34c20b697794cd0b6e43a6532b5bfc24ff67fc246ebc0035ea5cfcedb4",
      "error": null
    },
    {
      "type": "payment",
      "recipient": "0xEd77f00C8a16513bc5939e27450ad4D253C876b7",
      "asset": "ETH",
      "decimals": 18,
      "amount": "10000000000000",
      "status": "confirmed",
      "transactionHash": "0x44cd9c34c20b697794cd0b6e43a6532b5bfc24ff67fc246ebc0035ea5cfcedb4",
      "error": null
    }
  ],
  "timeline": [
    { "kind": "created", "at": "2026-11-01T02:12:18.037Z" },
    { "kind": "claimed", "at": "2026-11-01T02:12:23.559Z" },
    { "kind": "written", "at": "2026-11-01T02:12:23.580Z", "hash": "0x44cd9c34c20b697794cd0b6e43a6532b5bfc24ff67fc246ebc0035ea5cfcedb4", "items": [0, 1], "replaces": null },
    { "kind": "sent", "at": "2026-11-01T02:12:23.880Z", "hash": "0x44cd9c34c20b697794cd0b6e43a6532b5bfc24ff67fc246ebc0035ea5cfcedb4", "items": [0, 1] },
    { "kind": "confirmed", "at": "2026-11-01T02:12:28.051Z", "hash": "0x44cd9c34c20b697794cd0b6e43a6532b5bfc24ff67fc246ebc0035ea5cfcedb4", "items": [0, 1] }
  ]
}
```

## Choose the batch size

`maxBatchSize` is the most items per transaction. It defaults to, and cannot exceed, the operator's `BASE_BULK_CALL_MAX_BATCH_SIZE`, 50 by default. A Dispatch with more items is split into several transactions, never truncated: 120 items at 50 per batch are three transactions of 50, 50 and 20.

## Decide what one bad item does

`allowFailure` decides what one bad item does to the others in its transaction.

- **`false`, the default.** The items succeed or fail together. If any one would fail, the whole transaction reverts and every item in it is reported `failed`. Fix the bad item and send the batch again with a new `Idempotency-Key`. Nothing is ever half done.
- **`true`.** Each item succeeds or fails on its own: one failing item is `failed` while the others confirm. The engine can see per-item outcomes only in a transaction trace, so the operator must set `BASE_TRACE_RPC_URL` to an RPC that serves `debug_traceTransaction`. Without it the request is refused.

The response has the same shape either way. The `allowFailure: true` path is proven in the engine's tests but not yet against a live tracing RPC.

## Fit the Signer's policy

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

[Create a Dispatch](../openapi.yaml#create-a-dispatch) lists every `bulkCall` field.
