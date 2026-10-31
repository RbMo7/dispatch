# Cancel a Dispatch

## `POST /v1/dispatch/:id/cancel`

Withdraws a Managed or Relay Dispatch that the engine has not claimed yet ([ADR-0056](../adr/0056-a-dispatch-can-be-cancelled-only-before-it-is-claimed.md)). Needs the `Authorization` header and takes no body.

The cancel and the worker's claim are decided in one atomic write, so exactly one of them wins. The worker claims a queued Dispatch within a few seconds when it is running and has capacity, so in practice you can cancel only what is still waiting: when the worker is stopped, busy, or does not serve the chain.

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID/cancel" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

### `200`: cancelled

The body is the Dispatch, as [`GET /v1/dispatch/:id`](./get-dispatch.md) returns it, now `cancelled` at the top level and on every item, with `transactionHash` and `error` both `null`. Nothing was or will be signed, proposed or sent.

```json
{
  "dispatchId": "1687516d-b40f-4216-9e9b-e1ee93fea806",
  "mode": "managed",
  "status": "cancelled",
  "items": [
    {
      "type": "payment",
      "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      "asset": "USDC",
      "decimals": 6,
      "amount": "12500000",
      "status": "cancelled",
      "transactionHash": null,
      "error": null
    }
  ]
}
```

Cancelling a Dispatch that is already cancelled also answers `200`, with its current state.

### `409`: too late

The worker already claimed it, whatever its items have done since:

```json
{
  "code": "ALREADY_CLAIMED",
  "message": "the engine has already claimed this Dispatch, so it can no longer be cancelled"
}
```

This is the structured shape of a refusal that has an error code, like a `400` with `CHAIN_NOT_ENABLED` or `CHAIN_REJECTED`. A refusal with no code, such as a `401` or a `404`, is `{ "error": "..." }`.

### `404`: no such Dispatch

```json
{ "error": "not found" }
```

## After a cancel

`cancelled` is final and stored, not derived. The timeline shows when it happened:

```json
"timeline": [
  { "kind": "created", "at": "2026-10-31T18:47:32.882Z" },
  { "kind": "cancelled", "at": "2026-10-31T18:47:32.964Z" }
]
```

Sending a cancelled Dispatch's `Idempotency-Key` again returns it, with `202` and `"status": "cancelled"`, and creates nothing new:

```json
{ "dispatchId": "1687516d-b40f-4216-9e9b-e1ee93fea806", "status": "cancelled" }
```

Send a new key to try again.

## What cannot be cancelled

- **A claimed Dispatch.** A signed transaction cannot be safely unsent.
- **A single item.** Cancel is for the whole Dispatch.
- **An open Proposal.** Rejecting it is the Approvers' decision, in Squads or Safe.
