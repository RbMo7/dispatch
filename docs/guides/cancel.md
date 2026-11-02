# Cancel a Dispatch

You can withdraw a Managed or Relay Dispatch until the engine claims it, including one a [Flag Rule](./flag-rules.md) is holding. Nothing is then signed, proposed or sent, and every item reads `cancelled`. Once the worker claims it, the Dispatch is on its way and cannot be cancelled.

A running worker claims a queued Dispatch within a few seconds, so in practice you cancel what is still waiting: a Dispatch a Flag Rule holds, or one the worker has not reached because it is stopped, busy, or does not serve the chain. The cancel and the worker's claim are decided in one atomic write, so exactly one of them wins.

The example cancels a refund on Solana devnet that the engine holds, because it matched a Flag Rule that holds any SOL payment over 1 SOL.

## 1. Check that it can still be cancelled

This is the refund. It was accepted as `held`:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: refund-7731" \
  -H "Content-Type: application/json" \
  -d '{"chain":"solana","items":[{"type":"payment","recipient":"Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2","asset":"SOL","amount":"1250000000"}]}'
```

```json
{ "dispatchId": "eb0f5429-d5d7-4f26-be30-ad3302ed0b5a", "status": "held" }
```

Read it to see where it is:

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "eb0f5429-d5d7-4f26-be30-ad3302ed0b5a",
  "mode": "managed",
  "chain": "solana",
  "sender": { "name": "payouts", "address": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
  "createdAt": "2026-11-01T17:38:24.333Z",
  "status": "held",
  "items": [
    {
      "type": "payment",
      "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
      "asset": "SOL",
      "decimals": 9,
      "amount": "1250000000",
      "status": "held",
      "transactionHash": null,
      "error": null
    }
  ],
  "hold": {
    "matched": [
      {
        "rule": { "name": "Large SOL payout", "kind": "item_over", "asset": "SOL", "limit": "1" },
        "ruleId": "ee9f0372-4c87-43f6-a8a8-baea523fc8b1",
        "ruleVersion": 1,
        "items": [0]
      }
    ],
    "heldAt": "2026-11-01T17:38:24.333Z"
  }
}
```

Only a Dispatch whose top-level `status` is `queued` or `held` can be cancelled. You do not have to check first, because a cancel that comes too late is refused without harm, but it tells you what to expect.

## 2. Cancel it

Either token can cancel. The body is optional. A `reason` is kept with the cancel, on the Dispatch and in the activity record, which the operator reads with [List operator actions](../openapi.yaml#list-operator-actions).

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID/cancel" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"duplicate of refund 7730"}'
```

```json
{
  "dispatchId": "eb0f5429-d5d7-4f26-be30-ad3302ed0b5a",
  "mode": "managed",
  "chain": "solana",
  "sender": { "name": "payouts", "address": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
  "createdAt": "2026-11-01T17:38:24.333Z",
  "status": "cancelled",
  "items": [
    {
      "type": "payment",
      "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
      "asset": "SOL",
      "decimals": 9,
      "amount": "1250000000",
      "status": "cancelled",
      "transactionHash": null,
      "error": null
    }
  ],
  "hold": {
    "matched": [
      {
        "rule": { "name": "Large SOL payout", "kind": "item_over", "asset": "SOL", "limit": "1" },
        "ruleId": "ee9f0372-4c87-43f6-a8a8-baea523fc8b1",
        "ruleVersion": 1,
        "items": [0]
      }
    ],
    "heldAt": "2026-11-01T17:38:24.333Z"
  },
  "cancellation": {
    "at": "2026-11-01T17:38:24.375Z",
    "tokenKind": "auth",
    "reason": "duplicate of refund 7730"
  }
}
```

`200` returns the Dispatch, as [Get a Dispatch](../openapi.yaml#get-a-dispatch) does, now `cancelled` at the top level and on every item, with `transactionHash` and `error` both `null`. A held Dispatch keeps its `hold`, so you can still see which rule held it.

`cancellation` says who cancelled it, when, and why:

| Field | Means |
| --- | --- |
| `at` | When the cancel was stored. |
| `tokenKind` | `auth` for the API token, `operator` for the operator token. |
| `reason` | The `reason` sent with the cancel, or `null` without one. |

Every later read of the Dispatch carries `cancellation`. Cancelling a Dispatch that is already cancelled also answers `200`, with its current state, and records nothing new. A `reason` that is not a non-empty string is a `400`.

## 3. If it was too late

If the worker claimed it first, the answer is `409`, whatever its items have done since. This Dispatch was confirmed minutes earlier:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch/8142d0dd-6d8a-4828-b908-ae3b0cecf9ee/cancel" \
  -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "code": "ALREADY_CLAIMED",
  "message": "the engine has already claimed this Dispatch, so it can no longer be cancelled"
}
```

Nothing to do: the Dispatch is being sent, or was sent. Follow it with [Get a Dispatch](../openapi.yaml#get-a-dispatch). An id that does not exist gets `404 { "error": "not found" }`.

## After a cancel

`cancelled` is final and stored, not worked out from the items. With `include=timeline`, the timeline shows when it happened:

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID?include=timeline" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "eb0f5429-d5d7-4f26-be30-ad3302ed0b5a",
  "mode": "managed",
  "chain": "solana",
  "sender": { "name": "payouts", "address": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
  "createdAt": "2026-11-01T17:38:24.333Z",
  "status": "cancelled",
  "items": [
    {
      "type": "payment",
      "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
      "asset": "SOL",
      "decimals": 9,
      "amount": "1250000000",
      "status": "cancelled",
      "transactionHash": null,
      "error": null
    }
  ],
  "hold": {
    "matched": [
      {
        "rule": { "name": "Large SOL payout", "kind": "item_over", "asset": "SOL", "limit": "1" },
        "ruleId": "ee9f0372-4c87-43f6-a8a8-baea523fc8b1",
        "ruleVersion": 1,
        "items": [0]
      }
    ],
    "heldAt": "2026-11-01T17:38:24.333Z"
  },
  "cancellation": {
    "at": "2026-11-01T17:38:24.375Z",
    "tokenKind": "auth",
    "reason": "duplicate of refund 7730"
  },
  "timeline": [
    { "kind": "created", "at": "2026-11-01T17:38:24.333Z" },
    { "kind": "cancelled", "at": "2026-11-01T17:38:24.373Z" }
  ]
}
```

Sending a cancelled Dispatch's `Idempotency-Key` again returns it, with `202` and `"status": "cancelled"`, and creates nothing new:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: refund-7731" \
  -H "Content-Type: application/json" \
  -d '{"chain":"solana","items":[{"type":"payment","recipient":"Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2","asset":"SOL","amount":"1250000000"}]}'
```

```json
{ "dispatchId": "eb0f5429-d5d7-4f26-be30-ad3302ed0b5a", "status": "cancelled" }
```

To send it after all, use a new key.

## What cannot be cancelled

- **A claimed Dispatch.** A signed transaction cannot be safely unsent.
- **A single item.** Cancel is for the whole Dispatch.
- **An open Proposal.** Rejecting it is the Approvers' decision, in Squads or Safe.

## Cancel from the console

In the [web console](../self-hosting/console.md#cancel-a-dispatch), an unclaimed Dispatch's detail pane has a **Cancel Dispatch** button, and a held Dispatch has one on the **Held** page too. Both send the same request without a reason, so `cancellation.reason` reads `null`. Send the request yourself when you want the reason on record.
