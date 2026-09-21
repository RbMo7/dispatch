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
  "items": [
    { "type": "payment", "recipient": "<address>", "asset": "USDC", "amount": "10" },
    { "type": "call", "to": "<program or contract>", "data": "<hex/base64>", "value": "0" }
  ]
}
```

`items` mixes `payment` (ADR-0018's convenience shape) and `call` (the primitive) freely in one Dispatch. Resubmitting the same `Idempotency-Key` returns the original Dispatch's current state (202, same body shape as below) rather than creating a second one.

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

## Not yet specced here

- Webhooks (ADR-0023) — polling above is the required baseline for now.
- Relay Dispatch's own endpoint shape — see `.scratch/relay-dispatch/spec.md`.
- Retry Policy's actual request field (ADR-0003/0004 — off by default, configurable per request) — pin this alongside issue 02 once the Coordinator's timeout logic (scaffold issue 06) is being built, not before.
