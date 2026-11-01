# Cancel a Dispatch

You can withdraw a Managed or Relay Dispatch until the engine claims it. Nothing is then signed, proposed or sent, and every item reads `cancelled`. Once the worker claims it, the Dispatch is on its way and cannot be cancelled.

A running worker claims a queued Dispatch within a few seconds, so in practice you cancel what is still waiting: the worker is stopped, busy, or does not serve the chain. The cancel and the worker's claim are decided in one atomic write, so exactly one of them wins.

## 1. Check that it is still queued

```sh
export DISPATCH_ID=ecf5aff7-d3ce-4c72-92ed-06f910c7b5f2
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

Only a Dispatch whose top-level `status` is `queued` can be cancelled. You do not have to check first, because a cancel that comes too late is refused without harm, but it tells you what to expect.

## 2. Cancel it

The request takes no body:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID/cancel" \
  -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "ecf5aff7-d3ce-4c72-92ed-06f910c7b5f2",
  "mode": "managed",
  "chain": "base",
  "createdAt": "2026-11-01T02:13:21.921Z",
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

`200` returns the Dispatch, as [Get a Dispatch](../openapi.yaml#get-a-dispatch) does, now `cancelled` at the top level and on every item, with `transactionHash` and `error` both `null`. Cancelling a Dispatch that is already cancelled also answers `200`, with its current state.

## 3. If it was too late

If the worker claimed it first, the answer is `409`, whatever its items have done since:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch/1a2f3f9f-0e2e-461c-b12c-e31391f1d5b4/cancel" \
  -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "code": "ALREADY_CLAIMED",
  "message": "the engine has already claimed this Dispatch, so it can no longer be cancelled"
}
```

Nothing to do: the Dispatch is being sent. Follow it with [Get a Dispatch](../openapi.yaml#get-a-dispatch). An id that does not exist gets `404 { "error": "not found" }`.

## After a cancel

`cancelled` is final and stored, not worked out from the items. The timeline shows when it happened:

```json
"timeline": [
  { "kind": "created", "at": "2026-11-01T02:13:21.921Z" },
  { "kind": "cancelled", "at": "2026-11-01T02:13:27.669Z" }
]
```

Sending a cancelled Dispatch's `Idempotency-Key` again returns it, with `202` and `"status": "cancelled"`, and creates nothing new:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: refund-7731" \
  -H "Content-Type: application/json" \
  -d '{"chain":"base","items":[{"type":"payment","recipient":"0x8ba1f109551bD432803012645Ac136ddd64DBA72","asset":"USDC","amount":"12500000"}]}'
```

```json
{ "dispatchId": "ecf5aff7-d3ce-4c72-92ed-06f910c7b5f2", "status": "cancelled" }
```

To send it after all, use a new key.

## What cannot be cancelled

- **A claimed Dispatch.** A signed transaction cannot be safely unsent.
- **A single item.** Cancel is for the whole Dispatch.
- **An open Proposal.** Rejecting it is the Approvers' decision, in Squads or Safe.

In the [web console](../self-hosting/console.md#cancel-a-dispatch), an unclaimed Dispatch's detail pane has a **Cancel Dispatch** button that sends the same request.
