# Create a Dispatch

## `POST /v1/dispatch`

Stores a Managed or a Relay Dispatch and answers `202 Accepted` with its id. The answer never carries a chain result. Poll [`GET /v1/dispatch/:id`](./get-dispatch.md) for that.

### Headers

| Header | Required | Value |
| --- | --- | --- |
| `Authorization` | Yes | `Bearer <AUTH_TOKEN>` ([ADR-0022](../adr/0022-single-api-key-auth.md)) |
| `Idempotency-Key` | Yes | A string you choose, unique across the engine ([ADR-0021](../adr/0021-idempotency-key-required.md)) |
| `Content-Type` | Yes | `application/json` |

### Body of a Managed Dispatch

| Field | Type | Required | Means |
| --- | --- | --- | --- |
| `chain` | `"base"` or `"solana"` | Yes | The chain. It must be in `ENABLED_CHAINS`. |
| `mode` | `"managed"` or `"relay"` | No | Defaults to `"managed"`. |
| `items` | array | Yes | One or more `payment` and `call` items, in any mix. Not empty. |
| `retryPolicy` | boolean | No | Whether the engine may fee-bump a stuck Base transaction ([Retry Policy](../concepts/retry-policy.md)). Omitted, it falls back to the operator's `DEFAULT_RETRY_POLICY`, which is off unless the operator opts in. Once resolved, it is fixed for the Dispatch's whole life. |
| `bulkCall` | object | No | Base only. Send the items through an aggregator contract you name ([Bulk Call](#bulk-call)). |

No other field is accepted. A Dispatch never silently costs more than what its request allowed ([ADR-0003](../adr/0003-cost-increasing-behavior-defaults-off.md), [ADR-0004](../adr/0004-abandoned-is-distinct-from-failed.md)).

A **`payment`** item is a transfer ([Calls and Payments](../concepts/calls-and-payments.md)):

| Field | Means |
| --- | --- |
| `type` | `"payment"` |
| `recipient` | The address that receives it |
| `asset` | `ETH` or `SOL`, or a token symbol configured in `BASE_KNOWN_TOKENS` or `SOLANA_KNOWN_TOKENS` |
| `amount` | A non-negative whole number in the asset's smallest unit, as a string: wei, lamports, or the token's base unit |

A **`call`** item's fields beyond `type` mirror the chain's Call exactly ([ADR-0018](../adr/0018-call-not-payment-is-the-primitive.md)):

| Chain | Fields |
| --- | --- |
| `base` | `to` (address), `data` (`0x` hex calldata), `value` (wei, as a string) |
| `solana` | `programId`, `accounts` (each `{ pubkey, isSigner, isWritable }`), `data` (base64) |

A `call` item gets the chain's cheap shape check at submission, so a malformed one is a `400` and never queued.

### Example: pay two people on Base

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: payroll-2026-10-31" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "base",
    "items": [
      { "type": "payment", "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72", "asset": "ETH", "amount": "50000000000000" },
      { "type": "payment", "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72", "asset": "USDC", "amount": "40000000" }
    ]
  }'
```

```json
{ "dispatchId": "651d094d-00de-4dc6-a7c4-0ec2dc98b610", "status": "queued" }
```

### Example: a call and a payment on Solana

The call writes the memo `invoice 4471` (base64 `aW52b2ljZSA0NDcx`) with the Memo program, and the payment sends 0.0025 SOL:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: memo-sol-001" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "solana",
    "items": [
      { "type": "call", "programId": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "accounts": [], "data": "aW52b2ljZSA0NDcx" },
      { "type": "payment", "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2", "asset": "SOL", "amount": "2500000" }
    ]
  }'
```

```json
{ "dispatchId": "a195cfee-c12f-4eca-baa8-b2a7099c6cc9", "status": "queued" }
```

### Example: a call on Base

A call with empty calldata and a `value` is a plain ETH transfer written as a Call:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: call-base-001" \
  -H "Content-Type: application/json" \
  -d '{"chain":"base","items":[{"type":"call","to":"0x8ba1f109551bD432803012645Ac136ddd64DBA72","data":"0x","value":"20000000000000"}]}'
```

```json
{ "dispatchId": "f9bac880-a693-4691-8c61-6d95fb0b3a94", "status": "queued" }
```

### Response

`202 Accepted`:

```json
{ "dispatchId": "651d094d-00de-4dc6-a7c4-0ec2dc98b610", "status": "queued" }
```

Sending the same `Idempotency-Key` again returns the original Dispatch's current state, in the same shape, with `202`, and creates no second Dispatch. A cancelled Dispatch comes back as `"status": "cancelled"`. Send a new key to try again.

## Relay Dispatch

A body with `"mode": "relay"` carries a transaction someone else already signed ([ADR-0031](../adr/0031-relay-dispatch-shares-the-endpoint-gets-its-own-domain-type.md)). The design is in `.scratch/relay-dispatch/spec.md`. The [Relay Dispatch guide](../guides/relay-dispatch.md) shows how to produce one.

| Field | Means |
| --- | --- |
| `chain` | `"base"` or `"solana"` |
| `mode` | `"relay"` |
| `signedTransaction` | The signed transaction, base64. On Base the usual `0x` hex raw transaction is accepted too. |

A Relay body is `{ chain, mode, signedTransaction }` and nothing else: never `items`, never `retryPolicy` (there is no key for the engine to fee-bump with), never `bulkCall`. Sending any of them is a `400`, not a silently ignored field. The same headers and the same create-once `Idempotency-Key` rules apply.

The engine checks the bytes before it stores anything ([ADR-0032](../adr/0032-chain-handler-gains-validate-signed-transaction.md)):

- **Solana.** A legacy or a versioned (v0) transaction, and every required signature must verify.
- **Base.** An EIP-1559 (type `0x02`) transaction for the configured chain ID, with a low-s (EIP-2) signature.

```sh title="Base"
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: relay-base-001" \
  -H "Content-Type: application/json" \
  -d '{"chain":"base","mode":"relay","signedTransaction":"0x02f87383014a34820c12830f424083d59f80825208948ba1f109551bd432803012645ac136ddd64dba72861b48eb57e00080c001a0f9212123938144a7fb008b52a69c73bc21565bb9ab03334a651925b513feb171a0107f25b631d52cbd7ef07e749feb4bf0836b4a1a3291df5dbef90ec28202f749"}'
```

```sh title="Solana"
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: relay-sol-001" \
  -H "Content-Type: application/json" \
  -d '{"chain":"solana","mode":"relay","signedTransaction":"ATX6XkQAxkd6r6DMRqoGwo+HmhLO7Ld98uzN3hAtRHZdZ9yBeTQovF9PIocDcZbWcONyvQvq6GglL9qj2u3Nvw4BAAEDHntsSEO3GyebSN8MUQyX06Ws4Taqnwsfzlq2Fqrbze69xvb1VVXvEsuYM2vL94stXfe/jNYCJlYL29F5kB85UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2eXSnnsI6wquc3ccbzgNkzpoqZN6pYNPcunvhYF4ps8BAgIAAQwCAAAAQEtMAAAAAAA="}'
```

The response has the same shape as a Managed one, `202 Accepted`:

```json
{ "dispatchId": "4ecfe1aa-852d-4ef9-91f2-c78fb1690b75", "status": "queued" }
```

A Solana transaction carries a recent blockhash and expires about a minute after it is signed, so submit it promptly. Both examples above confirmed, so to try this yourself, sign a fresh transaction.

## Bulk Call

A Managed Dispatch on Base can opt into Bulk Call ([ADR-0006](../adr/0006-batching-defaults-and-bulk-call.md), [ADR-0038](../adr/0038-bulk-call-uses-a-caller-named-aggregator-and-traced-per-item-outcomes.md)). Its items are then sent as `aggregate3Value` transactions through an aggregator contract **you** name. The engine never deploys or owns one. The [Bulk Call guide](../guides/bulk-call.md) explains when to use it.

```json
{
  "chain": "base",
  "bulkCall": { "aggregator": "0xcA11bde05977b3631167028862bE2a173976CA11", "maxBatchSize": 50, "allowFailure": false },
  "items": [ … ]
}
```

| Field | Required | Means |
| --- | --- | --- |
| `aggregator` | Yes | The aggregator contract's address. It must have code on the network. |
| `maxBatchSize` | No | The most items per transaction. It defaults to, and cannot exceed, the operator's `BASE_BULK_CALL_MAX_BATCH_SIZE` (50 by default). A request with more items is split into several transactions, never truncated. |
| `allowFailure` | No | Defaults to `false`. |

- **`allowFailure: false`.** The items in one transaction succeed or fail together. If any one would fail, the whole transaction reverts and every item in it is reported `failed`, so you resubmit the corrected batch. Nothing is ever silently half done.
- **`allowFailure: true`.** Each item succeeds or fails on its own. One failing item is reported `failed` while its batch-mates confirm. The operator must configure a tracing RPC (`BASE_TRACE_RPC_URL`), because per-item outcomes are only visible in a transaction trace.
- The response shape is the same either way.
- **ERC-20 items spend the aggregator's own token balance.** Inside `aggregate3Value` the calls come from the aggregator, so fund your aggregator with the tokens. Native ETH items are paid by the Sender, which sends the total along with the call. The Funding Check checks each against its real payer.

Bulk Call returns `400` for:

- `mode: "relay"`,
- a chain without Bulk Call (Solana bundles on its own),
- a malformed aggregator, or one with no contract code,
- an out-of-range `maxBatchSize`,
- `allowFailure: true` with no tracing RPC configured (`BASE_TRACE_RPC_URL`),
- **any ERC-20 item with the canonical Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) as aggregator.** It is permissionless, so anyone can take any balance or approval it holds,
- any Multisig Sender. A Safe bundles its payments in a MultiSend instead.

## Multisig Sender restrictions

When the chain's Sender is a [Multisig Sender](../concepts/multisig-and-treasury.md), the engine only proposes native transfers and token transfers: SOL, SPL and Token-2022 on Solana, and ETH and ERC-20 tokens in `BASE_KNOWN_TOKENS` on Base. `POST /v1/dispatch` checks every item before storing anything. A `call` item the multisig cannot hold, or a `bulkCall`, is a `400` with `CHAIN_REJECTED` whose message names the item (`items[1]: …`). No Dispatch is stored, and the `Idempotency-Key` is not used up. The engine runs the same check again when it plans the Proposals, as a safety net.

## Errors

Every one of these was returned by a running engine. Nothing is stored for any of them.

| Status | Body | Cause |
| --- | --- | --- |
| `400` | `{ "error": "Idempotency-Key header is required" }` | No `Idempotency-Key` header |
| `400` | `{ "error": "items must be a non-empty array" }` | `items` missing or empty on a Managed Dispatch |
| `400` | `{ "error": "items[0]: amount must be a non-negative integer string" }` | `"amount": "12.5"`: amounts are whole numbers in the smallest unit |
| `400` | `{ "error": "items[0]: a payment item requires string recipient, asset, and amount" }` | A payment field missing or not a string |
| `400` | `{ "error": "items[0]: unknown item type \"transfer\" …" }` | `type` is neither `payment` nor `call` |
| `400` | `{ "code": "UNKNOWN_ASSET", "message": "no known token configured for asset \"DAI\"", "chainDetail": { "asset": "DAI" } }` | The token is not in the known-token list |
| `400` | `{ "code": "INVALID_RECIPIENT", "message": "not a well-formed EVM address: 0x8ba1f109551bD43280301264" }` | A bad Base address |
| `400` | `{ "code": "INVALID_RECIPIENT", "message": "not a well-formed Solana address: not-an-address", "chainDetail": "Non-base58 character" }` | A bad Solana address |
| `400` | `{ "code": "CHAIN_REJECTED", "message": "call data is not a well-formed (whole-byte) hex string: hello" }` | Malformed calldata in a Base `call` |
| `400` | `{ "code": "CHAIN_NOT_ENABLED", "message": "chain not enabled: solana" }` | `chain` is valid but not in `ENABLED_CHAINS` |
| `400` | `{ "statusCode": 400, "code": "FST_ERR_VALIDATION", "error": "Bad Request", "message": "body/chain must be equal to one of the allowed values" }` | `chain` is not `base` or `solana` |
| `400` | `{ "error": "a relay dispatch accepts only chain and signedTransaction …" }` | A Relay body with an extra field |
| `400` | `{ "error": "a relay dispatch requires a string signedTransaction" }` | A Relay body without `signedTransaction` |
| `400` | `{ "code": "CHAIN_REJECTED", "message": "not a decodable signed transaction", "chainDetail": { "error": "…" } }` | Relay bytes that are not a Base transaction |
| `400` | `{ "code": "CHAIN_REJECTED", "message": "not a decodable Solana transaction", "chainDetail": "Reached end of buffer unexpectedly" }` | Relay bytes that are not a Solana transaction |
| `400` | `{ "error": "chain solana has no Bulk Call mode" }` | `bulkCall` on Solana |
| `400` | `{ "code": "CHAIN_REJECTED", "message": "maxBatchSize must be 1..50", "chainDetail": { "maxBatchSize": 500 } }` | `maxBatchSize` over the operator's limit |
| `400` | `{ "code": "INVALID_RECIPIENT", "message": "aggregator 0x8ba1…BA72 has no contract code on this network", "chainDetail": { "aggregator": "0x8ba1…BA72" } }` | An aggregator with no code |
| `400` | `{ "code": "CHAIN_REJECTED", "message": "allowFailure: true needs a tracing RPC (BASE_TRACE_RPC_URL) to read per-item outcomes …" }` | `allowFailure: true` without `BASE_TRACE_RPC_URL` |
| `400` | `{ "code": "CHAIN_REJECTED", "message": "ERC-20 items cannot go through the canonical Multicall3: it is permissionless, so any token balance or approval it holds can be taken by anyone …", "chainDetail": { "aggregator": "0xcA11bde05977b3631167028862bE2a173976CA11" } }` | An ERC-20 item through Multicall3 |
| `401` | `{ "error": "unauthorized" }` | Missing or wrong `AUTH_TOKEN` |

Here is the unknown-asset case as a full request:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: probe-unknown-asset" \
  -H "Content-Type: application/json" \
  -d '{"chain":"base","items":[{"type":"payment","recipient":"0x8ba1f109551bD432803012645Ac136ddd64DBA72","asset":"DAI","amount":"1000000000000000000"}]}'
```

```json
{ "code": "UNKNOWN_ASSET", "message": "no known token configured for asset \"DAI\"", "chainDetail": { "asset": "DAI" } }
```
