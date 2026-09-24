# API

The wire format Managed Dispatch's issues (`core-engine-scaffold` 02, 06, 08) build against. This is a sketch to agree on the shape now — exact field names may still shift during implementation, but the structure (auth header, idempotency header, item shape, async response) shouldn't.

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

A `call` item's fields beyond `type` mirror the target chain's `Call` primitive exactly (CONTEXT.md, ADR-0018) — `{ programId, accounts, data }` for a `solana` Dispatch as shown above, `{ to, data, value }` for a `base` one. `items` mixes `payment` (ADR-0018's convenience shape) and `call` (the primitive) freely in one Dispatch. Resubmitting the same `Idempotency-Key` returns the original Dispatch's current state (202, same body shape as below) rather than creating a second one.

`retryPolicy` (ADR-0003/0004) is optional; omitting it falls back to the operator's configured global default (itself off unless the operator opts in) — a Dispatch never silently costs more than what was explicitly authorized for it. Once resolved (request value or the global default) it's fixed for that Dispatch's whole lifetime.

Response (`202 Accepted` — this is always async, never a synchronous chain result):
```json
{ "dispatchId": "<id>", "status": "queued" }
```

## `GET /v1/dispatch/:id`

```json
{
  "dispatchId": "<id>",
  "status": "queued | broadcasting | confirmed | failed | partial",
  "items": [
    { "status": "confirmed", "transactionHash": "<hash>", "error": null },
    { "status": "failed", "transactionHash": null, "error": { "code": "INSUFFICIENT_FUNDS", "message": "...", "chainDetail": { "asset": "USDC", "short": "40" } } }
  ]
}
```

`error` follows ADR-0010's structured shape exactly — never a bare string.

Per-item `status` is `queued | broadcasting | confirmed | failed | abandoned` — its own vocabulary, not the top-level one (it adds `abandoned`, ADR-0004's distinct terminal state, and never itself reports `partial`, which only describes the aggregate across items). `queued` means the Call hasn't reached a Transaction yet (`transactionHash` still `null`); the top-level `status` is derived from the aggregate of item statuses, never stored as its own terminal value — only `queued`/`broadcasting` are ever persisted directly (ADR-0009's outbox transition), so `confirmed`/`failed`/`partial` are computed at read time. An `abandoned` item counts as "not confirmed" for that aggregate, the same as `failed`.

Every `GET /v1/dispatch/:id` response, Managed or Relay alike, includes a top-level `mode: "managed" | "relay"` field (ADR-0031) — added here too, not just below, so a caller can tell which shape it's looking at from the body alone without having to remember which mode it submitted.

## Relay Dispatch (`mode: "relay"`)

`.scratch/relay-dispatch/spec.md` and ADR-0031 record the design; this pins the shipped wire shape.

`POST /v1/dispatch` gains an optional `mode: "managed" | "relay"` field, defaulting to `"managed"` when omitted — every existing Managed Dispatch request keeps working unchanged. A `mode: "relay"` body is `{ chain, signedTransaction }` — never `items`, never `retryPolicy` (there's no key for the engine to fee-bump with); sending either alongside `mode: "relay"` is a `400`, not a silently-ignored field. `signedTransaction` is a base64-encoded, already-signed transaction the caller produced entirely outside the engine — the same headers (`Authorization`, `Idempotency-Key`) apply, and the same create-once idempotency semantics (ADR-0021).

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

## Not yet specced here

- Webhooks (ADR-0023) — polling above is the required baseline for now.
- Base's own Relay Dispatch implementation — the wire format above is chain-agnostic, but only Solana implements it so far. (Ethereum L1 is a separate, undesigned future chain, not "the rest of evm" — ADR-0035.)
