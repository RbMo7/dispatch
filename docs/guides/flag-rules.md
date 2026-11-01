# Hold payments with Flag Rules

A Flag Rule is a condition the operator sets, such as "any USDC payment over 5,000". Every Managed Dispatch is checked against the enabled rules on its chain when it is submitted. A Dispatch that matches any of them is stored whole as `held`: nothing is signed, proposed or sent until someone with the operator token releases it, or anyone cancels it. A held Dispatch has no deadline.

Writing rules and releasing Dispatches take the [operator token](../authentication.md#the-operator-token). Reading rules takes either token. The examples use `$OPERATOR_TOKEN` for the operator token and `$DISPATCH_TOKEN` for the API token.

## 1. Choose a rule

A rule is a `name`, a `chain` (`base` or `solana`), `enabled` (optional, default `true`), a `kind`, and exactly that kind's parameters. Any other field is a `400`.

| `kind` | Parameters | Matches a Dispatch when |
| --- | --- | --- |
| `item_over` | `asset`, `limit` | one `payment` item of `asset` is over `limit` |
| `dispatch_total_over` | `asset`, `limit` | its `payment` items of `asset` add up to more than `limit` |
| `daily_volume_over` | `asset`, `limit` | the `payment` items of `asset` in Managed Dispatches accepted in the last 24 hours and not cancelled, held ones included, plus this one's, add up to more than `limit` |
| `first_time_recipient` | none | a `payment` item's recipient has never had a confirmed payment from this engine on this chain |
| `recipient_not_allowlisted` | `addresses` | a `payment` item's recipient is not in `addresses` |
| `call_target_not_allowlisted` | `addresses` | a `call` item's `to` (Base) or `programId` (Solana) is not in `addresses` |

`limit` is a decimal string in whole units of the asset, such as `"5000"` or `"0.5"`. That is unlike a payment item's `amount`, which is in the smallest unit. It must be more than zero and have no more decimal places than the asset. `asset` must be one the engine knows on that chain. Each of `addresses` must be valid on that chain. Base addresses are stored checksummed and compared without regard to case.

The check reads only the engine's own database, never a chain. Amounts are compared as integers in the asset's smallest unit.

## 2. Preview it

Before you switch a rule on, ask how many of the last 30 days' Managed Dispatches on its chain it would have held. Nothing is saved.

```sh
curl -s -X POST "$DISPATCH_URL/v1/flag-rules/preview" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chain":"base","kind":"recipient_not_allowlisted","addresses":["0x8ba1f109551bD432803012645Ac136ddd64DBA72"]}'
```

```json
{
  "from": "2026-10-02T02:20:11.402Z",
  "to": "2026-11-01T02:20:11.402Z",
  "scanned": 4,
  "capped": false,
  "wouldHold": 1,
  "examples": [
    { "dispatchId": "66d96716-22fe-4a3c-bc18-a08b1646fd40", "createdAt": "2026-11-01T02:12:55.480Z", "items": [1] }
  ]
}
```

`scanned` is how many Dispatches in the window were checked, and `wouldHold` how many the rule matches. `examples` lists up to 10 of them, newest first, with the positions of the items it matched. Each Dispatch is checked with the facts as they were when it was submitted. One preview reads at most 2,000 Dispatches. When there were more, `capped` is `true` and `wouldHold` is a lower bound.

## 3. Create it

```sh
curl -s -X POST "$DISPATCH_URL/v1/flag-rules" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Large USDC payment","chain":"base","kind":"item_over","asset":"USDC","limit":"5000","reason":"finance asked for a second look over 5k"}'
```

`201` returns the rule in version 1, with its `ruleId`. A `400` names the field at fault:

```json
{ "error": "limit: USDC has 6 decimal places, so \"1.0000001\" is too precise" }
```

## 4. Watch for held Dispatches

A Dispatch that matches is accepted with `"status": "held"`:

```json
{ "dispatchId": "3f8e2a61-9c4d-4b7e-8f12-6a5d0c9e4b27", "status": "held" }
```

List the ones still waiting:

```sh
curl -s "$DISPATCH_URL/v1/dispatches?status=held" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

[Get a Dispatch](../openapi.yaml#get-a-dispatch) shows every rule that matched, each with every item it matched, and the rule as that version said when it matched:

```json
"hold": {
  "matched": [
    {
      "rule": { "name": "Large USDC payment", "kind": "item_over", "asset": "USDC", "limit": "5000" },
      "ruleId": "b3c1e0d2-5f4a-4c8e-9a71-2d6f0e8b9c13",
      "ruleVersion": 1,
      "items": [0]
    }
  ],
  "heldAt": "2026-11-01T02:14:02.311Z"
}
```

A Dispatch keeps its `hold` block after it is released or cancelled.

## 5. Release or cancel it

Release takes the operator token and a `reason`:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch/3f8e2a61-9c4d-4b7e-8f12-6a5d0c9e4b27/release" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"checked with finance"}'
```

`200` returns the Dispatch, now `queued`. It runs from there as if it had never been held, and its `hold` block gains `releasedAt` and `reason`. A Dispatch that is not `held` answers `409` with `NOT_HELD`. To stop it instead, [cancel it](./cancel.md) with either token.

A release and a cancel of the same Dispatch are each one write conditional on its status, so exactly one of them takes it out of `held`, and a release never revives a cancelled Dispatch. Of two releases, one answers `200` and the other `409`.

## 6. Edit or delete a rule

`PUT /v1/flag-rules/{id}` takes the rule's whole new content and writes the next version. Rules are forward-only: an edit never changes an earlier version, so a held Dispatch always names the version it matched. `DELETE /v1/flag-rules/{id}` stops the rule matching and takes it off the list, but keeps its id and history. Editing a deleted rule is `409` with `RULE_DELETED`.

Editing or deleting a rule never re-checks or releases a Dispatch already held.

## What a rule never checks

- **A Relay Dispatch.** Its transaction is already signed by someone else.
- **A repeated `Idempotency-Key`.** It answers with the stored Dispatch, held or not, whatever the rules say now.

## The activity record

Every cancel that lands, every release, and every rule create, edit and delete is written to the activity record, with the token kind and the `reason`. Read it with [List operator actions](../openapi.yaml#list-operator-actions). Each action is also written to the engine's log as an `operator action` line.
