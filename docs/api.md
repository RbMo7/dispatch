# API

The shipped wire format for `POST /v1/dispatch` and `GET /v1/dispatch/:id`, implemented for both `solana` and `base`. Changes to it are deliberate and recorded in an ADR.

## `POST /v1/dispatch`

Headers:
```
Authorization: Bearer <operator-configured token>   (ADR-0022)
Idempotency-Key: <client-supplied string>            (ADR-0021, required)
```

Body:
```json
{
  "chain": "solana",
  "retryPolicy": false,
  "items": [
    { "type": "payment", "recipient": "<address>", "asset": "USDC", "amount": "10" },
    {
      "type": "call",
      "programId": "<program id>",
      "accounts": [{ "pubkey": "<address>", "isSigner": false, "isWritable": true }],
      "data": "<base64>"
    }
  ]
}
```

A `call` item's fields beyond `type` mirror the target chain's `Call` primitive exactly (CONTEXT.md, ADR-0018) — `{ programId, accounts, data }` for a `solana` Dispatch as shown above, `{ to, data, value }` for a `base` one. `items` mixes `payment` (ADR-0018's convenience shape) and `call` (the primitive) freely in one Dispatch. A `call` item gets the chain's cheap shape check at submission, so a malformed one is a `400`, never queued. Resubmitting the same `Idempotency-Key` returns the original Dispatch's current state (202, same body shape as below) rather than creating a second one.

`retryPolicy` (ADR-0003/0004) is optional; omitting it falls back to the operator's configured global default (itself off unless the operator opts in) — a Dispatch never silently costs more than what was explicitly authorized for it. Once resolved (request value or the global default) it's fixed for that Dispatch's whole lifetime.

Response (`202 Accepted` — this is always async, never a synchronous chain result):
```json
{ "dispatchId": "<id>", "status": "queued" }
```

## `GET /v1/dispatch/:id`

```json
{
  "dispatchId": "<id>",
  "mode": "managed",
  "status": "queued | broadcasting | confirmed | failed | partial",
  "items": [
    { "status": "confirmed", "transactionHash": "<hash>", "error": null },
    { "status": "failed", "transactionHash": null, "error": { "code": "INSUFFICIENT_FUNDS", "message": "...", "chainDetail": { "asset": "USDC", "short": "40" } } }
  ]
}
```

`error` follows ADR-0010's structured shape exactly — never a bare string. A `failed` item's `transactionHash` is `null` when it failed before anything was signed (as above), and set when the transaction was signed and then refused: every transaction is written down, hash included, before it is sent (ADR-0041).

Per-item `status` is `queued | broadcasting | confirmed | failed | abandoned` — its own vocabulary, not the top-level one (it adds `abandoned`, ADR-0004's distinct terminal state, and never itself reports `partial`, which only describes the aggregate across items). `queued` means the Call hasn't reached a Transaction yet (`transactionHash` still `null`); the top-level `status` is derived from the aggregate of item statuses, never stored as its own terminal value — only `queued`/`broadcasting` are ever persisted directly (ADR-0009's outbox transition), so `confirmed`/`failed`/`partial` are computed at read time. An `abandoned` item counts as "not confirmed" for that aggregate, the same as `failed`.

On Solana, an item whose transaction expired without landing is resubmitted with a fresh blockhash, up to 3 times, whatever `retryPolicy` says: the expired one was never charged, so this costs nothing extra (ADR-0042). Its `transactionHash` then changes to the resubmission's. After the third it is `failed`, as is an expired Relay Dispatch, which the engine has no key to re-sign.

With `retryPolicy: true`, a stuck EVM item may be fee-bumped: replaced by a new transaction at the same nonce with higher fees (ADR-0037). While that's in progress, `transactionHash` is the latest version and can change between polls. Once one version lands, `transactionHash` is the one that actually landed, which may be the original.

An item stays `broadcasting` while its transaction is unresolved. That includes a send whose outcome is unknown, such as a timeout: the transaction may have reached the chain, so it is checked (and, on Base, rebroadcast) rather than reported `failed`. It becomes `abandoned` only after the chain's timeout (15 minutes on Base) with no answer (ADR-0041, ADR-0004).

Every `GET /v1/dispatch/:id` response, Managed or Relay alike, includes a top-level `mode: "managed" | "relay"` field (ADR-0031) — added here too, not just below, so a caller can tell which shape it's looking at from the body alone without having to remember which mode it submitted.

## Bulk Call (`bulkCall`, Base)

A Managed Dispatch on Base can opt into Bulk Call (ADR-0006, ADR-0038). Its items are then sent as `aggregate3Value` transactions through an aggregator contract **you** name. The engine never deploys or owns one.

```json
{
  "chain": "base",
  "bulkCall": { "aggregator": "0x…", "maxBatchSize": 50, "allowFailure": false },
  "items": [ … ]
}
```

- **`maxBatchSize`** is optional. It defaults to, and can't exceed, the operator's `BASE_BULK_CALL_MAX_BATCH_SIZE`. A request with more items is split into several transactions, never truncated.
- **`allowFailure`** is optional and defaults to `false`:
  - **`false`:** the items in a transaction succeed or fail **together**. If any one would fail, the whole transaction reverts and every item in it is reported `failed`, so resubmit the corrected batch. Nothing is ever silently half-done.
  - **`true`:** each item succeeds or fails **on its own**. One failing item is reported `failed` while its batch-mates confirm. The operator must configure a tracing RPC (`BASE_TRACE_RPC_URL`), because per-item outcomes are only visible in a transaction trace.
  - The response shape is the same either way.
- **ERC-20 items spend the aggregator's own token balance.** Inside `aggregate3Value`, the calls come *from the aggregator*, so fund your aggregator with the tokens. Native ETH items are paid by the Sender, which sends the total along with the call. The Funding Check checks each against its real payer.
- **Returns `400`:**
  - `mode: "relay"`;
  - a chain without Bulk Call;
  - a malformed aggregator, or one with no contract code;
  - an out-of-range `maxBatchSize`;
  - `allowFailure: true` with no tracing RPC configured (`BASE_TRACE_RPC_URL`);
  - **any ERC-20 item with the canonical Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) as aggregator.** It's permissionless, so any balance or approval it holds can be taken by anyone.

## Relay Dispatch (`mode: "relay"`)

`.scratch/relay-dispatch/spec.md` and ADR-0031 record the design; this pins the shipped wire shape.

`POST /v1/dispatch` gains an optional `mode: "managed" | "relay"` field, defaulting to `"managed"` when omitted — every existing Managed Dispatch request keeps working unchanged. A `mode: "relay"` body is `{ chain, signedTransaction }` — never `items`, never `retryPolicy` (there's no key for the engine to fee-bump with); sending either alongside `mode: "relay"` is a `400`, not a silently-ignored field. `signedTransaction` is a base64-encoded, already-signed transaction the caller produced entirely outside the engine — the same headers (`Authorization`, `Idempotency-Key`) apply, and the same create-once idempotency semantics (ADR-0021). On Solana it may be a legacy or a versioned (v0) transaction, and every required signature must verify. On Base it must be an EIP-1559 (type `0x02`) transaction for the configured chain ID, with a low-s (EIP-2) signature; the usual `0x`-hex raw transaction is accepted there too.

Response (`202 Accepted`, same shape as Managed's): `{ "dispatchId": "<id>", "status": "queued" }`.

`GET /v1/dispatch/:id` for a Relay Dispatch:
```json
{
  "dispatchId": "<id>",
  "mode": "relay",
  "status": "queued | broadcasting | confirmed | failed | abandoned",
  "transactionHash": "<hash>",
  "error": null
}
```
One transaction, not a batch — this is the same per-item status vocabulary Managed Dispatch's `items[]` entries use, applied directly at the top level rather than to a fake single-item array (ADR-0031).

## Error codes

Every `error` is `{ code, message, chainDetail? }` (ADR-0010). `message` is the most specific human-readable reason available (on Base, the node's own words). `chainDetail` carries the raw chain-side detail (JSON-RPC code, HTTP status, revert data, the shortfall) for debugging, and its shape varies by code and chain.

| `code` | Meaning |
|---|---|
| `INSUFFICIENT_FUNDS` | The payer's balance can't cover it: caught up front by the Funding Check (on Solana, including the SOL for fees and new token-account rent, ADR-0043), or refused by the chain |
| `INVALID_RECIPIENT` | A malformed or unusable address (a recipient, a Bulk Call aggregator with no contract code) |
| `UNKNOWN_ASSET` | A `payment`'s `asset` has no configured encoding on this chain (ADR-0029) |
| `CHAIN_REJECTED` | The chain definitely refused or reverted it, or a request was invalid for this chain (wrong chain ID, bad signature, …) |
| `RPC_UNAVAILABLE` | The chain's RPC couldn't be reached or answered (timeout, rate limit, 5xx) |
| `SIGNER_UNREACHABLE` | The Signer couldn't be reached or returned an unusable signature |
| `CHAIN_NOT_ENABLED` | The request names a chain this deployment hasn't enabled (ADR-0019) |
| `NONCE_ALREADY_USED` | The transaction's nonce was already consumed on-chain (Base) |

One more code exists internally, `ALREADY_KNOWN` (the node already has these exact bytes). It is never reported: it means "sent", so the item stays `broadcasting` until it resolves.

## Not yet specced here

- Webhooks (ADR-0023) — polling above is the required baseline for now.
- Ethereum L1 — a separate, undesigned future chain, not "the rest of evm" (ADR-0035).
